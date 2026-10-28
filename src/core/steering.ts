// src/core/steering.ts
// The steering decision core (design §Steering injection + served-endpoint
// visibility): whether a request may carry the catalog's steering block, the
// injection shape, and the served-endpoint membership verdict. Pure functions
// over the data the wiring hooks supply — no I/O, no OpenCode imports.
//
// Layering note: the guard module (src/opencode/guard.ts) owns the canonical
// alias-ref parse, but core modules never import from src/opencode (this
// repo's rule: only opencode → core). The identification below mirrors the
// guard's parseAliasRef exactly — variant-blind, exact-priority remainder —
// and both copies are pinned to the same vectors (tests/unit/guard.test.ts
// and the steeringFor cases here); a semantic change to one must be mirrored
// in the other.

import { gatewayEffort } from "./reasoning"
import type { ModelEntry, Priority } from "./types"

// A model reference as the hook event carries it (`event.model`), mirroring
// the guard's ModelRef (src/opencode/guard.ts) structurally — the wiring
// passes the event's ref straight through, and any `variant` key the event
// adds is ignored (spike fact 1: the alias ref's variant is not stable across
// binding styles — absent for root-default/frontmatter, "default" for
// `--model` — so identification must stay variant-blind).
export type ModelRef = { providerID: string; id: string }

// The resolved pick for one priority, mirroring the alias registry's
// AliasTarget (src/opencode/aliases.ts) structurally for the same layering
// reason: the wiring passes its plan's picks directly.
export type AliasTarget = { id: string | null; fromFallback: boolean }

// The steering block exactly as ModelEntry.steering projects it (Task 2):
// OpenRouter's provider routing sub-object. The raw upstream block's
// top-level `model` field is never part of it.
export type Steering = NonNullable<ModelEntry["steering"]>

const ALIAS_PREFIX = "model-compare/"

const PRIORITIES: readonly Priority[] = ["balanced", "price", "quality"]

// Alias identification over the event's model ref — the guard's parseAliasRef
// rule mirrored (see the layering note above): ONLY openrouter plus
// `model-compare/<p>` whose remainder is exactly a priority name; ids may
// carry more slashes in OpenRouter's vendor/model style, so anything after
// the priority disqualifies. Accepts undefined for runtime robustness (the
// caller's ref is runtime data).
function aliasPriority(ref: ModelRef | undefined): Priority | null {
  if (ref === undefined || ref.providerID !== "openrouter") return null
  if (!ref.id.startsWith(ALIAS_PREFIX)) return null
  const remainder = ref.id.slice(ALIAS_PREFIX.length)
  return PRIORITIES.includes(remainder as Priority) ? (remainder as Priority) : null
}

// The steering block to inject for a request, or null when the request must
// not be steered: a non-alias ref (including a DIRECTLY-PICKED model — even
// when its id equals the current pick's; matching on that equality would
// INVERT the rule, since an alias-bound ref is never equal to a concrete pick
// id while a directly-picked one is — and steer requests outside the aliases,
// the anti-goal), a pick that resolved to nothing, a body model that is not
// the pick's id, or a pick whose catalog entry carries no steering block.
//
// `bodyModel` is the request body's `model` field when the wiring has read it
// (the live body carries the pick id verbatim — spike fact 1); undefined
// skips that gate and lets the alias signal decide. The `models` map is keyed
// by bare catalog id — the pick ids' form.
export function steeringFor(
  eventModel: ModelRef,
  bodyModel: string | undefined,
  picks: Partial<Record<Priority, AliasTarget>>,
  models: Map<string, ModelEntry>,
): Steering | null {
  const p = aliasPriority(eventModel)
  if (p === null) return null
  const pick = picks[p]
  if (pick === undefined || pick.id === null) return null
  if (bodyModel !== undefined && bodyModel !== pick.id) return null
  return models.get(pick.id)?.steering ?? null
}

// The reasoning effort an alias request must pin, or null when it must not:
// the same alias/body/pick/model gates as steeringFor, plus the explicit
// variant rule. `#variant` is OpenCode's per-request selection (the event
// carries it on `model.variant`); "default" is the no-selection sentinel
// OpenCode stamps on `--model` refs (spike fact 1), so it does NOT count as an
// explicit variant. The catalog's `quality_effort` is the effort the score was
// measured at; the "reasoning" sentinel is a producer label and is never sent
// to the gateway.
export function reasoningEffortFor(
  eventModel: ModelRef,
  variant: string | undefined,
  bodyModel: string | undefined,
  picks: Partial<Record<Priority, AliasTarget>>,
  models: Map<string, ModelEntry>,
): string | null {
  const p = aliasPriority(eventModel)
  if (p === null) return null
  if (variant !== undefined && variant !== "default") return null
  const pick = picks[p]
  if (pick === undefined || pick.id === null) return null
  if (bodyModel !== undefined && bodyModel !== pick.id) return null
  return gatewayEffort(models.get(pick.id)?.qualityEffort)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

// The body with the steering block's provider sub-object injected under the
// `provider` key — or the input returned untouched when it already carries a
// `provider` key (the plugin never clobbers routing the user or a provider
// configured) or is not a JSON object. The injected routing object is built
// field-by-field, never spread from the steering block, so the raw block's
// top-level `model` field (or any unknown key) cannot reach the body; an
// absent `quantizations` stays absent (OpenRouter reads the key's presence).
//
// Contract the wiring relies on: the SAME reference comes back when nothing
// was injected, a NEW object when it was — reference inequality is the
// "re-create the Request" signal.
export function injectSteering(body: unknown, steering: Steering): unknown {
  if (!isPlainObject(body) || Object.hasOwn(body, "provider")) return body
  return {
    ...body,
    provider: {
      order: steering.order,
      ignore: steering.ignore,
      ...(steering.quantizations === undefined ? {} : { quantizations: steering.quantizations }),
      allow_fallbacks: steering.allow_fallbacks,
    },
  }
}

// The body with `reasoning: { effort }` added — or the input untouched when
// it already carries `reasoning` or the legacy `reasoning_effort` field (an
// explicit #variant, user config or another plugin wins; the plugin never
// clobbers a reasoning choice it did not make) or is not a JSON object.
// Reference inequality is the wiring's "re-create the Request" signal.
export function injectReasoning(body: unknown, effort: string): unknown {
  if (!isPlainObject(body)) return body
  if (Object.hasOwn(body, "reasoning") || Object.hasOwn(body, "reasoning_effort")) return body
  return { ...body, reasoning: { effort } }
}

// normalize_provider (vendor/model_compare.py): casefold the name and strip
// ALL non-alphanumeric characters — "Z.AI", "z-ai" and "z ai" all normalize
// to "zai". JS toLowerCase stands in for Python's casefold (provider display
// names are ASCII in practice; a non-ASCII residue the casefold would keep is
// stripped by the character class either way).
function normalizeProvider(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "")
}

// The provider part of a routing reference: the text before the first `/`
// (`novita/fp8`, `deepinfra/fp8/flex` → `novita`/`deepinfra`), or the whole
// string when it carries none — a served display name (`Novita`) is therefore
// its own provider part. Applied to BOTH sides symmetrically (spike fact 3:
// the served string is a display name, never the script's tagged-slug form).
function providerPart(ref: string): string {
  const slash = ref.indexOf("/")
  return slash === -1 ? ref : ref.slice(0, slash)
}

// The served-endpoint verdict for one response: compare the response's
// `provider` string against the steering `order` that was actually applied to
// the request. `endpoint` is the served string verbatim (the alt+e toast's
// text) — null only when there is nothing to record (no provider at all, or a
// name with no provider part). `downgrade` is true ONLY when a parseable
// provider matches no entry of a NON-EMPTY order; an absent or empty order
// (no steering data — offline, or a model without a steering block) records
// the endpoint with no verdict, because `!` may only assert a fallback
// "despite the steering" when a non-empty order was actually applied.
export function captureEndpoint(
  provider: string | null,
  order: string[] | null,
): { endpoint: string | null; downgrade: boolean } {
  if (provider === null) return { endpoint: null, downgrade: false }
  const served = normalizeProvider(providerPart(provider))
  if (served === "") return { endpoint: null, downgrade: false }
  const entries = order ?? []
  if (entries.length === 0) return { endpoint: provider, downgrade: false }
  const matched = entries.some((entry) => normalizeProvider(providerPart(entry)) === served)
  return { endpoint: provider, downgrade: !matched }
}

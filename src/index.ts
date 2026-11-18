// src/index.ts
// Plugin entrypoint (design §8–§10, §15 item 5): everything the earlier tasks
// built becomes a working OpenCode v2 plugin. setup parses options (§3:
// warn-and-default, never throws), seeds state from storage (§8's startup
// chain: pin → fallback → disabled) without ever blocking on fresh data,
// registers the alias transform — after seeding, so the registration-time
// application sees the seeded picks — then the guard hook, the steering
// injection hook and the two commands, kicks off the first refresh in the
// background, schedules the 30-minute refresh tick, and returns a cleanup
// that clears the timer.
//
// `wire` is the testable core — the same setup with injected seams (acquire,
// timer, clock). The default export hands OpenCode the real context; it is
// cast once at this boundary because the plugin keeps a structural, mockable
// view of the context (plain strings instead of OpenCode's branded ids).

import { Plugin } from "@opencode/plugin"
import { parseConfig } from "./config"
import { pinKey, type Pin } from "./core/pins"
import { effectiveWeights, rankModels } from "./core/rank"
import type { CapturePayload, Catalog, LastReply, ModelEntry, Priority, Sourced } from "./core/types"
import {
  captureEndpoint,
  injectReasoning,
  injectSteering,
  reasoningEffortFor,
  requestedEffortOf,
  steeringFor,
} from "./core/steering"
import { endpointInfoFor } from "./core/endpoint"
import {
  formatReport,
  humanizeAge,
  reportEntries,
  sanitizeCatalogText,
  steeringNote,
} from "./opencode/commands"
import { ModelCompare } from "./rpc"
import { planAlias, type AliasTarget } from "./opencode/aliases"
import { guardDecision, parseAliasRef, type ModelRef } from "./opencode/guard"
import { readNewestCachedDoc, readRecord, type Storage } from "./opencode/storage"
import { acquire, cacheIdentities } from "./sources"
import {
  REFRESH_MS,
  adoptPlan,
  createTick,
  runnableSet,
  warnDisabledAliases,
} from "./opencode/refresh"
import { PRIORITIES, planPicks } from "./opencode/resolution"
import {
  ALIAS_PROVIDER,
  aliasId,
  useBestDecision,
  useBestNotice,
} from "./opencode/usebest"

const PROVIDER_PREFIX = "openrouter/"

// Mirrors core/pins.ts' bareModelId (kept private there; the config value
// looks like "openrouter/<id>", catalog ids are bare). Strip exactly one
// leading prefix — a bare id may itself contain slashes, so nothing beyond
// the prefix is touched.
function bareModelId(configValue: string): string {
  return configValue.startsWith(PROVIDER_PREFIX)
    ? configValue.slice(PROVIDER_PREFIX.length)
    : configValue
}

// The request body's `model` field when it is a string, else undefined — the
// gate steeringFor checks against the pick's id (the live alias-bound body
// carries the pick id verbatim, spike fact 1). Any non-object body reads as
// undefined; injectSteering rejects those on its own.
function bodyModelOf(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null) return undefined
  const model = (body as Record<string, unknown>).model
  return typeof model === "string" ? model : undefined
}

// ---- response capture helpers ----------------------------------------------

// The bounded peek (global constraint: never buffer or consume a response
// stream to inspect it — only a bounded first-chunk peek through a
// pass-through transform, the rest forwarding byte-for-byte). At most this
// many BYTES of a response stream are decoded for inspection; everything past
// the bound is untouched. Sized so a first SSE data chunk (a comment line
// plus one data event in the spike's observations) always fits.
const PEEK_MAX_BYTES = 4096
const EFFORT_BODY_MAX_BYTES = 256 * 1024

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

// Bounded read-only JSON body parser for effort extraction (and Turn-1 Q2
// cannotSteer checks): skips bodyless, compressed, or declared-oversized
// requests without cloning, bounds chunked stream reads to `maxBytes`, and
// cancels the cloned reader in `finally` whenever stopped early so
// ReadableStream.tee() never buffers multi-megabyte multimodal bodies in RAM.
async function readBoundedJsonBody(request: unknown, maxBytes: number): Promise<unknown> {
  if (typeof request !== "object" || request === null) return undefined
  try {
    const req = request as Request
    if (req.body === null) return undefined
    if (req.headers?.has("content-encoding") === true) return undefined
    const rawLen = req.headers?.get("content-length") ?? null
    if (rawLen !== null) {
      const parsedLen = Number(rawLen)
      if (Number.isFinite(parsedLen) && parsedLen > maxBytes) return undefined
    }
    const clone = req.clone()
    if (clone.body === null) return undefined
    const reader = clone.body.getReader()
    const decoder = new TextDecoder()
    let total = 0
    let text = ""
    let reachedEnd = false
    try {
      while (true) {
        const chunk = await reader.read()
        if (chunk.done) {
          reachedEnd = true
          break
        }
        const bytes = chunk.value
        total += bytes.byteLength
        if (total > maxBytes) return undefined
        text += decoder.decode(bytes, { stream: true })
      }
      text += decoder.decode()
    } finally {
      if (!reachedEnd) {
        // Never `await` cancel() on a cloned Request stream: Request.clone()
        // tees the underlying ReadableStream, and WHATWG tee's cancelPromise
        // only settles once BOTH branches cancel — awaiting it inside
        // http.request deadlocks before downstream fetch can ever read
        // request.body. Fire-and-forget synchronously flips `canceled2 = true`
        // so the teed branch buffers nothing while fetch reads request.body.
        void reader.cancel().catch(() => {})
      }
    }
    return JSON.parse(text) as unknown
  } catch {
    return undefined
  }
}

// A response field that must be a non-empty, non-control-only string, else null
// (so empty/whitespace/control-only strings never mask `??` fallbacks).
function stringField(obj: Record<string, unknown>, key: string): string | null {
  const value = obj[key]
  if (typeof value !== "string") return null
  return sanitizeCatalogText(value) !== "" ? value : null
}

// Extracts the concrete served model across @opencode/ai@2.2.0's response wire
// shapes: OpenRouter / OpenAI Chat (`model`), OpenAI Responses SSE
// (`response.model`), Anthropic Messages SSE (`message.model`), and Google
// Gemini (`modelVersion`).
function extractModelField(parsed: Record<string, unknown>): string | null {
  return (
    stringField(parsed, "model") ??
    (isPlainObject(parsed.response) ? stringField(parsed.response, "model") : null) ??
    (isPlainObject(parsed.message) ? stringField(parsed.message, "model") : null) ??
    stringField(parsed, "modelVersion")
  )
}

// Extracts served `provider` and `model` from a response's first bytes, or null
// while the prefix is not yet conclusive:
//   - SSE (`sawData === true`): tracks `lastSeenModel` across every parseable
//     `data:` JSON object; concludes immediately when any `data:` object
//     carries a non-null `provider`, or with `{ provider: null, model:
//     lastSeenModel }` on `data: [DONE]` or when `final === true` (4 KB cap
//     reached or stream ended).
//   - Plain JSON (`sawData === false`): returns `{ provider, model }` once the
//     prefix parses to a complete JSON object.
function extractServedFields(
  prefix: string,
  final: boolean,
): { provider: string | null; model: string | null } | null {
  let sawData = false
  let lastSeenModel: string | null = null
  for (const line of prefix.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed.startsWith("data:")) continue
    sawData = true
    const payload = trimmed.slice("data:".length).trim()
    if (payload === "[DONE]") return { provider: null, model: lastSeenModel }
    try {
      const parsed = JSON.parse(payload) as unknown
      if (isPlainObject(parsed)) {
        const model = extractModelField(parsed)
        if (model !== null) lastSeenModel = model
        const provider = stringField(parsed, "provider")
        if (provider !== null) {
          return { provider, model: lastSeenModel }
        }
      }
    } catch {
      // A line split across a chunk boundary — keep peeking.
    }
  }
  if (sawData) {
    return final ? { provider: null, model: lastSeenModel } : null
  }
  try {
    const parsed = JSON.parse(prefix) as unknown
    if (isPlainObject(parsed)) {
      return {
        provider: stringField(parsed, "provider"),
        model: extractModelField(parsed),
      }
    }
  } catch {
    // Not (yet) JSON — keep peeking.
  }
  return null
}

// ---- the slice of the OpenCode v2 plugin context the plugin touches --------

type Registration = { dispose: () => Promise<void> }

// The rpc.register return: disposal plus the event emitter the command's
// execute publishes the report through.
type RpcRegistration = Registration & {
  events: { emit(name: string, data: unknown): Promise<void> }
}

// The editor slice the alias applier touches (§8): `get` returns the concrete
// model's immutable definition; `update` mutates (or creates) one model.
export type AliasEditor = {
  get(providerID: string, modelID: string): AliasConcrete | undefined
  update(providerID: string, modelID: string, update: (model: AliasModel) => void): void
}

type AliasConcrete = {
  capabilities: unknown
  limit: unknown
  cost: unknown
  variants: unknown
  time: unknown
  status: unknown
}

type AliasModel = AliasConcrete & {
  modelID?: string
  name: string
  enabled: boolean
}

export type CommandDefinition = {
  name: string
  description?: string
  execute: (input: { sessionID: string; prompt: { text: string } }) => Promise<void>
}

// The `http.request` / `http.response` event (§9): the guard keys on the
// requesting agent, not on event.model, which already shows the effective
// (fallback) reference. `response` is present only on http.response events
// (the real SDK carries both hook events' shapes; only the response's hook
// receives one) — and it must stay MUTABLE: the capture hook re-creates the
// Response around a pass-through stream and writes it back.
export type HttpEvent = {
  sessionID: string
  agent: string
  model: ModelRef
  kind: "primary" | "compaction" | "title" | "generate"
  request: unknown
  response?: Response
}

export type ModelListEntry = { id: string; providerID: string; enabled: boolean }

export type PluginCtx = {
  options: unknown
  app: { version: string }
  storage: Storage
  model: {
    transform(callback: (editor: AliasEditor) => void): Promise<Registration>
    // The real client returns a promise; a plain value is tolerated too.
    list():
      | Promise<{ location: unknown; data: ModelListEntry[] }>
      | { location: unknown; data: ModelListEntry[] }
    reload(): Promise<void>
  }
  provider: { reload(): Promise<void> }
  agent: {
    get(input: { agentID: string }): Promise<{ location: unknown; data: { model?: ModelRef } }>
    reload(): Promise<void>
  }
  session: {
    hook(
      name: "http.request" | "http.response",
      callback: (event: HttpEvent) => Promise<void> | void,
    ): Promise<Registration>
    switchModel(input: { sessionID: string; model: ModelRef }): Promise<void>
    // `resume: false` records the notice without scheduling a model turn.
    synthetic(input: { sessionID: string; text: string; resume?: boolean | null }): Promise<unknown>
  }
  command: {
    transform(
      callback: (editor: { add(definition: CommandDefinition): void }) => void,
    ): Promise<Registration>
  }
  rpc: {
    register(
      definition: { id: string },
      handlers: Record<string, (input: unknown) => Promise<unknown> | unknown>,
    ): Promise<RpcRegistration>
  }
}

export type WireDeps = {
  acquire?: typeof acquire
  setInterval?: (fn: () => void, ms: number) => () => void
  now?: () => number
  // Per-tick hard deadline (F-01); tests shrink it.
  deadlineMs?: number
  // State-observation seam (tests): hands the LIVE WireState object to the
  // caller once setup finishes wiring it — every later mutation (steering
  // records, endpoint captures) lands on the same object, so the holder sees
  // the updates in real time. Nothing in production passes it.
  onState?: (state: WireState) => void
}

// ---- captured state and small helpers --------------------------------------

// The picks and enabled flags a registry state is built from.
export type AliasPlan = {
  picks: Partial<Record<Priority, AliasTarget>>
  enabled: Partial<Record<Priority, boolean>>
}

// The mutable state the registrations capture (§8). Two views of the picks:
//   - `plan` is the DESIRED registry state: the alias transform reads it at
//     every replay, so a reload always serves the newest plan;
//   - `picks`/`enabled` are the APPLIED view — what the registry is known to
//     serve: the guard and the commands read it. The tick advances it only
//     after the reload chain succeeded, so a failed reload is never reported
//     to users as a change that happened (and is retried by the next tick).
// `registryDisabled[p]` records that the transform wanted alias p enabled but
// its concrete model was missing from the editor; the applied view then says
// disabled, whatever the plan wanted.
//
// `lastReplies[sessionID]` records the capture for that session's most recent
// successful (2xx) primary HTTP response across all providers: written
// synchronously as a placeholder when headers arrive and upgraded from the 4 KB
// pass-through peek only while `replySeq[sessionID]` still matches `seq` (so a
// slow older stream cannot clobber a newer reply).
//
// `applied` correlates each final `Request` object with the steering `order`
// actually injected into it (`null` whenever provider routing was not injected)
// and the resolved `requestedEffort`, eliminating concurrent per-session races.
//
// `cannotSteerToasted[sessionID]` records that the Q2 fallback's cannot-steer
// event was already successfully emitted for that session: when a steerable
// alias request (alias ref + a current pick) finds NO steering data — no
// catalog source, `sourced === null` — the injection hook emits the event
// exactly ONCE PER SESSION (never once per request), leaving the request body
// untouched.
export type WireState = {
  sourced: Sourced | null
  pins: Partial<Record<Priority, Pin>>
  picks: Partial<Record<Priority, AliasTarget>>
  enabled: Partial<Record<Priority, boolean>>
  plan: AliasPlan
  registryDisabled: Partial<Record<Priority, boolean>>
  lastReplies: Record<string, LastReply>
  replySeq: Record<string, number>
  applied: WeakMap<Request, { order: string[] | null; effort: string | null }>
  cannotSteerToasted: Record<string, boolean>
}

// readRecord only guarantees a v=1 object; the pin fields are checked so a
// garbage record warns and is ignored instead of poisoning resolution (§7.2).
// The id must be non-empty and `since` a FINITE number — JSON.parse("1e999")
// and hand-edited records can carry Infinity, which would make every
// pin-expiry comparison (now - since) NaN.
function isValidPin(value: Pin): boolean {
  return (
    typeof value.id === "string" &&
    value.id !== "" &&
    typeof value.since === "number" &&
    Number.isFinite(value.since)
  )
}

// ---- the alias transform (design §8) ---------------------------------------

// The applier: computes each alias's plan from the captured state and copies
// the concrete model's identity fields onto the alias. A missing pick or a
// pick whose model is gone from the editor DISABLES the alias with a warning —
// never silently skipped (§8). Deep-copies via structuredClone to avoid
// aliasing the concrete model's objects.
function applyAliases(state: WireState, editor: AliasEditor): void {
  for (const p of PRIORITIES) {
    const target: AliasTarget = state.plan.picks[p] ?? { id: null, fromFallback: false }
    // The editor's concrete definition doubles as the presence proof for the
    // plan: planAlias only checks for undefined (it never reads model
    // internals — the applier does, below).
    const source = target.id === null ? undefined : editor.get(ALIAS_PROVIDER, target.id)
    // The concrete editor model is the presence proof; the display name
    // carries only the pick (OpenCode renders the selected variant itself).
    const plan = planAlias(p, target, source as unknown as ModelEntry | undefined)

    if (plan.enabled && plan.modelID !== null && source !== undefined) {
      editor.update(ALIAS_PROVIDER, aliasId(p), (model) => {
        model.modelID = plan.modelID as string
        model.name = plan.name
        model.enabled = true
        model.capabilities = structuredClone(source.capabilities)
        model.limit = structuredClone(source.limit)
        model.cost = structuredClone(source.cost)
        model.variants = structuredClone(source.variants)
        model.time = structuredClone(source.time)
        model.status = source.status
      })
      state.registryDisabled[p] = false
    } else {
      // The plan wanted this alias enabled but the concrete model is gone:
      // the registry now disables it, so the guard and /use-best must agree.
      const wanted = target.id !== null
      state.registryDisabled[p] = wanted
      if (wanted) state.enabled[p] = false
      editor.update(ALIAS_PROVIDER, aliasId(p), (model) => {
        // modelID stays as-is; only the display name and the flag change.
        model.enabled = false
        model.name = plan.name
      })
      for (const warning of plan.warnings) console.warn("[model-compare]", warning)
    }
  }
}

// ---- setup -----------------------------------------------------------------

export async function wire(ctx: PluginCtx, deps: WireDeps = {}): Promise<() => void> {
  const doAcquire = deps.acquire ?? acquire
  const now = deps.now ?? Date.now

  // §3: every option violation warns and defaults; parseConfig never throws.
  const { config, warnings } = parseConfig(ctx.options)
  for (const warning of warnings) console.warn("[model-compare]", warning)

  const state: WireState = {
    sourced: null,
    pins: {},
    picks: {},
    enabled: {},
    plan: { picks: {}, enabled: {} },
    registryDisabled: {},
    // The per-session maps are keyed by ids that reach them from OUTSIDE (hook
    // events, RPC input): null-prototype objects so a key like
    // "constructor"/"toString"/"__proto__" can never resolve through — or
    // mutate — the prototype chain.
    lastReplies: Object.create(null) as Record<string, LastReply>,
    replySeq: Object.create(null) as Record<string, number>,
    applied: new WeakMap<Request, { order: string[] | null; effort: string | null }>(),
    cannotSteerToasted: Object.create(null) as Record<string, boolean>,
  }
  // Test seam: hand the live state object out BEFORE any registration can
  // mutate it — the reference never changes, only its contents do.
  deps.onState?.(state)

  // Seed state from storage (§8 startup) BEFORE registering the transform:
  // OpenCode applies transforms at registration time (design-spike-verified),
  // so the first application must already see the seeded picks. Registering
  // first would compute every alias from empty state, and a warm start whose
  // first tick resolves the same picks then never reloads — the registry's
  // aliases stay disabled while state.enabled says enabled. This needs only
  // storage + ctx.model.list(); acquire is NOT awaited here.
  //
  // The seed is the §9 chain WITHOUT a fresh catalog — the same resolution
  // the tick falls back to when a refresh fails (planPicks with doc: null):
  // stored pin if runnable → configured fallback if runnable → disabled.
  try {
    const cached = await readNewestCachedDoc(ctx.storage, cacheIdentities(config))
    if (cached !== null) {
      // Warm start: read the pins — keyed by the effective weights of the
      // cached document, since without fresh ranking the weights are
      // unknowable.
      state.sourced = cached
      for (const p of PRIORITIES) {
        const key = pinKey(p, effectiveWeights(cached.doc, p, config.weights[p]).weights)
        const record = await readRecord<Pin>(ctx.storage, key, 1)
        if (record !== null && !isValidPin(record)) {
          console.warn("[model-compare]", `corrupt pin record for ${p} (${key}); ignoring it`)
          continue
        }
        if (record !== null) state.pins[p] = record
      }
    }
    // The runnable set is only needed when something could use it.
    const needsRunnable = Object.keys(state.pins).length > 0 || config.fallback !== null
    const runnable = needsRunnable ? await runnableSet(ctx) : new Set<string>()
    const plan = planPicks({ config, doc: null, runnable, pins: state.pins, now: now() })
    adoptPlan(state, plan, true)
    for (const notice of plan.notices) console.warn("[model-compare]", notice)

    if (cached !== null) {
      warnDisabledAliases(state.enabled, "startup")
    } else {
      // Cold start: the pin keys hash the effective weights of a catalog we
      // don't have, so the chain starts at the configured fallback. It is
      // never stored as a pin (§7.8).
      const bare = config.fallback === null ? null : bareModelId(config.fallback)
      if (bare !== null && state.enabled.balanced === true) {
        console.warn(
          "[model-compare]",
          `no cached ranking; aliases start on the configured fallback ${bare}`,
        )
      } else if (bare !== null) {
        console.warn(
          "[model-compare]",
          `no cached ranking; startup fallback ${bare} is not runnable; aliases disabled until first refresh`,
        )
      } else {
        console.warn("[model-compare]", "no cached ranking; aliases disabled until first refresh")
      }
    }
  } catch (error) {
    // Storage problems degrade to the disabled state, never break setup (§9).
    console.error("[model-compare]", error)
  }

  // Register the model transform (§8): aliases are computed inside the
  // transform from the captured state, so any replay applies the current pick.
  await ctx.model.transform((editor) => applyAliases(state, editor))

  // The RPC registration (below, before the commands) is the event bridge
  // the steering hook emits the cannot-steer fallback through; the binding is
  // hoisted here so the hook's closure sees it declared. No request can
  // arrive before setup completes, and the emit site guards on the
  // registration being ready anyway (fail open).
  let rpcRegistration: RpcRegistration | undefined

  // The guard (§9): a primary request whose agent is configured with a
  // DISABLED alias aborts with the exact error; everything else passes. The
  // agent lookup is wrapped — a missing agent must not break the request path.
  await ctx.session.hook("http.request", async (event) => {
    let agentModel: ModelRef | undefined
    try {
      const agent = await ctx.agent.get({ agentID: event.agent })
      agentModel = agent.data?.model
    } catch {
      agentModel = undefined
    }
    const decision = guardDecision(event.kind, agentModel, (p) => state.enabled[p] === true)
    if (decision.error !== undefined) throw new Error(decision.error)
  })

  function recordApplied(
    req: unknown,
    entry: { order: string[] | null; effort: string | null },
  ): void {
    if (typeof req === "object" && req !== null) {
      state.applied.set(req as Request, entry)
    }
  }

  // Request steering, reasoning injection, and applied-effort recording:
  // alias-scoped requests whose pick's catalog entry carries steering/reasoning
  // get the corresponding fields injected and `event.request` re-created;
  // non-alias request bodies are never modified (primary bodies are read up to
  // 256 KiB solely to record the requested effort). Every path records
  // `{ order, effort }` on the final Request object in `state.applied`.
  await ctx.session.hook("http.request", async (event) => {
    try {
      const p = parseAliasRef(event.model)
      if (p === null) {
        const body =
          event.kind === "primary"
            ? await readBoundedJsonBody(event.request, EFFORT_BODY_MAX_BYTES)
            : undefined
        recordApplied(event.request, {
          order: null,
          effort: requestedEffortOf(body, event.model?.variant, null),
        })
        return
      }
      // The Q2 fallback: a steerable alias request with NO catalog source
      // (`sourced === null`) proceeds untouched and emits `cannotSteer` at most
      // once per session (unless `body.provider` is already set). Both the Q2
      // check and steady-state primary fallback turns share the bounded 256 KiB
      // reader without double-cloning.
      if (state.sourced === null) {
        let parsedBody: unknown = undefined
        let bodyReadAttempted = false
        const pick = state.picks[p]
        const registration = rpcRegistration
        if (
          registration !== undefined &&
          pick !== undefined &&
          pick.id !== null &&
          state.cannotSteerToasted[event.sessionID] !== true
        ) {
          bodyReadAttempted = true
          parsedBody = await readBoundedJsonBody(event.request, EFFORT_BODY_MAX_BYTES)
          const bodyHasProvider =
            isPlainObject(parsedBody) && Object.hasOwn(parsedBody, "provider")
          if (!bodyHasProvider) {
            void registration.events
              .emit("cannotSteer", { sessionID: event.sessionID })
              .then(() => {
                state.cannotSteerToasted[event.sessionID] = true
              })
              .catch(() => {
                // Leave the once-flag unset: a later request retries.
              })
          }
        }
        if (event.kind === "primary" && !bodyReadAttempted) {
          parsedBody = await readBoundedJsonBody(event.request, EFFORT_BODY_MAX_BYTES)
        }
        recordApplied(event.request, {
          order: null,
          effort: requestedEffortOf(parsedBody, event.model.variant, null),
        })
        return
      }
      const request = event.request as Request
      let body: unknown
      try {
        body = JSON.parse(await request.clone().text())
      } catch {
        recordApplied(event.request, {
          order: null,
          effort: requestedEffortOf(undefined, event.model.variant, null),
        })
        return
      }
      const byId = new Map(
        state.sourced.doc.models.map((entry): [string, ModelEntry] => [entry.id, entry]),
      )
      const bodyModel = bodyModelOf(body)
      const steering = steeringFor(event.model, bodyModel, state.picks, byId)
      let modified: unknown = body
      let providerApplied = false
      if (steering !== null) {
        const next = injectSteering(modified, steering)
        if (next !== modified) {
          modified = next
          providerApplied = true
        }
      }
      const catalogEffort = reasoningEffortFor(
        event.model,
        event.model.variant,
        bodyModel,
        state.picks,
        byId,
      )
      let reasoningApplied = false
      if (catalogEffort !== null) {
        const next = injectReasoning(modified, catalogEffort)
        if (next !== modified) {
          modified = next
          reasoningApplied = true
        }
      }
      const requestedEffort = requestedEffortOf(
        body,
        event.model.variant,
        reasoningApplied ? catalogEffort : null,
      )
      if (modified === body) {
        recordApplied(event.request, { order: null, effort: requestedEffort })
        return
      }
      const headers = new Headers(request.headers)
      headers.delete("content-length")
      headers.delete("content-encoding")
      event.request = new Request(request.url, {
        method: request.method,
        headers,
        body: JSON.stringify(modified),
        signal: request.signal,
      })
      recordApplied(event.request, {
        order: providerApplied ? steering!.order : null,
        effort: requestedEffort,
      })
    } catch {
      // Fail open: any error leaves the original request proceeding untouched.
      recordApplied(event.request, {
        order: null,
        effort: requestedEffortOf(undefined, event.model?.variant, null),
      })
    }
  })

  // Last-reply capture: every successful (2xx) primary HTTP response across all
  // providers writes a synchronous placeholder in `state.lastReplies` and wraps
  // `response.body` in a pass-through 4 KB peek (forwarding every chunk
  // byte-for-byte) to upgrade `servedModel`, `endpoint`, and `steering` when
  // `seq` still matches the session's newest reply.
  await ctx.session.hook("http.response", async (event) => {
    try {
      if (event.kind !== "primary") return
      const response = event.response
      if (response === undefined || response.ok !== true) return

      const seq = (state.replySeq[event.sessionID] ?? 0) + 1
      state.replySeq[event.sessionID] = seq
      const applied =
        typeof event.request === "object" && event.request !== null
          ? state.applied.get(event.request as Request)
          : undefined
      state.lastReplies[event.sessionID] = {
        sessionID: event.sessionID,
        providerID: event.model.providerID,
        requestedModel: event.model.id,
        at: now(),
        seq,
        servedModel: null,
        endpoint: null,
        steering: "unknown",
        requestedEffort:
          applied !== undefined
            ? applied.effort
            : requestedEffortOf(undefined, event.model.variant, null),
      }

      const body = response.body
      if (body === null) return

      const decoder = new TextDecoder()
      let captured = ""
      let peekedBytes = 0
      let done = false
      const upgrade = (provider: string | null, model: string | null) => {
        done = true
        const current = state.lastReplies[event.sessionID]
        if (current === undefined || current.seq !== seq) return
        const verdict = captureEndpoint(provider, applied?.order ?? null)
        state.lastReplies[event.sessionID] = {
          ...current,
          servedModel: model ?? current.servedModel,
          endpoint: verdict.endpoint,
          steering: verdict.steering,
        }
      }
      const inspect = (final: boolean) => {
        const peek = extractServedFields(captured, final)
        if (peek !== null) upgrade(peek.provider, peek.model)
      }
      const transform = new TransformStream<Uint8Array, Uint8Array>({
        transform: (chunk, controller) => {
          try {
            if (!done) {
              const take = Math.min(chunk.byteLength, PEEK_MAX_BYTES - peekedBytes)
              if (take > 0) captured += decoder.decode(chunk.subarray(0, take), { stream: true })
              peekedBytes += take
              const atBound = peekedBytes >= PEEK_MAX_BYTES
              if (atBound) captured += decoder.decode()
              inspect(atBound)
              if (atBound) done = true
            }
          } catch {
            done = true
          }
          controller.enqueue(chunk)
        },
        flush: () => {
          try {
            if (!done) {
              captured += decoder.decode()
              inspect(true)
            }
          } catch {
            done = true
          }
        },
      })
      event.response = new Response(body.pipeThrough(transform), {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      })
    } catch {
      // Fail open: any error leaves the response untouched.
    }
  })

  const findCatalogModel = (doc: Catalog, rawId: string): ModelEntry | undefined =>
    doc.models.find((entry) => entry.id === rawId) ??
    doc.models.find((entry) => entry.id === rawId.replace(/#.*$/, ""))

  const reportFooter = (sessionID: string | null) => {
    const record = sessionID === null ? undefined : state.lastReplies[sessionID]
    const capture: CapturePayload | null =
      record === undefined
        ? null
        : {
            provider: record.providerID,
            endpoint: record.endpoint,
            model: record.servedModel ?? record.requestedModel,
            steering: record.steering,
          }
    let endpointInfo: ReturnType<typeof endpointInfoFor> | null = null
    if (record !== undefined) {
      let model: ModelEntry | undefined
      if (record.providerID === "openrouter" && state.sourced !== null) {
        const doc = state.sourced.doc
        if (record.servedModel !== null) {
          model = findCatalogModel(doc, record.servedModel)
        }
        if (
          model === undefined &&
          parseAliasRef({ providerID: record.providerID, id: record.requestedModel }) === null
        ) {
          model = findCatalogModel(doc, record.requestedModel)
        }
      }
      const info = endpointInfoFor(model, record.endpoint, record.requestedEffort)
      if (info.quantization !== null || info.effort !== null) endpointInfo = info
    }
    const steeringNoteFor =
      state.sourced === null ? null : steeringNote(state.sourced.doc, state.picks, state.enabled)
    return { capture, steeringNote: steeringNoteFor, endpointInfo }
  }

  rpcRegistration = await ctx.rpc.register(ModelCompare, {
    report: async (rawInput: unknown) => {
      const input = rawInput as { sessionID?: string | null } | undefined
      const sessionID = input?.sessionID ?? null
      const ranks = reportRanks()
      // ONE derivation per call: `reportFooter` computes `steeringNote` (shared
      // with `showReportDialog`), `capture` (feeds transcript-only
      // `lastResponseLine` in `formatReport` / `report` RPC `text` plus `alt+e`),
      // and `endpointInfo` (powers the `alt+e` toast).
      const footer = reportFooter(sessionID)
      if (state.sourced === null || ranks === null) {
        return {
          text: "model-compare: no ranking data available yet",
          age: null,
          ...footer,
          entries: [],
        }
      }
      return {
        text: formatReport(state.sourced, ranks, {
          picks: state.picks,
          overrides: config.weights,
          enabled: state.enabled,
          capture: footer.capture,
        }),
        age: humanizeAge(Date.now() - state.sourced.acquiredAt),
        ...footer,
        entries: reportEntries(state.sourced, ranks, { picks: state.picks, overrides: config.weights }),
      }
    },
  })

  // The report behind /model-compare: the text (transcript + the RPC's
  // report method) and the structured entries (the RPC's report method and
  // event — the TUI renders them as a selectable dialog). One ranking, so
  // the text, the entries and the picks can never disagree. Ranks under the
  // same weights overrides the aliases resolve with, so the report agrees
  // with the picks.
  const reportRanks = () => {
    if (state.sourced === null) return null
    const doc = state.sourced.doc
    return {
      balanced: rankModels(doc, "balanced", config.weights.balanced).ids,
      price: rankModels(doc, "price", config.weights.price).ids,
      quality: rankModels(doc, "quality", config.weights.quality).ids,
    }
  }

  // The commands (§10).
  await ctx.command.transform((editor) => {
    editor.add({
      name: "use-best",
      description: "Switch this session to a model-compare priority (balanced, price or quality)",
      execute: async ({ sessionID, prompt }) => {
        const decision = useBestDecision({
          argument: prompt.text,
          defaultPriority: config.defaultPriority,
          enabled: (p) => state.enabled[p] === true,
        })
        if (!decision.ok) {
          // The TUI's immediate feedback: the synthetic notice below only
          // surfaces at the session's next turn, so the event carries the
          // same copy to the toast listener. Best-effort — the refusal is
          // already durable in the transcript.
          try {
            await rpcRegistration.events.emit("useBest", {
              sessionID,
              message: decision.message,
              ok: false,
            })
          } catch {
            // Emission failures must not fail the command.
          }
          await ctx.session.synthetic({ sessionID, text: decision.message, resume: false })
          return
        }
        const p = decision.priority
        await ctx.session.switchModel({
          sessionID,
          model: { providerID: ALIAS_PROVIDER, id: aliasId(p) },
        })
        const pickId = state.picks[p]?.id ?? null
        const message = useBestNotice(p, pickId)
        // The switch is done; the toast event goes first so the TUI does not
        // wait behind the synthetic's admission (the same ordering as the
        // report command). Best-effort, like the transcript notice.
        try {
          await rpcRegistration.events.emit("useBest", { sessionID, message, ok: true, priority: p })
        } catch {
          // Emission failures must not fail the command.
        }
        try {
          await ctx.session.synthetic({
            sessionID,
            text: message,
            resume: false,
          })
        } catch {
          // The switch already happened; the notice is best-effort.
        }
      },
    })
    editor.add({
      name: "model-compare",
      description: "Show the top 5 models per priority with scores and data age",
      execute: async ({ sessionID }) => {
        // Snapshot the catalog once, before anything awaits: the event
        // emission and the synthetic's admission leave gaps in which a
        // refresh can swap state.sourced, and the event's entries and the
        // transcript text must come from the SAME document.
        const sourced = state.sourced
        const ranks = reportRanks()
        // The EVENT goes first: the TUI's instant dialog must not wait behind
        // the synthetic's admission, which measures ~8 s in this build (the
        // transcript notice is the durable copy, not the fast path).
        if (sourced === null || ranks === null) {
          try {
            // Emit ONLY the event schema's fields: reportFooter also carries
            // endpointInfo (the alt+e toast's data), which the report event
            // schema does not declare (additionalProperties: false).
            const footer = reportFooter(sessionID)
            await rpcRegistration.events.emit("report", {
              sessionID,
              age: null,
              capture: footer.capture,
              steeringNote: footer.steeringNote,
              entries: [],
            })
          } catch {
            // Emission failures must not fail the command.
          }
          await ctx.session.synthetic({
            sessionID,
            text: "model-compare: no ranking data available yet",
            resume: false,
          })
          return
        }
        const footer = reportFooter(sessionID)
        const context = {
          picks: state.picks,
          overrides: config.weights,
          enabled: state.enabled,
          capture: footer.capture,
        }
        try {
          await rpcRegistration.events.emit("report", {
            sessionID,
            age: humanizeAge(Date.now() - sourced.acquiredAt),
            capture: footer.capture,
            steeringNote: footer.steeringNote,
            entries: reportEntries(sourced, ranks, context),
          })
        } catch {
          // Emission failures must not fail the command.
        }
        await ctx.session.synthetic({
          sessionID,
          text: formatReport(sourced, ranks, context),
          resume: false,
        })
      },
    })
  })

  // The refresh tick (§8, §9), scheduled every 30 minutes — and, per §8, the
  // FIRST refresh starts right here in the background: a cold start with
  // working network must not wait 30 minutes for its aliases. Not awaited;
  // the tick's non-overlap guard keeps the kick-off and the timer from
  // colliding, and its catch-all keeps failures from escaping setup.
  const tick = createTick(ctx, config, state, {
    acquire: doAcquire,
    now,
    deadlineMs: deps.deadlineMs,
  })
  const cancelTimer =
    deps.setInterval !== undefined
      ? deps.setInterval(tick, REFRESH_MS)
      : (() => {
          const handle = setInterval(tick, REFRESH_MS)
          return () => clearInterval(handle)
        })()
  void tick()

  // Registrations are cleaned up by OpenCode on unload; only the timer is ours.
  return () => {
    cancelTimer()
  }
}

export default Plugin.define({
  id: "model-compare",
  async setup(ctx) {
    return wire(ctx as unknown as PluginCtx, {})
  },
})

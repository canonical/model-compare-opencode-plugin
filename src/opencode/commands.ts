// src/opencode/commands.ts
// Command logic for /use-best and /model-compare (design §10): parsing the
// optional priority argument and rendering the ranking report. Pure module —
// no OpenCode imports, no I/O. The plugin wires the results into
// ctx.session.switchModel and the synthetic report message.
//
// The data age is the plugin's own acquisition time of the document (§5, §9),
// not upstream's `generated_at`.

import { effectiveWeights, overallScore } from "../core/rank"
import { formatDepthAlternative, isSelectableDepth } from "../core/reasoning"
import type { Catalog, EndpointCapture, ModelEntry, Priority, Sourced, Weights } from "../core/types"
import type { AliasTarget } from "./aliases"

const PRIORITIES: Priority[] = ["balanced", "price", "quality"]
const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const TOP_N = 5

// §10: /use-best's optional argument. Empty (after trimming) means the
// default priority; a priority name wins case-insensitively; anything else is
// refused with a message naming the valid priorities.
export function parseUseBest(
  text: string,
  defaultPriority: Priority,
): { ok: true; priority: Priority } | { ok: false; message: string } {
  const trimmed = text.trim()
  if (trimmed === "") return { ok: true, priority: defaultPriority }
  const match = PRIORITIES.find((p) => p === trimmed.toLowerCase())
  if (match !== undefined) return { ok: true, priority: match }
  return {
    ok: false,
    message: `model-compare: unknown priority "${trimmed}"; valid priorities: ${PRIORITIES.join(", ")}`,
  }
}

// Small humanizer for the report's data age (§10): days/hours/minutes only;
// anything under a minute (including clock skew) is "just now".
export function humanizeAge(ageMs: number): string {
  if (ageMs < MINUTE) return "just now"
  const days = Math.floor(ageMs / DAY)
  if (days >= 1) return `${days}d old`
  const hours = Math.floor(ageMs / HOUR)
  if (hours >= 1) {
    const minutes = Math.floor((ageMs % HOUR) / MINUTE)
    return minutes > 0 ? `${hours}h ${minutes}m old` : `${hours}h old`
  }
  return `${Math.floor(ageMs / MINUTE)}m old`
}

const MAX_TEXT = 120

// Catalog-sourced strings (model ids) end up in a message the model reads
// (the synthetic report), and `catalogURL` is user-pointable, so they are
// flattened to a single line first: control characters, newlines and the
// Unicode line/paragraph separators become spaces, whitespace runs collapse,
// and the length is capped (F-20). Real OpenRouter ids are unaffected.
export function sanitizeCatalogText(text: string): string {
  const flat = text
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
  return flat.length > MAX_TEXT ? `${flat.slice(0, MAX_TEXT - 1)}…` : flat
}

// What the report knows beyond the ranking: the pick each alias currently
// serves (a pin can differ from rank 1 — minLead hysteresis), which priorities
// rank under a weights override, the aliases' enabled flags (the steering
// note's "every enabled alias" scope), and the session's last-endpoint
// capture (the footer's last-response line — absent when nothing was
// captured for the session the report belongs to).
export type ReportContext = {
  picks?: Partial<Record<Priority, AliasTarget>>
  overrides?: Partial<Record<Priority, Partial<Weights>>>
  enabled?: Partial<Record<Priority, boolean>>
  capture?: { endpoint: string; model: string; downgrade: boolean } | null
}

// The report footer's steering note (design §Steering visibility): the union
// of the current picks' steering blocks' `quantizations` lists, resolved
// through the catalog's ModelEntry map, across the three ENABLED aliases.
// It renders only when EVERY enabled alias's current pick carries
// quantizations data (a pick missing from the catalog, or a steering block
// without the list, withholds the whole note — no claim on partial data);
// a disabled alias's pick is excluded from both the union and the check, and
// an empty quantizations list contributes nothing without withholding. No
// enabled aliases → no note. Steering shipped with the Q2 verdict PASS, so
// the note renders purely per this data rule. (That data-only rule holds
// because steering injection IS wired — Q2 PASS; in the hypothetical Q2 FAIL
// world the note's suppression would be a code change, not a data condition.)
export function steeringNote(
  doc: Catalog,
  picks: Partial<Record<Priority, AliasTarget>> = {},
  enabled: Partial<Record<Priority, boolean>> = {},
): string | null {
  const byId = new Map(doc.models.map((model) => [model.id, model]))
  const union: string[] = []
  for (const p of PRIORITIES) {
    if (enabled[p] !== true) continue
    const pick = picks[p]
    const steering =
      pick === undefined || pick.id === null ? undefined : byId.get(pick.id)?.steering
    const quants = steering?.quantizations
    if (quants === undefined) return null
    for (const quant of quants) if (!union.includes(quant)) union.push(quant)
  }
  return union.length === 0 ? null : `routing steered to ${union.join(", ")} endpoints (aliases only)`
}

// The report footer's last-response line (design §Steering visibility, the
// user's option C): `last response: <model> @ <endpoint>` — the captured
// response's concrete model id and the served endpoint verbatim. An empty
// model (a response whose provider carried no model id) omits the model part
// rather than rendering an empty `@` slot. No capture → null: the line is
// omitted entirely, never a placeholder.
export function lastResponseLine(
  capture: Pick<EndpointCapture, "endpoint" | "model" | "downgrade"> | null | undefined,
): string | null {
  if (capture === null || capture === undefined) return null
  const endpoint = sanitizeCatalogText(capture.endpoint)
  return capture.model === ""
    ? `last response: ${endpoint}`
    : `last response: ${sanitizeCatalogText(capture.model)} @ ${endpoint}`
}


// Whether a priority's weights override actually took effect, shared by the
// two report builders (formatReport, reportEntries) so the "(custom weights)"
// label and the recomputed scores can never disagree: the effective weights
// are returned only when the override was applied to the merged map (at least
// one key landed) and the merge was NOT the zero-sum fallback to the
// published/default weights — in every other case the override changed
// nothing, so the published scores are shown under the plain header.
function overrideInEffect(
  doc: Catalog,
  p: Priority,
  override: Partial<Weights> | undefined,
): Weights | null {
  if (override === undefined) return null
  const eff = effectiveWeights(doc, p, override)
  return eff.applied && !eff.zeroSum ? eff.weights : null
}

// Catalog v6 display suffixes: the effort the quality score was measured at
// (` · high`) and the best measured selectable alternative (` · alt max 56.0`).
// For the v6 default-effort publications both plugin sources produce, the
// quality already sits at the best selectable depth, so the alternative suffix
// never renders from them — it is live only for an explicit-effort v6 document
// served by a user-pointed catalogURL. Both are catalog-derived, so they are
// flattened before joining the report text / dialog (F-20). An absent
// effort/alternative adds nothing.
function effortLabel(model: ModelEntry | undefined): string {
  const effort = model?.qualityEffort
  return effort == null ? "" : sanitizeCatalogText(effort)
}

function alternativeLabel(model: ModelEntry | undefined): string {
  const alternative = formatDepthAlternative(model)
  return alternative === "" ? "" : sanitizeCatalogText(alternative)
}

// The effort the structured report's entry may advertise as a pickable
// variant: the scored effort ONLY when the model's own reasoning block lets
// a pick bind it. The vendor's tier-4 "none" (a non-reasoning model scored
// from the OR trio) and any scored effort the block does not expose are
// display-only — a pick could not select them — so the entry advertises the
// bare model instead. The /model-compare TEXT report keeps its provenance
// suffix regardless (effortLabel is untouched); the TUI re-checks the string
// at its own trust boundary (gatewayEffort). The gate reads the raw effort
// and emits the sanitized label, so the emitted value is always an exact
// gateway effort.
function advertisedEffort(model: ModelEntry | undefined): string {
  if (model === undefined) return ""
  const effort = model.qualityEffort
  if (effort === null || effort === undefined || !isSelectableDepth(model, effort)) return ""
  return effortLabel(model)
}

function reasoningSuffix(model: ModelEntry | undefined): string {
  const label = effortLabel(model)
  return label === "" ? "" : ` · ${label}`
}

function alternativeSuffix(model: ModelEntry | undefined): string {
  const label = alternativeLabel(model)
  return label === "" ? "" : ` · alt ${label}`
}

// §10: /model-compare's report. `ranks` arrives already ranked, top-first
// (under the same overrides, see ReportContext), and only the top 5 per
// priority are rendered; a ranked id absent from the catalog still takes its
// line, with "-" instead of a score. An empty models list means no ranking
// data at all. With an override that actually took effect (overrideInEffect),
// the section is labelled "(custom weights)" and the shown score is the
// recomputed one: the published `overall` belongs to upstream's weights, not
// the user's. An override that applied nothing shows the plain header and the
// published scores.
export function formatReport(
  sourced: Sourced,
  ranks: Record<Priority, string[]>,
  context: ReportContext = {},
): string {
  if (sourced.doc.models.length === 0) {
    return "**model-compare** — no ranking data available"
  }
  const byId = new Map<string, ModelEntry>()
  for (const model of sourced.doc.models) byId.set(model.id, model)
  const lines = [
    `**model-compare** — top 5 per priority (data age: ${humanizeAge(Date.now() - sourced.acquiredAt)})`,
  ]
  for (const p of PRIORITIES) {
    const weights = overrideInEffect(sourced.doc, p, context.overrides?.[p])
    const custom = weights !== null
    const pick = context.picks?.[p]
    lines.push(custom ? `### ${p} (custom weights)` : `### ${p}`)
    const top = ranks[p].slice(0, TOP_N)
    for (const [index, id] of top.entries()) {
      const model = byId.get(id)
      const value =
        model === undefined ? null : weights ? overallScore(model, weights) : model.scores.overall[p]
      const score = value === null ? "-" : value.toFixed(3)
      const marker = pick?.id === id ? " ← current pick" : ""
      lines.push(
        `${index + 1}. ${sanitizeCatalogText(id)} (${score})${reasoningSuffix(model)}${alternativeSuffix(model)}${marker}`,
      )
    }
    // A pick that is not visible in the list above needs its own line.
    if (pick !== undefined && (pick.id === null || !top.includes(pick.id))) {
      const pickModel = pick.id === null ? undefined : byId.get(pick.id)
      if (pick.id === null) {
        lines.push("Current pick: none (alias disabled)")
      } else if (pick.fromFallback) {
        lines.push(
          `Current pick: ${sanitizeCatalogText(pick.id)} (fallback)${reasoningSuffix(pickModel)}${alternativeSuffix(pickModel)}`,
        )
      } else {
        const rank = ranks[p].indexOf(pick.id)
        lines.push(
          `Current pick: ${sanitizeCatalogText(pick.id)} (${rank === -1 ? "not in the ranking" : `rank ${rank + 1}`})${reasoningSuffix(pickModel)}${alternativeSuffix(pickModel)}`,
        )
      }
    }
  }
  // The footer (design §Steering visibility): the steering note ABOVE the
  // last-response line, both omitted when their data is absent. The
  // transcript's text report and the TUI dialog's footer agree — one
  // derivation, two surfaces.
  const note = steeringNote(sourced.doc, context.picks, context.enabled)
  if (note !== null) lines.push(note)
  const lastResponse = lastResponseLine(context.capture)
  if (lastResponse !== null) lines.push(lastResponse)
  return lines.join("\n")
}

// The report as structured entries: the same ranking, scoring and pick-marker
// rules as formatReport, in a shape a client can render interactively (the
// TUI's selectable report dialog — one entry per listed model, selecting it
// switches straight to that model). The pick formatReport renders as its
// extra "Current pick:" line gets its own entry here: `rank` is that pick's
// 1-based position in the full ranking (formatReport's "rank N"), or null
// only when the pick is absent from ranks[p] (formatReport's "not in the
// ranking"); its `score` stays "-" because formatReport's Current pick line
// shows the rank, not a score. `score` otherwise keeps formatReport's "-" for
// an id missing from the catalog; `fromFallback` marks a pick the fallback is
// serving. F-20 id split: `id` is the DISPLAY id (sanitized like
// formatReport's lines) while `value` is the RAW catalog id — the one
// switchToModel needs — so a dialog row shows `id` but picks `value`.
// `quality` is upstream's quality index (one decimal, "-" when absent) and
// `price` the effective-tier input/output per 1M pair ("Free" for a 0/0
// model, "-" when either half is unknown).
export type ReportEntry = {
  priority: Priority
  rank: number | null
  id: string
  value: string
  score: string
  quality: string
  // The effort behind `quality` ("" when unknown) and the best selectable
  // measured alternative as "<effort> <index>" ("" when there is none).
  effort: string
  alternative: string
  price: string
  current: boolean
  fromFallback: boolean
}

// Quality index → one decimal ("37.9", "56.0"); absent → "-".
function fmtQuality(model: ModelEntry | undefined): string {
  if (model === undefined || model.quality === null) return "-"
  return model.quality.toFixed(1)
}

// Effective-tier input/output per 1M: both explicitly zero → "Free" (the
// Switch-model dialog's convention); either half unknown → "-" (a half pair
// is never invented from `?? 0`); else "0.14/0.28".
function fmtPrice(model: ModelEntry | undefined): string {
  if (model === undefined) return "-"
  const input = model.pricing.input_per_1m
  const output = model.pricing.output_per_1m
  if (input === undefined || output === undefined) return "-"
  if (input === 0 && output === 0) return "Free"
  return `${input.toFixed(2)}/${output.toFixed(2)}`
}

export function reportEntries(
  sourced: Sourced,
  ranks: Record<Priority, string[]>,
  context: ReportContext = {},
): ReportEntry[] {
  // The same empty-catalog guard as formatReport: the RPC's text and its
  // entries must agree on "no ranking data", so no models means no entries —
  // the client renders its own no-data notice beside the text's no-data line.
  if (sourced.doc.models.length === 0) return []
  const byId = new Map<string, ModelEntry>()
  for (const model of sourced.doc.models) byId.set(model.id, model)
  const entries: ReportEntry[] = []
  for (const p of PRIORITIES) {
    const weights = overrideInEffect(sourced.doc, p, context.overrides?.[p])
    const pick = context.picks?.[p]
    const top = ranks[p].slice(0, TOP_N)
    for (const [index, id] of top.entries()) {
      const model = byId.get(id)
      const scoreValue =
        model === undefined ? null : weights ? overallScore(model, weights) : model.scores.overall[p]
      const current = pick?.id === id
      entries.push({
        priority: p,
        rank: index + 1,
        // F-20: `id` is the sanitized DISPLAY id (dialog rows, toasts);
        // `value` keeps the raw catalog id so switchToModel still receives
        // the real model id.
        id: sanitizeCatalogText(id),
        value: id,
        score: scoreValue === null ? "-" : scoreValue.toFixed(3),
        quality: fmtQuality(model),
        effort: advertisedEffort(model),
        alternative: alternativeLabel(model),
        price: fmtPrice(model),
        current,
        // A top-5 row that IS the current pick carries the pick's fallback
        // marker like the outside-top-5 entry below (formatReport's
        // "(fallback)" suffix on its Current pick line).
        fromFallback: current && pick?.fromFallback === true,
      })
    }
    // The pick outside the top 5 gets its own entry, with its rank from the
    // full ranking exactly like formatReport's extra "Current pick:" line
    // (rank N when the pick is ranked at all, null = "not in the ranking");
    // its score is "-" there — formatReport shows the rank, not a score. A
    // disabled alias's "none" pick has nothing to select, so it is skipped.
    if (pick !== undefined && pick.id !== null && !top.includes(pick.id)) {
      const model = byId.get(pick.id)
      const rank = ranks[p].indexOf(pick.id)
      entries.push({
        priority: p,
        rank: rank === -1 ? null : rank + 1,
        id: sanitizeCatalogText(pick.id),
        value: pick.id,
        score: "-",
        quality: fmtQuality(model),
        effort: advertisedEffort(model),
        alternative: alternativeLabel(model),
        price: fmtPrice(model),
        current: true,
        fromFallback: pick.fromFallback,
      })
    }
  }
  return entries
}

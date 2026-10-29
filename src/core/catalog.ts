// src/core/catalog.ts
// Catalog document validation (design §5). Accepts schema v6 documents (only) from
// either source (vendored script or remote catalog) and projects them onto
// the plugin's Catalog type. Validation only — ranking lives elsewhere.

import type {
  Catalog,
  ModelEntry,
  Priority,
  Reasoning,
  ReasoningDepth,
  Weights,
} from "./types"

const PRIORITIES: readonly Priority[] = ["balanced", "price", "quality"]
const SCORE_KEYS = ["quality", "price", "context", "age"] as const

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isNonEmptyStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.every((id) => typeof id === "string")
}

// The steering block (F-11/F-12): the raw upstream entry carries
// { model, provider: { order, ignore, quantizations?, allow_fallbacks } }.
// The projection unwraps `provider` as ModelEntry.steering and never projects
// the top-level `model`. Per-field absence (the pricing-split posture), no
// throw, no partial field: order/ignore must be non-empty string arrays (an
// empty list would filter out every endpoint) and allow_fallbacks a boolean —
// any miss drops the whole block; quantizations is optional and kept only as
// a non-empty string array, otherwise that field alone is dropped and the
// block survives.
function steer(raw: unknown): ModelEntry["steering"] {
  if (!isObject(raw)) return undefined
  const provider = raw.provider
  if (!isObject(provider)) return undefined
  const order = provider.order
  const ignore = provider.ignore
  const fallbacks = provider.allow_fallbacks
  if (!isNonEmptyStringList(order) || !isNonEmptyStringList(ignore) || typeof fallbacks !== "boolean") {
    return undefined
  }
  const steering: NonNullable<ModelEntry["steering"]> = {
    order: [...order],
    ignore: [...ignore],
    allow_fallbacks: fallbacks,
  }
  if (isNonEmptyStringList(provider.quantizations)) steering.quantizations = [...provider.quantizations]
  return steering
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null
}

function boolOrNull(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null
}

// The v6 reasoning block (display + request injection). Field-by-field
// projection, never a spread of the raw object: a hostile catalogURL serves
// arbitrary JSON here, and only the fields the plugin reads survive. A
// non-object block reads as absent; a malformed field reads as its neutral
// value (empty list / null) rather than rejecting the whole catalog — the
// block is advisory metadata, not ranking input. Depth records without a
// non-empty string effort are dropped; every other depth field is nullable.
function projectReasoning(raw: unknown): Reasoning | undefined {
  if (!isObject(raw)) return undefined
  const supported =
    Array.isArray(raw.supported_efforts) && raw.supported_efforts.every((effort) => typeof effort === "string")
      ? [...(raw.supported_efforts as string[])]
      : []
  const depths: ReasoningDepth[] = []
  if (Array.isArray(raw.depths)) {
    for (const record of raw.depths) {
      if (!isObject(record)) continue
      if (typeof record.effort !== "string" || record.effort === "") continue
      depths.push({
        effort: record.effort,
        index: finiteOrNull(record.index),
        cost_per_task_usd: finiteOrNull(record.cost_per_task_usd),
        source: stringOrNull(record.source),
        as_of: stringOrNull(record.as_of),
      })
    }
  }
  return {
    default_effort: stringOrNull(raw.default_effort),
    supported_efforts: supported,
    default_enabled: boolOrNull(raw.default_enabled),
    mandatory: boolOrNull(raw.mandatory),
    supports_max_tokens: boolOrNull(raw.supports_max_tokens),
    depths,
  }
}

export function validateCatalog(
  raw: unknown,
): { ok: true; catalog: Catalog } | { ok: false; reason: string } {
  if (!isObject(raw)) return { ok: false, reason: "catalog must be a JSON object" }

  // Supported schema: v6 only — upstream's current contract (0.7.0's
  // schema_version 6). v6 keeps v5's per-model `quality_effort` and
  // `reasoning` fields but changes what `quality` means: the AA index at the
  // model's best measured selectable reasoning effort (the highest AA index at
  // an effort OpenRouter supports, ties to the deeper effort), which may
  // differ from `reasoning.default_effort`. Every other version is rejected
  // with the reason string the canary and the stored-document path rely on.
  if (raw.schema_version !== 6) {
    return { ok: false, reason: `schema_version must be 6, got ${JSON.stringify(raw.schema_version)}` }
  }
  if (typeof raw.generated_at !== "string") {
    return { ok: false, reason: "generated_at must be a string" }
  }

  // parameters.weights: optional; kept as published (possibly partial, keys
  // absent upstream stay absent), except that every value must survive a
  // sanity check: only the four WEIGHT_KEYS with a finite, non-negative
  // number are kept (a string, NaN/±Infinity or negative weight is dropped
  // like an unknown key — a hostile catalogURL serves arbitrary JSON here).
  // An all-dropped map behaves as absent: with every priority map dropped,
  // weights stays {} and consumers fall back to DEFAULT_WEIGHTS (design §5);
  // when at least one map survives, a dropped priority reads as a missing
  // one — weight 0 per the documented no-data semantics.
  const weights: Partial<Record<Priority, Partial<Weights>>> = {}
  const weightsRaw = isObject(raw.parameters) ? raw.parameters.weights : undefined
  if (weightsRaw !== undefined) {
    if (!isObject(weightsRaw)) return { ok: false, reason: "parameters.weights must be an object" }
    for (const priority of PRIORITIES) {
      const entry = weightsRaw[priority]
      if (entry === undefined) continue
      if (!isObject(entry)) {
        return { ok: false, reason: `parameters.weights.${priority} must be an object` }
      }
      // The weight keys are the same four names as the score components.
      const filtered: Partial<Weights> = {}
      for (const key of SCORE_KEYS) {
        const value = entry[key]
        if (typeof value === "number" && Number.isFinite(value) && value >= 0) filtered[key] = value
      }
      if (Object.keys(filtered).length === 0) continue
      weights[priority] = filtered
    }
  }

  // models: required. Each entry needs an id and full scores (components and
  // overall), plus the fields the ModelEntry type promises: a string name, an
  // object pricing with a numeric blended_per_1m (the price tie-break reads
  // it), and a numeric context — matching upstream, where models without
  // parseable pricing land in filtered, never in models (design §5). Every
  // numeric must be a FINITE number: JSON.parse("1e999") and hand-edited
  // storage records can carry Infinity/NaN, and either poisons the ranking
  // comparators (Infinity - Infinity is NaN) — a non-finite value rejects the
  // document in the same reason style as a non-number. The optional pricing
  // split (input_per_1m/output_per_1m) survives only as finite numbers — the
  // values fmtPrice reads — while every other listed field is optional and
  // passes through as published.
  if (!Array.isArray(raw.models)) return { ok: false, reason: "models must be an array" }
  const models: ModelEntry[] = []
  for (let i = 0; i < raw.models.length; i++) {
    const entry = raw.models[i]
    if (!isObject(entry)) return { ok: false, reason: `models[${i}] must be an object` }
    if (typeof entry.id !== "string") return { ok: false, reason: `models[${i}].id must be a string` }
    if (!isObject(entry.scores)) return { ok: false, reason: `models[${i}].scores must be an object` }

    const components = {} as Record<(typeof SCORE_KEYS)[number], number>
    for (const key of SCORE_KEYS) {
      const value = entry.scores[key]
      if (typeof value !== "number" || !Number.isFinite(value)) {
        return { ok: false, reason: `models[${i}].scores.${key} must be a number` }
      }
      components[key] = value
    }
    if (!isObject(entry.scores.overall)) {
      return { ok: false, reason: `models[${i}].scores.overall must be an object` }
    }
    const overall = {} as Record<Priority, number>
    for (const priority of PRIORITIES) {
      const value = entry.scores.overall[priority]
      if (typeof value !== "number" || !Number.isFinite(value)) {
        return { ok: false, reason: `models[${i}].scores.overall.${priority} must be a number` }
      }
      overall[priority] = value
    }

    if (typeof entry.name !== "string") {
      return { ok: false, reason: `models[${i}].name must be a string` }
    }
    const pricing = entry.pricing
    if (!isObject(pricing)) {
      return { ok: false, reason: `models[${i}].pricing must be an object` }
    }
    const blended = pricing.blended_per_1m
    if (typeof blended !== "number" || !Number.isFinite(blended)) {
      return { ok: false, reason: `models[${i}].pricing.blended_per_1m must be a number` }
    }
    if (typeof entry.context !== "number" || !Number.isFinite(entry.context)) {
      return { ok: false, reason: `models[${i}].context must be a number` }
    }

    // quality is optional (number | null): a non-number is coerced to null as
    // before, but a NUMBER must be finite — NaN/Infinity would poison the
    // quality tie-break in byRankingKey.
    if (typeof entry.quality === "number" && !Number.isFinite(entry.quality)) {
      return { ok: false, reason: `models[${i}].quality must be a finite number` }
    }
    const quality = typeof entry.quality === "number" ? entry.quality : null
    // The optional pricing split: kept only when finite numbers. A hostile
    // catalogURL can serve any JSON here and fmtPrice reads these as numbers
    // — a non-numeric or non-finite value is dropped to undefined (absent
    // stays absent, present-but-invalid behaves as absent).
    const input = pricing.input_per_1m
    const output = pricing.output_per_1m
    // The steering block projects (or reads as absent) per the steer() rules.
    // The v6 quality_effort/reasoning fields project the same way: strip the
    // raw keys before the spread so the camelCase projection is the only
    // representation on the entry (a hostile block never survives verbatim).
    const { steering: _rawSteering, quality_effort: _rawQualityEffort, reasoning: _rawReasoning, ...passthrough } =
      entry
    const steering = steer(entry.steering)
    const qualityEffort =
      typeof entry.quality_effort === "string" && entry.quality_effort !== "" ? entry.quality_effort : null
    const reasoning = projectReasoning(entry.reasoning)
    models.push({
      ...passthrough,
      id: entry.id,
      name: entry.name,
      pricing: {
        ...pricing,
        blended_per_1m: blended,
        input_per_1m: typeof input === "number" && Number.isFinite(input) ? input : undefined,
        output_per_1m: typeof output === "number" && Number.isFinite(output) ? output : undefined,
      },
      context: entry.context,
      scores: { ...components, overall },
      quality,
      qualityEffort,
      reasoning,
      steering,
    })
  }

  // rankings: optional; when present, each known priority must map to an
  // ordered list of model ids. Unknown priority keys are ignored.
  const rankings: Partial<Record<Priority, string[]>> = {}
  if (raw.rankings !== undefined) {
    if (!isObject(raw.rankings)) return { ok: false, reason: "rankings must be an object" }
    for (const priority of PRIORITIES) {
      const list = raw.rankings[priority]
      if (list === undefined) continue
      if (!Array.isArray(list) || !list.every((id) => typeof id === "string")) {
        return { ok: false, reason: `rankings.${priority} must be an array of strings` }
      }
      rankings[priority] = [...(list as string[])]
    }
  }

  return {
    ok: true,
    catalog: {
      generatedAt: raw.generated_at,
      weights,
      rankings,
      models,
    },
  }
}

// Re-validates a catalog read back from plugin storage (the projected
// `Catalog`, not the raw upstream document) by rebuilding the raw shape and
// running it through validateCatalog: a corrupt or hand-edited record is
// rejected instead of reaching ranking code. The round trip is lossless for a
// catalog validateCatalog produced. A model carrying a projected steering
// block is re-wrapped into the raw { model, provider } shape first — the
// top-level `model` is never projected, so entry.id stands in for it (the
// projection ignores it either way). A hand-edited steering block re-projects
// or reads as absent, exactly like a raw one would.
export function validateStoredCatalog(
  stored: unknown,
): { ok: true; catalog: Catalog } | { ok: false; reason: string } {
  if (!isObject(stored)) return { ok: false, reason: "stored catalog must be an object" }
  // v6 projections always carry qualityEffort (null or a string) — a record
  // from an older projection lacks it and cannot be read as v6. The era gate
  // itself is the doc-cache record version (src/opencode/storage.ts): a
  // v5-era record is discarded before it reaches this function. Keeping this
  // presence check is defense in depth against hand-edited projections.
  if (Array.isArray(stored.models)) {
    for (const [i, entry] of stored.models.entries()) {
      if (isObject(entry) && !Object.hasOwn(entry, "qualityEffort")) {
        return { ok: false, reason: `models[${i}].qualityEffort is missing` }
      }
    }
  }
  const models = Array.isArray(stored.models)
    ? stored.models.map((entry) => {
        if (!isObject(entry)) return entry
        // The projection renamed quality_effort to qualityEffort and unwrapped
        // steering; rebuild the raw v6 shape. A hand-edited record re-projects
        // (or reads as absent) exactly like a raw one would.
        const raw: Record<string, unknown> = {
          ...entry,
          quality_effort: entry.qualityEffort ?? null,
        }
        if (entry.reasoning !== undefined) raw.reasoning = entry.reasoning
        if (entry.steering !== undefined) raw.steering = { model: entry.id, provider: entry.steering }
        return raw
      })
    : stored.models
  return validateCatalog({
    schema_version: 6,
    generated_at: stored.generatedAt,
    parameters: { weights: stored.weights },
    models,
    rankings: stored.rankings,
  })
}

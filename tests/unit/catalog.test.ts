// tests/unit/catalog.test.ts
import { readFileSync } from "node:fs"
import { describe, expect, test } from "vitest"
import { validateCatalog, validateStoredCatalog } from "../../src/core/catalog"

function model() {
  return {
    id: "acme/mini",
    name: "Acme Mini",
    pricing: { blended_per_1m: 0.5 },
    context: 128000,
    scores: {
      quality: 0.5,
      price: 0.5,
      context: 0.5,
      age: 0.5,
      overall: { balanced: 0.5, price: 0.5, quality: 0.5 },
    },
  }
}

function doc() {
  return {
    schema_version: 6,
    generated_at: "2026-10-09T00:00:00+00:00",
    models: [model()],
  }
}

// The reasoning block as upstream publishes it: the effective default, the
// expanded supported-effort list, the three raw flags and the measured depths.
function reasoning() {
  return {
    default_effort: "high",
    supported_efforts: ["max", "high"],
    default_enabled: true,
    mandatory: false,
    supports_max_tokens: null,
    depths: [
      {
        effort: "max",
        index: 56,
        cost_per_task_usd: 5.46,
        source: "aa",
        as_of: "2026-10-27T00:00:00+00:00",
      },
      {
        effort: "high",
        index: 46.8,
        cost_per_task_usd: 1.2,
        source: "aa",
        as_of: "2026-10-27T00:00:00+00:00",
      },
    ],
  }
}

// The raw steering shape mirrors the fixture's z-ai/glm-5.3-flash entry: the
// vendored script records { model, provider: { order, ignore,
// quantizations, allow_fallbacks } }; the projection unwraps `provider` as
// ModelEntry.steering and never projects the top-level `model`.
function steering() {
  return {
    model: "z-ai/glm-5.3-flash",
    provider: {
      order: ["streamlake/fp8", "novita/fp8"],
      ignore: ["open-inference/fp4"],
      quantizations: ["fp8"],
      allow_fallbacks: true,
    },
  }
}

test("accepts the recorded catalog fixture", () => {
  const raw = JSON.parse(readFileSync("fixtures/catalog-v0.7.0.json", "utf8"))
  // The gate accepts v6 only; the fixture records the v6 contract document.
  expect(raw.schema_version).toBe(6)
  const result = validateCatalog(raw)
  expect(result.ok).toBe(true)
  if (!result.ok) return
  expect(result.catalog.models.length).toBeGreaterThan(0)
})

test("accepts the no-quality fixture with no quality weight", () => {
  const raw = JSON.parse(readFileSync("fixtures/catalog-no-quality.json", "utf8"))
  const result = validateCatalog(raw)
  expect(result.ok).toBe(true)
  if (!result.ok) return
  // A quality-blind pool: upstream drops the quality key and renormalizes the
  // rest (0.4/0.1/0.1 → 2/3, 1/6, 1/6), exactly like the vendored script.
  const balanced = result.catalog.weights.balanced
  expect(balanced?.quality).toBeUndefined()
  expect(balanced?.price).toBeCloseTo(2 / 3, 10)
  expect(balanced?.context).toBeCloseTo(1 / 6, 10)
  expect((balanced?.price ?? 0) + (balanced?.context ?? 0) + (balanced?.age ?? 0)).toBeCloseTo(1, 10)
})

test("the no-quality fixture carries null quality provenance on every quality-less row (v5 fields)", () => {
  // A genuine quality-blind run emits no provenance: the vendored script
  // degrades quality_as_of/quality_drift to null on unmatched candidates and
  // schedules, so a quality-less row claiming "as of <timestamp>" would be a
  // provenance lie inside the contract fixture.
  const raw = JSON.parse(readFileSync("fixtures/catalog-no-quality.json", "utf8"))
  for (const model of raw.models) {
    expect(model.quality, model.id).toBeNull()
    expect(model.quality_match, model.id).toBeNull()
    expect(model.quality_as_of, model.id).toBeNull()
    expect(model.quality_drift, model.id).toBeNull()
    expect(model.quality_effort, model.id).toBeNull()
    // No measured quality means no measured depths (the effort metadata from
    // OpenRouter survives; the AA/OpenRouter score records do not).
    expect(model.reasoning.depths, model.id).toEqual([])
  }
  for (const entry of raw.schedules) {
    expect(entry.quality, entry.id).toBeNull()
    expect(entry.quality_as_of, entry.id).toBeNull()
    expect(entry.quality_effort, entry.id).toBeNull()
    expect(entry.quality_source, entry.id).toBeNull()
  }
  // sources.aa is the v5 shape: disjoint matched_* buckets with provenance
  // fields plus the depth counters — the v3 keys (fallback/matched) are
  // removed upstream and its validator rejects the old shape.
  expect(raw.sources.aa).toEqual({
    mode: "none",
    matched_aa: 0,
    matched_catalog: 0,
    matched_openrouter: 0,
    depth_rows: 0,
    matched_depth: 0,
    matched_default: 0,
    catalog_generated_at: null,
    intelligence_index_version: null,
  })
})

test("rejects an empty document, naming schema_version", () => {
  const result = validateCatalog({})
  expect(result.ok).toBe(false)
  if (result.ok) return
  expect(result.reason).toMatch(/schema_version/)
})

test("rejects schema_version 1 (dropped: the plugin never shipped, so no stored v1 docs exist)", () => {
  const result = validateCatalog({ ...doc(), schema_version: 1 })
  expect(result.ok).toBe(false)
  if (result.ok) return
  expect(result.reason).toMatch(/schema_version/)
})

test("rejects schema_version 5 (the previous contract, dropped with the 0.7.0 re-vendor)", () => {
  const result = validateCatalog({ ...doc(), schema_version: 5 })
  expect(result.ok).toBe(false)
  if (result.ok) return
  expect(result.reason).toMatch(/must be 6, got 5/)
})

test("rejects a model without scores", () => {
  const result = validateCatalog({ ...doc(), models: [{ id: "acme/mini" }] })
  expect(result.ok).toBe(false)
  if (result.ok) return
  expect(result.reason).toMatch(/scores/)
})

test("rejects a model without pricing", () => {
  const { pricing: _omitted, ...stripped } = model()
  const result = validateCatalog({ ...doc(), models: [stripped] })
  expect(result.ok).toBe(false)
  if (result.ok) return
  expect(result.reason).toMatch(/pricing/)
})

test("rejects a model with non-numeric blended_per_1m", () => {
  const bad = { ...model(), pricing: { blended_per_1m: "free" } }
  const result = validateCatalog({ ...doc(), models: [bad] })
  expect(result.ok).toBe(false)
  if (result.ok) return
  expect(result.reason).toMatch(/blended_per_1m/)
})

test("rejects non-finite numerics in every numeric slot (Infinity is reachable via JSON)", () => {
  // JSON.parse("1e999") is Infinity — a hostile catalogURL or a hand-edited
  // storage record can carry it (and NaN), and either poisons the ranking
  // comparators (Infinity - Infinity is NaN).
  const inf = JSON.parse("1e999")
  expect(inf).toBe(Infinity)
  // The fixture has no quality slot; the mutators may add one.
  type MutableModel = ReturnType<typeof model> & { quality?: number | null }
  const fields: Array<[string, (m: MutableModel, value: number) => void]> = [
    ["scores.quality", (m, v) => void (m.scores.quality = v)],
    ["scores.price", (m, v) => void (m.scores.price = v)],
    ["scores.context", (m, v) => void (m.scores.context = v)],
    ["scores.age", (m, v) => void (m.scores.age = v)],
    ["scores.overall.balanced", (m, v) => void (m.scores.overall.balanced = v)],
    ["scores.overall.price", (m, v) => void (m.scores.overall.price = v)],
    ["scores.overall.quality", (m, v) => void (m.scores.overall.quality = v)],
    ["pricing.blended_per_1m", (m, v) => void (m.pricing.blended_per_1m = v)],
    ["context", (m, v) => void (m.context = v)],
    ["quality", (m, v) => void (m.quality = v)],
  ]
  for (const [field, set] of fields) {
    for (const value of [inf, Number.NaN]) {
      const bad = model()
      set(bad, value)
      const result = validateCatalog({ ...doc(), models: [bad] })
      expect(result.ok, `${field} = ${value}`).toBe(false)
      if (!result.ok) expect(result.reason).toContain(field)
    }
  }
})

test("a non-numeric quality still coerces to null (optional field, unchanged leniency)", () => {
  const bad = { ...model(), quality: "37.9" }
  const result = validateCatalog({ ...doc(), models: [bad] })
  expect(result.ok).toBe(true)
  if (!result.ok) return
  expect(result.catalog.models[0].quality).toBeNull()
})

test("parameters.weights keeps only finite, non-negative weight values (hostile weights hardening)", () => {
  const inf = JSON.parse("1e999")
  const result = validateCatalog({
    ...doc(),
    parameters: {
      weights: {
        balanced: {
          quality: "0.5", // not a number: dropped
          price: inf, // Infinity: dropped
          context: Number.NaN, // NaN: dropped
          age: -1, // negative: dropped
          evil: "x", // unknown key: dropped
        },
      },
    },
  })
  expect(result.ok).toBe(true)
  if (!result.ok) return
  // The whole map was dropped → it behaves as absent.
  expect(result.catalog.weights).toEqual({})
})

test("parameters.weights keeps the valid remainder and drops only the invalid values", () => {
  const inf = JSON.parse("1e999")
  const result = validateCatalog({
    ...doc(),
    parameters: {
      weights: {
        balanced: { quality: 0.5, price: inf, context: 0.25, age: "junk", extra: 1 },
        quality: { quality: 0 }, // survives: zero is a valid weight
        price: { price: "x" }, // all-dropped → absent (missing priorities stay weight-0)
      },
    },
  })
  expect(result.ok).toBe(true)
  if (!result.ok) return
  expect(result.catalog.weights).toEqual({
    balanced: { quality: 0.5, context: 0.25 },
    quality: { quality: 0 },
  })
  // With at least one priority map present, consumers keep the documented
  // missing-priority semantics: a key the map lacks means weight 0.
  expect(result.catalog.weights.price).toBeUndefined()
})

test("an all-dropped parameters.weights behaves as absent (DEFAULT_WEIGHTS fallback)", () => {
  const result = validateCatalog({
    ...doc(),
    parameters: { weights: { balanced: { quality: "x" }, price: { price: Number.NaN }, quality: { age: -2 } } },
  })
  expect(result.ok).toBe(true)
  if (!result.ok) return
  // No map survives → empty weights → effectiveWeights falls back to
  // DEFAULT_WEIGHTS via hasParametersWeights.
  expect(result.catalog.weights).toEqual({})
})

test("keeps the optional pricing split only when finite numbers (hostile catalogURL hardening)", () => {
  const bad = {
    ...model(),
    pricing: { input_per_1m: "0.1", output_per_1m: Number.NaN, blended_per_1m: 0.5 },
  }
  const result = validateCatalog({ ...doc(), models: [bad] })
  expect(result.ok).toBe(true)
  if (!result.ok) return
  const pricing = result.catalog.models[0].pricing
  // non-numeric and non-finite halves are dropped to undefined (absent)
  expect(pricing.input_per_1m).toBeUndefined()
  expect(pricing.output_per_1m).toBeUndefined()
  expect(pricing.blended_per_1m).toBe(0.5)

  const good = {
    ...model(),
    pricing: { input_per_1m: 0.1, output_per_1m: 0.2, blended_per_1m: 0.5 },
  }
  const kept = validateCatalog({ ...doc(), models: [good] })
  expect(kept.ok).toBe(true)
  if (!kept.ok) return
  expect(kept.catalog.models[0].pricing.input_per_1m).toBe(0.1)
  expect(kept.catalog.models[0].pricing.output_per_1m).toBe(0.2)

  // absent stays absent
  const absent = validateCatalog(doc())
  expect(absent.ok).toBe(true)
  if (!absent.ok) return
  expect(absent.catalog.models[0].pricing.input_per_1m).toBeUndefined()
  expect(absent.catalog.models[0].pricing.output_per_1m).toBeUndefined()
})

// Task 2 — steering block projection (F-11/F-12): the model's steering block
// projects onto the entry as a provider-shaped record. Per-field absence (the
// pricing-split posture), no throw, no partial field.

test("projects a well-formed steering block (provider unwrapped; the top-level model is never projected)", () => {
  const result = validateCatalog({
    ...doc(),
    models: [{ ...model(), steering: steering() }],
  })
  expect(result.ok).toBe(true)
  if (!result.ok) return
  expect(result.catalog.models[0].steering).toEqual({
    order: ["streamlake/fp8", "novita/fp8"],
    ignore: ["open-inference/fp4"],
    quantizations: ["fp8"],
    allow_fallbacks: true,
  })
  expect(result.catalog.models[0].steering).not.toHaveProperty("model")
})

test("a hostile steering block reads as absent: no throw, no partial field, never the raw object", () => {
  const hostile: Array<[string, unknown]> = [
    ["a string where an array belongs", { order: "streamlake/fp8", ignore: ["c"], allow_fallbacks: true }],
    ["a nested object where an array belongs", { order: { "0": "streamlake/fp8" }, ignore: ["c"], allow_fallbacks: true }],
    ["a non-string array item", { order: ["streamlake/fp8", 5], ignore: ["c"], allow_fallbacks: true }],
    ["a string where ignore's array belongs", { order: ["a"], ignore: "open-inference/fp4", allow_fallbacks: true }],
    ["a non-string item in ignore", { order: ["a"], ignore: ["c", null], allow_fallbacks: true }],
    ["a string where a flag belongs", { order: ["a"], ignore: ["c"], allow_fallbacks: "true" }],
    ["a nested object where a flag belongs", { order: ["a"], ignore: ["c"], allow_fallbacks: { fallback: true } }],
    ["a string as the provider itself", "a"],
    ["an array as the provider itself", []],
    ["no provider at all", { model: "z-ai/glm-5.3-flash" }],
  ]
  for (const [name, provider] of hostile) {
    const raw = { ...model(), steering: { model: "z-ai/glm-5.3-flash", provider } }
    const result = validateCatalog({ ...doc(), models: [raw] })
    expect(result.ok, name).toBe(true)
    if (!result.ok) return
    // The raw hostile block passes through the ...entry spread today; the
    // projection must explicitly override it with undefined.
    expect(result.catalog.models[0].steering, name).toBeUndefined()
  }
  // The steering block itself malformed — absent either way.
  for (const [name, rawSteering] of [
    ["a string as the steering block itself", "z-ai/glm-5.3-flash"],
    ["an array as the steering block itself", []],
  ] as Array<[string, unknown]>) {
    const result = validateCatalog({ ...doc(), models: [{ ...model(), steering: rawSteering }] })
    expect(result.ok, name).toBe(true)
    if (!result.ok) return
    expect(result.catalog.models[0].steering, name).toBeUndefined()
  }
})

test("empty steering arrays are invalid: empty quantizations drops the field, empty order/ignore drops the block", () => {
  // An empty quantizations list — or one holding a non-string item — drops
  // just the field; the block survives.
  for (const [name, quantizations] of [
    ["an empty quantizations list", []],
    ["a non-string item in quantizations", ["fp8", 4]],
  ] as Array<[string, unknown]>) {
    const result = validateCatalog({
      ...doc(),
      models: [
        {
          ...model(),
          steering: { model: "z-ai/glm-5.3-flash", provider: { order: ["a"], ignore: ["b"], quantizations, allow_fallbacks: false } },
        },
      ],
    })
    expect(result.ok, name).toBe(true)
    if (!result.ok) return
    expect(result.catalog.models[0].steering, name).toEqual({ order: ["a"], ignore: ["b"], allow_fallbacks: false })
  }
  // An empty order or ignore list would filter out every endpoint — the whole
  // block drops rather than stranding routing.
  for (const [name, provider] of [
    ["an empty order list", { order: [], ignore: ["b"], allow_fallbacks: false }],
    ["an empty ignore list", { order: ["a"], ignore: [], allow_fallbacks: false }],
  ] as Array<[string, unknown]>) {
    const result = validateCatalog({
      ...doc(),
      models: [{ ...model(), steering: { model: "z-ai/glm-5.3-flash", provider } }],
    })
    expect(result.ok, name).toBe(true)
    if (!result.ok) return
    expect(result.catalog.models[0].steering, name).toBeUndefined()
  }
})

test("a model without steering stays without one (absent stays absent)", () => {
  const result = validateCatalog(doc())
  expect(result.ok).toBe(true)
  if (!result.ok) return
  expect(result.catalog.models[0].steering).toBeUndefined()
})

// v5 — reasoning depth projection: the effort `quality` was measured at and
// the per-model reasoning block (effective default, supported efforts, raw
// flags, measured depths). Display and request-injection both read this.
test("projects quality_effort and the reasoning block", () => {
  const result = validateCatalog({
    ...doc(),
    models: [{ ...model(), quality: 46.8, quality_effort: "high", reasoning: reasoning() }],
  })
  expect(result.ok).toBe(true)
  if (!result.ok) return
  expect(result.catalog.models[0].qualityEffort).toBe("high")
  expect(result.catalog.models[0].reasoning).toEqual(reasoning())
})

test("a model without quality_effort/reasoning projects both as absent", () => {
  const result = validateCatalog(doc())
  expect(result.ok).toBe(true)
  if (!result.ok) return
  expect(result.catalog.models[0].qualityEffort).toBeNull()
  expect(result.catalog.models[0].reasoning).toBeUndefined()
})

test("a hostile reasoning block is normalized field-by-field, never passed through raw", () => {
  const inf = JSON.parse("1e999")
  const result = validateCatalog({
    ...doc(),
    models: [
      {
        ...model(),
        quality_effort: 42,
        reasoning: {
          default_effort: 7,
          supported_efforts: ["max", 4, null],
          default_enabled: "yes",
          mandatory: 1,
          supports_max_tokens: "no",
          depths: [
            { effort: "max", index: 56, cost_per_task_usd: inf, source: 3, as_of: 4 },
            { index: 12 }, // no effort: dropped
            { effort: "", index: 12 }, // empty effort: dropped
            { effort: "high", index: "12" }, // non-number index: null
            "not a record",
          ],
          is_reasoning: true,
        },
      },
    ],
  })
  expect(result.ok).toBe(true)
  if (!result.ok) return
  expect(result.catalog.models[0].qualityEffort).toBeNull()
  expect(result.catalog.models[0].reasoning).toEqual({
    default_effort: null,
    supported_efforts: [],
    default_enabled: null,
    mandatory: null,
    supports_max_tokens: null,
    depths: [
      { effort: "max", index: 56, cost_per_task_usd: null, source: null, as_of: null },
      { effort: "high", index: null, cost_per_task_usd: null, source: null, as_of: null },
    ],
  })
})

test("a non-object reasoning block reads as absent", () => {
  for (const value of [[], "reasoning", 5, null]) {
    const result = validateCatalog({ ...doc(), models: [{ ...model(), reasoning: value }] })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.catalog.models[0].reasoning).toBeUndefined()
  }
})

test("rejects a model without context", () => {
  const { context: _omitted, ...stripped } = model()
  const result = validateCatalog({ ...doc(), models: [stripped] })
  expect(result.ok).toBe(false)
  if (result.ok) return
  expect(result.reason).toMatch(/context/)
})

test("rejects a model with a non-string name", () => {
  const bad = { ...model(), name: 42 }
  const result = validateCatalog({ ...doc(), models: [bad] })
  expect(result.ok).toBe(false)
  if (result.ok) return
  expect(result.reason).toMatch(/name/)
})

test("ignores unknown top-level fields", () => {
  const base = doc()
  const result = validateCatalog({ ...base, future_field: { any: "thing" } })
  expect(result.ok).toBe(true)
  if (!result.ok) return
  expect("future_field" in result.catalog).toBe(false)
  expect(result.catalog.models).toHaveLength(1)
  expect(result.catalog.generatedAt).toBe(base.generated_at)
})

describe("validateStoredCatalog (F-16)", () => {
  const recorded = () => {
    const result = validateCatalog(JSON.parse(readFileSync("fixtures/catalog-v0.7.0.json", "utf8")))
    if (!result.ok) throw new Error(result.reason)
    return result.catalog
  }

  test("round-trips a catalog validateCatalog produced, losslessly", () => {
    const catalog = recorded()
    // through JSON, as storage would
    const stored = JSON.parse(JSON.stringify(catalog))
    const result = validateStoredCatalog(stored)
    expect(result).toEqual({ ok: true, catalog })
  })

  test("round-trips the no-quality fixture (quality null, a missing weight key)", () => {
    const result = validateCatalog(JSON.parse(readFileSync("fixtures/catalog-no-quality.json", "utf8")))
    if (!result.ok) throw new Error(result.reason)
    expect(validateStoredCatalog(JSON.parse(JSON.stringify(result.catalog)))).toEqual({
      ok: true,
      catalog: result.catalog,
    })
  })

  test("rejects a pre-v5 stored projection (a model without qualityEffort)", () => {
    // Version-stale doc-cache records are discarded by the record-version gate
    // before they reach this function; this presence check is defense in depth
    // against a hand-edited projection, which no longer says which era it
    // came from.
    const stored = JSON.parse(JSON.stringify(recorded()))
    delete stored.models[0].qualityEffort
    const result = validateStoredCatalog(stored)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toMatch(/qualityEffort/)
  })

  test("round-trips quality_effort and the reasoning block", () => {
    const first = validateCatalog({
      ...doc(),
      models: [{ ...model(), quality: 46.8, quality_effort: "high", reasoning: reasoning() }],
    })
    expect(first.ok).toBe(true)
    if (!first.ok) return
    const stored = JSON.parse(JSON.stringify(first.catalog))
    expect(validateStoredCatalog(stored)).toEqual({ ok: true, catalog: first.catalog })
  })

  test("round-trips a steering block: the provider sub-object unwraps on the way in and re-wraps on the way back", () => {
    const first = validateCatalog({ ...doc(), models: [{ ...model(), steering: steering() }] })
    expect(first.ok).toBe(true)
    if (!first.ok) return
    expect(first.catalog.models[0].steering).toEqual({
      order: ["streamlake/fp8", "novita/fp8"],
      ignore: ["open-inference/fp4"],
      quantizations: ["fp8"],
      allow_fallbacks: true,
    })
    // through JSON, as storage would
    const stored = JSON.parse(JSON.stringify(first.catalog))
    expect(validateStoredCatalog(stored)).toEqual({ ok: true, catalog: first.catalog })
  })

  test.each([
    ["null", null],
    ["a string", "x"],
    ["an array", []],
    ["no models", { generatedAt: "t", weights: {}, rankings: {} }],
    ["models not an array", { generatedAt: "t", weights: {}, rankings: {}, models: 1 }],
    ["a model without scores", { generatedAt: "t", weights: {}, rankings: {}, models: [{ id: "a" }] }],
    ["no generatedAt", { weights: {}, rankings: {}, models: [] }],
  ])("rejects %s", (_name, stored) => {
    expect(validateStoredCatalog(stored).ok).toBe(false)
  })
})

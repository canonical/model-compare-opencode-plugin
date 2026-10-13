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
    schema_version: 2,
    generated_at: "2026-10-09T00:00:00+00:00",
    models: [model()],
  }
}

test("accepts the recorded catalog fixture", () => {
  const raw = JSON.parse(readFileSync("fixtures/catalog-v0.3.0.json", "utf8"))
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

test("rejects schema_version 3", () => {
  const result = validateCatalog({ ...doc(), schema_version: 3 })
  expect(result.ok).toBe(false)
  if (result.ok) return
  expect(result.reason).toMatch(/schema_version/)
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
    const result = validateCatalog(JSON.parse(readFileSync("fixtures/catalog-v0.3.0.json", "utf8")))
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

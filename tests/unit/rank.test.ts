// tests/unit/rank.test.ts
import { readFileSync } from "node:fs"
import { validateCatalog } from "../../src/core/catalog"
import { effectiveWeights, overallScore, rankModels } from "../../src/core/rank"
import { DEFAULT_WEIGHTS, type Catalog, type ModelEntry } from "../../src/core/types"

function catalogFromFixture(path: string): Catalog {
  const raw = JSON.parse(readFileSync(path, "utf8"))
  const result = validateCatalog(raw)
  if (!result.ok) throw new Error(`fixture invalid: ${result.reason}`)
  return result.catalog
}

function syntheticModel(opts?: {
  id?: string
  quality?: number | null
  blended?: number
  scores?: { quality?: number; price?: number; context?: number; age?: number }
  overall?: number
}): ModelEntry {
  const scores = {
    quality: opts?.scores?.quality ?? 0.5,
    price: opts?.scores?.price ?? 0.5,
    context: opts?.scores?.context ?? 0.5,
    age: opts?.scores?.age ?? 0.5,
  }
  const overall = opts?.overall ?? 0.5
  return {
    id: opts?.id ?? "synthetic/model",
    name: "Synthetic Model",
    pricing: { blended_per_1m: opts?.blended ?? 1 },
    context: 128000,
    quality: opts?.quality ?? null,
    scores: { ...scores, overall: { balanced: overall, price: overall, quality: overall } },
  }
}

// `weights: {}` mirrors what validateCatalog builds when the document has no
// `parameters.weights` at all; `rankings: {}` when it has no `rankings`.
function syntheticCatalog(
  models: ModelEntry[],
  opts?: { weights?: Catalog["weights"]; rankings?: Catalog["rankings"] },
): Catalog {
  return {
    generatedAt: "2026-10-09T00:00:00+00:00",
    weights: opts?.weights ?? {},
    rankings: opts?.rankings ?? {},
    models,
  }
}

describe("effectiveWeights", () => {
  test("normalizes the merged map to sum 1 (§6 worked example)", () => {
    const catalog = catalogFromFixture("fixtures/catalog-v0.5.0.json")
    const eff = effectiveWeights(catalog, "balanced", { quality: 0.5 })
    expect(eff.usedOverride).toBe(true)
    expect(eff.zeroSum).toBe(false)
    expect(eff.weights.quality).toBeCloseTo(0.4545454, 6)
    expect(eff.weights.price).toBeCloseTo(0.3636364, 6)
    expect(eff.weights.context).toBeCloseTo(0.0909091, 6)
    expect(eff.weights.age).toBeCloseTo(0.0909091, 6)
  })

  test("falls back to DEFAULT_WEIGHTS when parameters.weights is missing entirely", () => {
    const catalog = syntheticCatalog([syntheticModel()])
    const eff = effectiveWeights(catalog, "price")
    expect(eff.weights).toEqual(DEFAULT_WEIGHTS.price)
    expect(eff.usedOverride).toBe(false)
    expect(eff.zeroSum).toBe(false)
  })

  test("applies an override to DEFAULT_WEIGHTS when parameters.weights is missing entirely", () => {
    const catalog = syntheticCatalog([syntheticModel()])
    const eff = effectiveWeights(catalog, "balanced", { quality: 0.5 })
    // DEFAULT balanced 0.4/0.4/0.1/0.1 with quality → 0.5, rescaled by
    // 1/1.1 — the §6 worked example on the DEFAULT base. No ignore
    // warnings: there is no published map, hence no no-data signal.
    expect(eff.usedOverride).toBe(true)
    expect(eff.zeroSum).toBe(false)
    expect(eff.warnings).toEqual([])
    expect(eff.weights.quality).toBeCloseTo(0.4545454, 6)
    expect(eff.weights.price).toBeCloseTo(0.3636364, 6)
    expect(eff.weights.context).toBeCloseTo(0.0909091, 6)
    expect(eff.weights.age).toBeCloseTo(0.0909091, 6)
  })

  test("keeps published weights as-is without an override (missing key means 0)", () => {
    const catalog = catalogFromFixture("fixtures/catalog-no-quality.json")
    const eff = effectiveWeights(catalog, "balanced")
    expect(eff.usedOverride).toBe(false)
    expect(eff.zeroSum).toBe(false)
    // The no-quality fixture carries the renormalized published weights.
    expect(eff.weights.quality).toBe(0)
    expect(eff.weights.price).toBeCloseTo(2 / 3, 10)
    expect(eff.weights.context).toBeCloseTo(1 / 6, 10)
    expect(eff.weights.age).toBeCloseTo(1 / 6, 10)
  })

  test("ignores an override for a key the published weights lack, warns, applies the rest", () => {
    const catalog = catalogFromFixture("fixtures/catalog-no-quality.json")
    const eff = effectiveWeights(catalog, "balanced", { quality: 1, price: 0.6 })
    // quality stays missing (weight 0); the other keys apply and the merged
    // map is renormalized over the published 1/6 + 1/6 and the override 0.6:
    // total 14/15 → price 0.6/(14/15) = 9/14, context and age (1/6)/(14/15) = 5/28.
    expect(eff.weights.quality).toBe(0)
    expect(eff.weights.price).toBeCloseTo(9 / 14, 10)
    expect(eff.weights.context).toBeCloseTo(5 / 28, 10)
    expect(eff.weights.age).toBeCloseTo(5 / 28, 10)
    expect(eff.warnings.length).toBeGreaterThan(0)
    expect(eff.warnings.join(" ")).toMatch(/quality/)
    expect(eff.zeroSum).toBe(false)
  })

  test("reports zeroSum for an all-zero weights map and falls back to the published weights", () => {
    const catalog = syntheticCatalog([syntheticModel()], {
      weights: { balanced: { quality: 0, price: 0, context: 0, age: 0 } },
    })
    const eff = effectiveWeights(catalog, "balanced", { price: 0 })
    expect(eff.zeroSum).toBe(true)
    expect(eff.weights).toEqual({ quality: 0, price: 0, context: 0, age: 0 })
  })

  test("applied reports whether any override key landed in the merged map", () => {
    const catalog = catalogFromFixture("fixtures/catalog-no-quality.json")
    // price lands even though quality is dropped with a warning.
    expect(effectiveWeights(catalog, "balanced", { quality: 1, price: 0.6 }).applied).toBe(true)
    // every key dropped by the no-data signal → nothing applied.
    expect(effectiveWeights(catalog, "balanced", { quality: 1 }).applied).toBe(false)
    expect(effectiveWeights(catalog, "balanced", {}).applied).toBe(false)
    expect(effectiveWeights(catalog, "balanced").applied).toBe(false)
  })
})

describe("overallScore", () => {
  test("sums weighted components in the quality, price, context, age order", () => {
    const entry = syntheticModel({
      scores: { quality: 1, price: 0.5, context: 0.25, age: 0 },
      overall: 0,
    })
    const w = { quality: 0.4, price: 0.4, context: 0.1, age: 0.1 }
    expect(overallScore(entry, w)).toBeCloseTo(0.4 * 1 + 0.4 * 0.5 + 0.1 * 0.25 + 0.1 * 0, 10)
  })
})

describe("rankModels", () => {
  test("no override returns the published ranking verbatim", () => {
    const catalog = catalogFromFixture("fixtures/catalog-v0.5.0.json")
    const ranked = rankModels(catalog, "balanced")
    expect(ranked.ids).toEqual(catalog.rankings.balanced)
    expect(ranked.usedFallbackWeights).toBe(false)
  })

  test("no override and no published ranking sorts by scores.overall", () => {
    const high = syntheticModel({ id: "synthetic/high", overall: 0.9 })
    const low = syntheticModel({ id: "synthetic/low", overall: 0.1 })
    const catalog = syntheticCatalog([low, high])
    expect(rankModels(catalog, "balanced").ids).toEqual(["synthetic/high", "synthetic/low"])
  })

  test("with an override, equal scores break by cheaper blended_per_1m first", () => {
    const dear = syntheticModel({ id: "synthetic/dear", blended: 2 })
    const cheap = syntheticModel({ id: "synthetic/cheap", blended: 1 })
    const catalog = syntheticCatalog([dear, cheap])
    const ranked = rankModels(catalog, "balanced", { quality: 0.4 })
    expect(ranked.ids).toEqual(["synthetic/cheap", "synthetic/dear"])
    expect(ranked.usedFallbackWeights).toBe(false)
  })

  test("with an override, equal scores and price break by id ascending", () => {
    const second = syntheticModel({ id: "synthetic/b", blended: 1 })
    const first = syntheticModel({ id: "synthetic/a", blended: 1 })
    const catalog = syntheticCatalog([second, first])
    const ranked = rankModels(catalog, "balanced", { quality: 0.4 })
    expect(ranked.ids).toEqual(["synthetic/a", "synthetic/b"])
  })

  test("no published ranking and no override breaks overall ties by cheaper first", () => {
    const dear = syntheticModel({ id: "synthetic/dear", blended: 2, overall: 0.5 })
    const cheap = syntheticModel({ id: "synthetic/cheap", blended: 1, overall: 0.5 })
    const catalog = syntheticCatalog([dear, cheap])
    expect(rankModels(catalog, "balanced").ids).toEqual(["synthetic/cheap", "synthetic/dear"])
  })

  test("runtime zero-sum returns the published order with usedFallbackWeights", () => {
    // All-zero published weights: upstream's order (by the tie-break, since
    // every weighted score is 0) is the published one; the override cannot
    // change it, so the plugin falls back to the published weights.
    const cheap = syntheticModel({ id: "synthetic/cheap", blended: 1, overall: 0.9 })
    const dear = syntheticModel({ id: "synthetic/dear", blended: 2, overall: 0.1 })
    const catalog = syntheticCatalog([dear, cheap], {
      weights: { balanced: { quality: 0, price: 0, context: 0, age: 0 } },
      rankings: { balanced: ["synthetic/cheap", "synthetic/dear"] },
    })
    const ranked = rankModels(catalog, "balanced", { price: 0 })
    expect(ranked.ids).toEqual(catalog.rankings.balanced)
    expect(ranked.usedFallbackWeights).toBe(true)
  })

  test("an override without a zero-sum path rescored the models", () => {
    // Quality-only weights must put the fixture's uniquely best quality
    // score first — proof the override re-ranked instead of echoing the
    // published balanced ranking. The anchor is derived from the fixture
    // (the max of a DIFFERENT field than the ranking uses), asserted
    // unique so the test stays well-anchored across vendor upgrades.
    const catalog = catalogFromFixture("fixtures/catalog-v0.5.0.json")
    const best = [...catalog.models].sort((a, b) => (b.scores.quality ?? 0) - (a.scores.quality ?? 0))[0]
    const runnersUp = catalog.models.filter((m) => m.id !== best.id && (m.scores.quality ?? 0) === best.scores.quality)
    expect(runnersUp).toEqual([]) // unique anchor
    const ranked = rankModels(catalog, "balanced", { quality: 1, price: 0, context: 0, age: 0 })
    expect(ranked.usedFallbackWeights).toBe(false)
    expect(ranked.ids[0]).toBe(best.id)
    expect(ranked.ids).not.toEqual(catalog.rankings.balanced)
  })
})

// tests/unit/canary.test.mjs
// The nightly canary's contract check (scripts/canary-check.mjs) as a pure
// function. It once hard-coded schema_version 1 and failed every night after
// the v0.3.0 re-vendor with nothing testing it (review F-02).
import { readFileSync } from "node:fs"
import { describe, expect, test } from "vitest"
import { checkCanary } from "../../scripts/canary-check.mjs"

const fixture = () => JSON.parse(readFileSync("fixtures/catalog-v0.7.0.json", "utf8"))

describe("checkCanary", () => {
  test("passes the recorded v6 catalog", () => {
    const doc = fixture()
    expect(doc.schema_version).toBe(6)
    expect(checkCanary(doc)).toEqual({ ok: true, models: doc.models.length })
  })

  test("fails a schema v5 document, naming both versions", () => {
    const doc = { ...fixture(), schema_version: 5 }
    const result = checkCanary(doc)
    expect(result.ok).toBe(false)
    expect(result.reason).toMatch(/schema_version is 5, expected 6/)
  })

  test("fails a missing schema_version", () => {
    const { schema_version, ...rest } = fixture()
    expect(checkCanary(rest)).toEqual({ ok: false, reason: "schema_version is null, expected 6" })
  })

  test("fails an empty model pool", () => {
    expect(checkCanary({ ...fixture(), models: [] }).reason).toMatch(/models is missing, empty/)
  })

  test("fails a model without an overall score for a priority", () => {
    const doc = fixture()
    delete doc.models[0].scores.overall.price
    const result = checkCanary(doc)
    expect(result.ok).toBe(false)
    expect(result.reason).toMatch(/scores\.overall\.price is not a finite number/)
  })

  test("fails a model with a non-finite component score", () => {
    const doc = fixture()
    doc.models[1].scores.age = null
    expect(checkCanary(doc).reason).toMatch(/model 1 .*scores\.age/)
  })

  test("fails a scored model without quality_effort (the depth contract)", () => {
    const doc = fixture()
    const model = doc.models.find((entry) => entry.quality !== null)
    expect(model, "the fixture carries a scored model").toBeDefined()
    model.quality_effort = null
    expect(checkCanary(doc).reason).toMatch(/quality_effort/)
  })

  test("fails a model without the reasoning block", () => {
    const doc = fixture()
    delete doc.models[0].reasoning
    expect(checkCanary(doc).reason).toMatch(/reasoning is missing/)
  })

  test("fails a reasoner whose reasoning block lacks a well-shaped depths list", () => {
    const doc = fixture()
    doc.models[0].reasoning.depths = "max"
    expect(checkCanary(doc).reason).toMatch(/reasoning\.depths/)
  })

  test("fails a non-object document", () => {
    expect(checkCanary(null).ok).toBe(false)
    expect(checkCanary([]).ok).toBe(false)
  })

  test("fails when generated_at is missing or not a non-empty string", () => {
    const missing = fixture()
    delete missing.generated_at
    expect(checkCanary(missing).reason).toMatch(/generated_at/)
    expect(checkCanary({ ...fixture(), generated_at: 123 }).reason).toMatch(/generated_at/)
    expect(checkCanary({ ...fixture(), generated_at: "" }).reason).toMatch(/generated_at/)
  })

  test("fails when model.name is missing or not a non-empty string", () => {
    const doc = fixture()
    doc.models[0].name = 42
    expect(checkCanary(doc).reason).toMatch(/name/)

    const empty = fixture()
    empty.models[0].name = ""
    expect(checkCanary(empty).reason).toMatch(/name/)
  })

  test("fails when model.pricing or pricing.blended_per_1m is invalid", () => {
    const noPricing = fixture()
    noPricing.models[0].pricing = null
    expect(checkCanary(noPricing).reason).toMatch(/pricing/)

    const arrayPricing = fixture()
    arrayPricing.models[0].pricing = []
    expect(checkCanary(arrayPricing).reason).toMatch(/pricing/)

    for (const bad of ["free", Number.NaN, Number.POSITIVE_INFINITY, null]) {
      const doc = fixture()
      doc.models[0].pricing.blended_per_1m = bad
      expect(checkCanary(doc).reason).toMatch(/blended_per_1m/)
    }
  })

  test("fails when model.context is missing or non-finite", () => {
    for (const bad of [undefined, "128k", Number.NaN, Number.POSITIVE_INFINITY]) {
      const doc = fixture()
      doc.models[0].context = bad
      expect(checkCanary(doc).reason).toMatch(/context/)
    }
  })

  test("fails when model.quality is neither null nor a finite number", () => {
    for (const bad of [undefined, "45.0", Number.NaN, Number.POSITIVE_INFINITY]) {
      const doc = fixture()
      doc.models[0].quality = bad
      expect(checkCanary(doc).reason).toMatch(/quality/)
    }
  })

  test("fails when parameters.weights or a priority weight map is not a plain object", () => {
    for (const weights of ["bad", [], null]) {
      const doc = fixture()
      doc.parameters = { ...doc.parameters, weights }
      expect(checkCanary(doc).reason).toMatch(/parameters\.weights/)
    }
    for (const balanced of ["bad", [], null]) {
      const doc = fixture()
      doc.parameters = { ...doc.parameters, weights: { ...doc.parameters.weights, balanced } }
      expect(checkCanary(doc).reason).toMatch(/parameters\.weights\.balanced/)
    }
  })

  test("fails when rankings or a priority ranking list is malformed", () => {
    for (const rankings of ["bad", [], null]) {
      const doc = fixture()
      doc.rankings = rankings
      expect(checkCanary(doc).reason).toMatch(/rankings/)
    }
    for (const price of ["bad", {}, [123], ["ok", null]]) {
      const doc = fixture()
      doc.rankings = { ...doc.rankings, price }
      expect(checkCanary(doc).reason).toMatch(/rankings\.price/)
    }
  })
})

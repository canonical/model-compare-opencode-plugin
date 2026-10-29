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

  test("fails a scored model without quality_effort (the v5 depth contract)", () => {
    const doc = fixture()
    const model = doc.models.find((entry) => entry.quality !== null)
    expect(model, "the fixture carries a scored model").toBeDefined()
    model.quality_effort = null
    expect(checkCanary(doc).reason).toMatch(/quality_effort/)
  })

  test("fails a model without the v5 reasoning block", () => {
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
  })
})

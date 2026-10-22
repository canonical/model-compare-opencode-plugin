// tests/unit/canary.test.mjs
// The nightly canary's contract check (scripts/canary-check.mjs) as a pure
// function. It once hard-coded schema_version 1 and failed every night after
// the v0.3.0 re-vendor with nothing testing it (review F-02).
import { readFileSync } from "node:fs"
import { describe, expect, test } from "vitest"
import { checkCanary } from "../../scripts/canary-check.mjs"

const fixture = () => JSON.parse(readFileSync("fixtures/catalog-v0.4.0.json", "utf8"))

describe("checkCanary", () => {
  test("passes the recorded v3 catalog", () => {
    const doc = fixture()
    expect(doc.schema_version).toBe(3)
    expect(checkCanary(doc)).toEqual({ ok: true, models: doc.models.length })
  })

  test("fails a schema v1 document, naming both versions", () => {
    const doc = { ...fixture(), schema_version: 1 }
    const result = checkCanary(doc)
    expect(result.ok).toBe(false)
    expect(result.reason).toMatch(/schema_version is 1, expected 3/)
  })

  test("fails a missing schema_version", () => {
    const { schema_version, ...rest } = fixture()
    expect(checkCanary(rest)).toEqual({ ok: false, reason: "schema_version is null, expected 3" })
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

  test("fails a non-object document", () => {
    expect(checkCanary(null).ok).toBe(false)
  })
})

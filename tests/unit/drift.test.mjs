// tests/unit/drift.test.mjs
// The weekly drift check's two pure checks (scripts/drift-check.mjs): the
// vendor pin re-verified against upstream's bytes, and the published-contract
// consistency of rankings vs scores.
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { describe, expect, test } from "vitest"
import { checkRankings, checkVendorDrift, upstreamRawURL } from "../../scripts/drift-check.mjs"

const sha = (b) => createHash("sha256").update(b).digest("hex")
const SCRIPT = Buffer.from("print('model-compare')\n")
const meta = (bytes = SCRIPT, extra = {}) => ({
  repo: "canonical/model-compare",
  tag: "v9.9.9",
  commit: "0123456789abcdef0123456789abcdef01234567",
  sha256: sha(bytes),
  ...extra,
})

describe("checkVendorDrift", () => {
  test("ok when the local file equals upstream at the pinned commit and the recorded sha", () => {
    const result = checkVendorDrift(meta(), SCRIPT, SCRIPT)
    expect(result.ok).toBe(true)
    expect(result.line).toMatch(/vendor: ok/)
  })

  test("DRIFT when the local file differs from upstream's bytes at the commit", () => {
    const tampered = Buffer.from("print('evil')\n")
    // The attacker also rewrites the recorded sha: the offline hash check
    // would pass, the upstream comparison must not.
    const result = checkVendorDrift(meta(tampered), tampered, SCRIPT)
    expect(result.ok).toBe(false)
    expect(result.line).toMatch(/DRIFT/)
  })

  test("DRIFT when the file equals upstream but UPSTREAM.json's sha256 is stale", () => {
    const result = checkVendorDrift(meta(SCRIPT, { sha256: "0".repeat(64) }), SCRIPT, SCRIPT)
    expect(result.ok).toBe(false)
    expect(result.line).toMatch(/DRIFT/)
  })

  test("the upstream URL is keyed by the pinned commit, not the mutable tag", () => {
    const url = upstreamRawURL(meta())
    expect(url).toContain("0123456789abcdef0123456789abcdef01234567")
    expect(url).not.toContain("v9.9.9")
  })

  test("the real pin: UPSTREAM.json's recorded sha256 equals the vendored file", () => {
    const real = JSON.parse(readFileSync("vendor/UPSTREAM.json", "utf8"))
    const local = readFileSync("vendor/model_compare.py")
    expect(checkVendorDrift(real, local, local).ok).toBe(true)
  })
})

describe("checkRankings", () => {
  const fixture = () => JSON.parse(readFileSync("fixtures/catalog-v0.5.0.json", "utf8"))

  test("the recorded catalog is self-consistent", () => {
    const result = checkRankings(fixture())
    expect(result.ok).toBe(true)
    expect(result.failed).toBe(false)
  })

  test("rejects a catalog without rankings", () => {
    const doc = fixture()
    delete doc.rankings
    expect(checkRankings(doc)).toEqual({ ok: false, reason: "published catalog has no rankings.balanced" })
  })

  test("reversing a published ranking produces real differences and fails", () => {
    const doc = fixture()
    for (const p of Object.keys(doc.rankings)) doc.rankings[p].reverse()
    const result = checkRankings(doc)
    expect(result.ok).toBe(true)
    expect(result.failed).toBe(true)
    expect(result.realDiffs).toBeGreaterThanOrEqual(3)
  })
})

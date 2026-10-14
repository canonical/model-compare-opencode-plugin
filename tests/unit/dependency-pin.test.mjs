// tests/unit/dependency-pin.test.mjs — dependency-hygiene guard.
//
// GitHub Dependabot alert #2 (canonical/model-compare-opencode-plugin):
// seroval >= 0.12.0 <= 1.6.0, critical — fromJSON() Promise thenable
// assimilation invokes plugin-produced callables (bypass of
// GHSA-mv8w-475r-vwqw). Fixed in seroval 1.6.1.
//
// solid-js 1.9.12 — pinned EXACTLY by every @opentui/solid release, so it
// cannot be bumped — declares seroval ~1.5.0, which resolves into the
// vulnerable range. The fix therefore lands only through the root package's
// "overrides" entry. This test fails if that override is ever lost (e.g. a
// lockfile regenerated without it) and the vulnerable range returns.
import { describe, expect, test } from "vitest"
import { createRequire } from "node:module"
import { existsSync, readFileSync } from "node:fs"
import path from "node:path"

const require = createRequire(import.meta.url)
// seroval's exports map blocks the "./package.json" subpath and the entry
// resolves deep inside dist/, so walk up from the resolved entry to the
// package root (the nearest ancestor directory holding its manifest).
let pkgRoot = path.dirname(require.resolve("seroval"))
while (!existsSync(path.join(pkgRoot, "package.json"))) pkgRoot = path.dirname(pkgRoot)
const { version } = JSON.parse(readFileSync(path.join(pkgRoot, "package.json"), "utf8"))

// -> boolean: is `version` at or above the `floor` triple?
function atLeast(version, floor) {
  const a = version.split(".").map(Number)
  const b = floor.split(".").map(Number)
  for (let i = 0; i < b.length; i++) {
    if ((a[i] ?? 0) !== b[i]) return (a[i] ?? 0) > b[i]
  }
  return true
}

describe("seroval install", () => {
  test("is outside the vulnerable range (Dependabot #2: fixed in 1.6.1)", () => {
    expect(atLeast(version, "1.6.1")).toBe(true)
  })
})

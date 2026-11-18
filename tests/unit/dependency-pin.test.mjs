// tests/unit/dependency-pin.test.mjs — dependency-hygiene guard.
//
// Advisory chain (GHSA-p6vx-979v-rg4c, GHSA-jp82-f5mq-hwhp, GHSA-9wx9-5pv9-3349,
// GHSA-97r2-qh9m-474h, GHSA-wp97-x4hv-qvhp, GHSA-7rv5-mrxv-xcr9):
// seroval <= 1.6.9 is affected by critical/high deserialization vulnerabilities
// (patched in >= 1.6.10), and solid-js 1.9.7 – 1.9.15 pulls seroval ~1.5.0.
//
// @opentui/solid >= 0.8.4 widens peerDependencies.solid-js to ^1.9.12, allowing
// solid-js 1.9.19 in devDependencies to resolve seroval ~1.6.11 (>= 1.6.10)
// directly without a root "overrides" entry (published packages declare zero
// dependencies/peerDependencies/overrides). This test ensures neither node_modules
// nor any nested entry in package-lock.json regresses into the vulnerable ranges.
import { describe, expect, test } from "vitest"
import { createRequire } from "node:module"
import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..")
const repoNodeModulesPrefix = path.join(repoRoot, "node_modules") + path.sep
const repoRequire = createRequire(path.join(repoRoot, "package.json"))

// Walk up from a resolved module entry to its owning package root (seroval's
// exports map blocks "./package.json"), stopping safely at the filesystem root.
function findPackageRoot(entryPath, expectedName, fsOps = { existsSync, readFileSync }) {
  let dir = path.dirname(entryPath)
  while (true) {
    const manifestPath = path.join(dir, "package.json")
    if (fsOps.existsSync(manifestPath)) {
      const manifest = JSON.parse(fsOps.readFileSync(manifestPath, "utf8"))
      if (manifest.name === expectedName) {
        return { pkgRoot: dir, version: manifest.version }
      }
    }
    const parent = path.dirname(dir)
    if (parent === dir) {
      throw new Error(`could not locate package.json for "${expectedName}" above ${entryPath}`)
    }
    dir = parent
  }
}

function resolveInstalledPackage(pkgName) {
  return findPackageRoot(repoRequire.resolve(pkgName), pkgName)
}

const lockfile = JSON.parse(readFileSync(path.join(repoRoot, "package-lock.json"), "utf8"))
const packages = lockfile.packages ?? {}

const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/

// -> boolean: is SemVer `version` at or above the release `floor` triple?
// Pre-releases on the exact floor triple (e.g. 1.6.10-alpha.1 vs 1.6.10) rank
// below the release per SemVer 2.0.0 §11, while +build metadata is equal.
function atLeast(version, floor) {
  if (typeof version !== "string" || typeof floor !== "string") return false
  const parsed = SEMVER_RE.exec(version)
  const target = SEMVER_RE.exec(floor)
  if (!parsed || !target) return false
  const a = [Number(parsed[1]), Number(parsed[2]), Number(parsed[3])]
  const b = [Number(target[1]), Number(target[2]), Number(target[3])]
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i]
  }
  return parsed[4] === undefined
}

describe("seroval, seroval-plugins, and solid-js dev install", () => {
  test.each([
    ["seroval", "1.6.10"],
    ["seroval-plugins", "1.6.10"],
    ["solid-js", "1.9.16"],
  ])("resolved %s in this checkout's node_modules is >= %s", (pkgName, floor) => {
    const { pkgRoot, version } = resolveInstalledPackage(pkgName)
    expect(pkgRoot.startsWith(repoNodeModulesPrefix), `${pkgName} escaped to ${pkgRoot}`).toBe(true)
    expect(atLeast(version, floor), `${pkgName}@${version} < ${floor}`).toBe(true)
  })

  test.each([
    ["seroval", /(?:^|\/)node_modules\/seroval$/, "1.6.10"],
    ["seroval-plugins", /(?:^|\/)node_modules\/seroval-plugins$/, "1.6.10"],
    ["solid-js", /(?:^|\/)node_modules\/solid-js$/, "1.9.16"],
  ])("every %s entry in package-lock.json is >= %s", (_pkgName, keyPattern, floor) => {
    const entries = Object.entries(packages).filter(([key]) => keyPattern.test(key))
    expect(entries.length).toBeGreaterThan(0)
    for (const [key, info] of entries) {
      expect(atLeast(info.version, floor), `${key}@${info.version} < ${floor}`).toBe(true)
    }
  })

  test("findPackageRoot terminates cleanly at filesystem root if package.json is absent", () => {
    expect(() =>
      findPackageRoot("/nonexistent/deep/entry.js", "seroval", {
        existsSync: () => false,
        readFileSync: () => "{}",
      }),
    ).toThrow(/could not locate package\.json for "seroval"/)
  })
})

describe("atLeast SemVer floor helper", () => {
  test.each([
    ["1.6.10", "1.6.10", true],
    ["1.6.12", "1.6.10", true],
    ["1.7.0", "1.6.10", true],
    ["2.0.0", "1.6.10", true],
    ["1.6.10+build.1", "1.6.10", true],
    ["1.6.11-alpha.1", "1.6.10", true],
    ["1.6.9", "1.6.10", false],
    ["1.6.10-alpha.1", "1.6.10", false],
    ["1.9.16-rc.0", "1.9.16", false],
    ["", "0.0.0", false],
    [undefined, "1.6.10", false],
    ["not-semver", "1.6.10", false],
    ["1.6", "1.6.0", false],
  ])("atLeast(%j, %j) -> %s", (candidate, floor, expected) => {
    expect(atLeast(candidate, floor)).toBe(expected)
  })
})

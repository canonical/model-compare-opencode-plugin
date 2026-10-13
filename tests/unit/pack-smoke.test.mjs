// tests/unit/pack-smoke.test.mjs
// The packaging smoke test's pure checker (scripts/pack-smoke.mjs): the
// tarball's file set against design §12, the exports map, and the relative
// imports inside the packaged sources.
import { describe, expect, test } from "vitest"
import { checkPackage } from "../../scripts/pack-smoke.mjs"

const good = () =>
  new Map([
    ["package.json", JSON.stringify({ exports: { ".": "./src/index.ts" } })],
    ["LICENSE", "GPL"],
    ["README.md", "# readme"],
    ["vendor/model_compare.py", "print()"],
    ["vendor/UPSTREAM.json", "{}"],
    ["src/index.ts", 'import { a } from "./core/a"\nimport x from "./sources"\n'],
    ["src/core/a.ts", "export const a = 1"],
    [
      "src/sources/index.ts",
      'export const SCRIPT = new URL("../../vendor/model_compare.py", import.meta.url)\n',
    ],
  ])

describe("checkPackage", () => {
  test("a package with exactly the §12 files passes", () => {
    expect(checkPackage(good())).toEqual([])
  })

  test.each(["tests/unit/x.test.ts", "scripts/sync-vendor.mjs", "fixtures/catalog.json", "docs/spec.md", ".github/x.yml"])(
    "flags a stray %s",
    (stray) => {
      const files = good()
      files.set(stray, "x")
      expect(checkPackage(files)).toEqual([`unexpected file in the package: ${stray}`])
    },
  )

  test.each(["LICENSE", "README.md", "vendor/model_compare.py", "vendor/UPSTREAM.json"])("flags a missing %s", (name) => {
    const files = good()
    files.delete(name)
    expect(checkPackage(files).join("\n")).toContain(`missing from the package: ${name}`)
  })

  test("flags an exports entry that is not in the package", () => {
    const files = good()
    files.set("package.json", JSON.stringify({ exports: { ".": "./src/gone.ts" } }))
    expect(checkPackage(files).join("\n")).toMatch(/exports\["."\] points at \.\/src\/gone\.ts/)
  })

  test("flags a missing exports map", () => {
    const files = good()
    files.set("package.json", "{}")
    expect(checkPackage(files).join("\n")).toMatch(/no resolvable exports/)
  })

  test("flags a relative import that does not resolve", () => {
    const files = good()
    files.delete("src/core/a.ts")
    expect(checkPackage(files).join("\n")).toMatch(/src\/index\.ts: import "\.\/core\/a" does not resolve/)
  })

  test("flags a vendored-script locator that does not resolve", () => {
    const files = good()
    files.delete("vendor/model_compare.py")
    const problems = checkPackage(files).join("\n")
    expect(problems).toMatch(/URL "\.\.\/\.\.\/vendor\/model_compare\.py" does not resolve/)
  })

  test("accepts a directory import resolved through index.ts", () => {
    const files = good()
    files.set("src/index.ts", 'import x from "./sources"\n')
    expect(checkPackage(files)).toEqual([])
  })

  test("flags a package without any src files", () => {
    const files = new Map([...good()].filter(([name]) => !name.startsWith("src/")))
    expect(checkPackage(files).join("\n")).toMatch(/no src\/ files/)
  })
})

// tests/unit/pack-smoke.test.mjs
// The packaging smoke test's pure checker (scripts/pack-smoke.mjs): the
// tarball's file set against design §12, the exports map, and the relative
// imports inside the packaged sources. The "./tui" half ships as a
// precompiled dist/ artifact (OpenCode's Solid JSX loader skips node_modules
// paths, so the published raw-TSX entry cannot load); the checker pins that
// contract: the artifact is present, exports["./tui"] points at it, it
// imports no react, and its relative imports resolve inside the package.
import { describe, expect, test } from "vitest"
import { checkPackage } from "../../scripts/pack-smoke.mjs"

const good = () =>
  new Map([
    [
      "package.json",
      JSON.stringify({ exports: { ".": "./src/index.ts", "./tui": "./dist/tui.js" } }),
    ],
    ["LICENSE", "GPL"],
    ["README.md", "# readme"],
    ["vendor/model_compare.py", "print()"],
    ["vendor/UPSTREAM.json", "{}"],
    ["src/index.ts", 'import { a } from "./core/a"\nimport x from "./sources"\n'],
    ["src/core/a.ts", "export const a = 1"],
    ["src/opencode/usebest.ts", "export const statusLine = () => ''"],
    // The raw TUI source ships alongside its artifact (the repo's dev path
    // loads src/ directly); only the export must point at dist/.
    ["src/tui.tsx", 'import { statusLine } from "./opencode/usebest"\n'],
    [
      "src/sources/index.ts",
      'export const SCRIPT = new URL("../../vendor/model_compare.py", import.meta.url)\n',
    ],
    [
      // The compiled TUI entry: Solid runtime helpers, no react, relative
      // imports rebased into src/.
      "dist/tui.js",
      'import { createComponent as _$createComponent } from "@opentui/solid";\nimport { statusLine } from "../src/opencode/usebest";\n',
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

  test("flags a missing TUI artifact", () => {
    const files = good()
    files.delete("dist/tui.js")
    expect(checkPackage(files).join("\n")).toContain("missing from the package: dist/tui.js")
  })

  test("flags a stray second dist/ file", () => {
    const files = good()
    files.set("dist/tui.js.map", "{}")
    expect(checkPackage(files)).toEqual(["unexpected file in the package: dist/tui.js.map"])
  })

  test("flags exports[\"./tui\"] that is not in the package", () => {
    const files = good()
    files.set("package.json", JSON.stringify({ exports: { ".": "./src/index.ts", "./tui": "./dist/gone.js" } }))
    expect(checkPackage(files).join("\n")).toMatch(/exports\["\.\/tui"\] points at \.\/dist\/gone\.js/)
  })

  test("flags exports[\"./tui\"] pointing at the raw TSX source", () => {
    const files = good()
    files.set("package.json", JSON.stringify({ exports: { ".": "./src/index.ts", "./tui": "./src/tui.tsx" } }))
    expect(checkPackage(files).join("\n")).toMatch(/exports\["\.\/tui"\] points at \.\/src\/tui\.tsx, which is the raw TSX source/)
  })

  test("flags a TUI artifact that imports react", () => {
    const files = good()
    files.set(
      "dist/tui.js",
      'import { jsx } from "react/jsx-runtime";\nimport { statusLine } from "../src/opencode/usebest";\n',
    )
    expect(checkPackage(files).join("\n")).toMatch(/dist\/tui\.js: TUI artifact imports "react\/jsx-runtime"/)
  })

  test("flags a TUI artifact that does not parse as JavaScript", () => {
    // The regex scans cannot see a corrupted banner or a truncated write;
    // the shipped dist/ file must survive a real syntax check.
    const files = good()
    files.set(
      "dist/tui.js",
      'import { statusLine } from "../src/opencode/usebest";\nthis is not javascript {{{\n',
    )
    expect(checkPackage(files).join("\n")).toMatch(/dist\/tui\.js: does not parse as JavaScript/)
  })

  test("flags a TUI artifact relative import with backtick quoting that does not resolve", () => {
    const files = good()
    files.set(
      "dist/tui.js",
      'import { statusLine } from "../src/opencode/usebest";\nconst lazy = import(`../src/gone`);\n',
    )
    expect(checkPackage(files).join("\n")).toMatch(/dist\/tui\.js: import "\.\.\/src\/gone" does not resolve/)
  })

  test("flags a TUI artifact that requires react", () => {
    const files = good()
    files.set(
      "dist/tui.js",
      'const react = require("react");\nimport { statusLine } from "../src/opencode/usebest";\n',
    )
    expect(checkPackage(files).join("\n")).toMatch(/dist\/tui\.js: TUI artifact imports "react"/)
  })

  test("flags a TUI artifact that imports react-dom", () => {
    const files = good()
    files.set(
      "dist/tui.js",
      'import { jsx } from "react-dom/jsx-runtime";\nimport { statusLine } from "../src/opencode/usebest";\n',
    )
    expect(checkPackage(files).join("\n")).toMatch(/dist\/tui\.js: TUI artifact imports "react-dom\/jsx-runtime"/)
  })

  test('flags exports["./tui"] as a conditions object', () => {
    // Bun — the actual host — selects the "bun" condition, so a conditions
    // object could smuggle raw TSX past the string-based dist/ prefix rule.
    const files = good()
    files.set(
      "package.json",
      JSON.stringify({
        exports: { ".": "./src/index.ts", "./tui": { bun: "./src/tui.tsx", default: "./dist/tui.js" } },
      }),
    )
    expect(checkPackage(files).join("\n")).toMatch(/exports\["\.\/tui"\] must be a string entry/)
  })

  test("flags a TUI artifact relative import that does not resolve", () => {
    const files = good()
    files.delete("src/opencode/usebest.ts")
    expect(checkPackage(files).join("\n")).toMatch(/dist\/tui\.js: import "\.\.\/src\/opencode\/usebest" does not resolve/)
  })
})

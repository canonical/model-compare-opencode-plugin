// tests/unit/pack-smoke.test.mjs
// The packaging smoke test's pure checker (scripts/pack-smoke.mjs): the
// tarball's file set against design §12, the exports map, and the relative
// imports inside the packaged sources. The "./tui" half ships as a
// precompiled dist/ artifact (OpenCode's Solid JSX loader skips node_modules
// paths, so the published raw-TSX entry cannot load); the checker pins that
// contract: the artifact is present, exports["./tui"] points at it, it
// imports no react, and its relative imports resolve inside the package.
import { describe, expect, test } from "vitest"
import { checkPackage, normalizePackOutput } from "../../scripts/pack-smoke.mjs"

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

  test.each([
    ["dependencies", { "@opencode/plugin": "2.3.0" }],
    ["peerDependencies", { "@opentui/core": "^0.8.4" }],
    ["peerDependenciesMeta", { "@opentui/core": { optional: true } }],
    ["optionalDependencies", { fsevents: "^2.3.0" }],
    ["bundleDependencies", ["@opencode/plugin"]],
    ["bundledDependencies", []],
    ["overrides", { seroval: "^1.7.3" }],
    ["dependencies", {}],
    ["peerDependencies", null],
  ])("flags %s in package.json (%j)", (field, value) => {
    const files = good()
    files.set(
      "package.json",
      JSON.stringify({ exports: { ".": "./src/index.ts", "./tui": "./dist/tui.js" }, [field]: value }),
    )
    expect(checkPackage(files)).toEqual([
      `package.json must not declare "${field}" (host provides runtime modules; keep build/test packages in devDependencies)`,
    ])
  })

  test.each(["null", "[]", "123", "true", '"str"'])("flags non-object package.json (%s)", (raw) => {
    const files = good()
    files.set("package.json", raw)
    expect(checkPackage(files)).toEqual(["package.json is missing or not a JSON object"])
  })

  test("flags missing package.json cleanly without throwing", () => {
    const files = good()
    files.delete("package.json")
    expect(checkPackage(files)).toEqual([
      "missing from the package: package.json",
      "package.json is missing or not a JSON object",
    ])
  })

  test("allows devDependencies in package.json", () => {
    const files = good()
    files.set(
      "package.json",
      JSON.stringify({
        exports: { ".": "./src/index.ts", "./tui": "./dist/tui.js" },
        devDependencies: { "@opencode/plugin": "2.3.0", vitest: "^4.1.12" },
      }),
    )
    expect(checkPackage(files)).toEqual([])
  })

  test.each([
    "src/smuggled.js",
    "src/smuggled.mjs",
    "src/smuggled.cjs",
    "src/ui.jsx",
    "src/extra.tsx",
    "src/package.json",
    "src/core/package.json",
  ])("flags unexpected non-TS or nested manifest file under src/ (%s)", (stray) => {
    const files = good()
    files.set(stray, stray.endsWith(".json") ? "{}" : "export const x = 1\n")
    expect(checkPackage(files)).toEqual([`unexpected file in the package: ${stray}`])
  })

  test("scans stray src/*.js files as defense-in-depth alongside unexpected-file check", () => {
    const files = good()
    files.set("src/smuggled.js", 'import pc from "picocolors"\nexport const x = pc\n')
    expect(checkPackage(files)).toEqual([
      "unexpected file in the package: src/smuggled.js",
      'src/smuggled.js: runtime bare import "picocolors" is not provided by Node or the OpenCode host',
    ])
  })

  test.each([
    ["src/index.ts", 'import { generateSyntax } from "@opencode/theme/tui"\n', "@opencode/theme/tui"],
    ["src/index.ts", 'import pc from "picocolors"\n', "picocolors"],
    ["src/index.ts", 'import * as pc from "picocolors"\n', "picocolors"],
    ["src/index.ts", 'import { createSignal } from "solid-js"\n', "solid-js"],
    ["src/index.ts", 'import { RGBA } from "@opentui/core"\n', "@opentui/core"],
    ["src/index.ts", 'import { Plugin } from "@opencode/plugin/tui"\n', "@opencode/plugin/tui"],
    ["src/index.ts", 'import { x } from "@opencode/plugin/gui"\n', "@opencode/plugin/gui"],
    ["src/index.ts", 'import { ensurePluginRuntime } from "@opencode/plugin/runtime"\n', "@opencode/plugin/runtime"],
    ["src/index.ts", 'import { Artifact } from "@opencode/plugin/promise/artifact"\n', "@opencode/plugin/promise/artifact"],
    ["src/tui.tsx", 'import { x } from "@opencode/plugin/gui"\n', "@opencode/plugin/gui"],
    ["src/tui.tsx", 'import { Artifact } from "@opencode/plugin/promise/artifact"\n', "@opencode/plugin/promise/artifact"],
    ["src/tui.tsx", 'import { createStore } from "solid-js/store"\n', "solid-js/store"],
    ["src/index.ts", 'import { type Mock, vi } from "vitest"\n', "vitest"],
    ["src/index.ts", 'import Default, { type Mock } from "vitest"\n', "vitest"],
    ["src/index.ts", 'import "picocolors"\n', "picocolors"],
    ["src/index.ts", 'import {} from "picocolors"\n', "picocolors"],
    ["src/index.ts", 'export { foo } from "picocolors"\n', "picocolors"],
    ["src/index.ts", 'export {} from "picocolors"\n', "picocolors"],
    ["src/index.ts", 'export * from "picocolors"\n', "picocolors"],
    ["src/index.ts", 'export * as pc from "picocolors"\n', "picocolors"],
    ["src/index.ts", 'const m = import("picocolors", { with: { type: "json" } })\n', "picocolors"],
    ["src/index.ts", 'const m = require("picocolors")\n', "picocolors"],
    ["src/index.ts", 'const m = require?.("picocolors")\n', "picocolors"],
    ["src/index.ts", 'import m = require("picocolors")\n', "picocolors"],
    ["src/index.ts", 'import { createRequire } from "node:module"\nexport { createRequire }\n', "node:module"],
    ["src/index.ts", 'import { DatabaseSync } from "node:sqlite"\n', "node:sqlite"],
    ["src/index.ts", 'import { getAsset } from "node:sea"\n', "node:sea"],
    ["src/index.ts", 'import { spec } from "node:test/reporters"\n', "node:test/reporters"],
    ["src/index.ts", 'import fs from "fs"\n', "fs"],
    ["dist/tui.js", 'import { generateSyntax } from "@opencode/theme/tui";\nimport { statusLine } from "../src/opencode/usebest";\n', "@opencode/theme/tui"],
    ["dist/tui.js", 'import { createTestRenderer } from "@opentui/core/testing";\nimport { statusLine } from "../src/opencode/usebest";\n', "@opentui/core/testing"],
    ["dist/tui.js", 'import { render } from "solid-js/web";\nimport { statusLine } from "../src/opencode/usebest";\n', "solid-js/web"],
  ])("flags unprovided runtime bare import %s -> %s", (file, source, specifier) => {
    const files = good()
    files.set(file, source)
    expect(checkPackage(files)).toEqual([
      `${file}: runtime bare import "${specifier}" is not provided by Node or the OpenCode host`,
    ])
  })

  test("flags two-step createRequire from node:module", () => {
    const files = good()
    files.set(
      "src/index.ts",
      'import { createRequire } from "node:module"\nconst req = createRequire(import.meta.url)\nconst pc = req("picocolors")\nexport { pc }\n',
    )
    const problems = checkPackage(files)
    expect(problems).toContain(
      'src/index.ts: runtime bare import "node:module" is not provided by Node or the OpenCode host',
    )
    expect(problems.some((p) => p.includes("createRequire"))).toBe(true)
  })

  test.each([
    [
      "src/index.ts",
      'declare const Module: { createRequire: (u: string) => NodeRequire }\nconst pc = Module.createRequire(import.meta.url)("picocolors")\nexport { pc }\n',
      /createRequire/,
    ],
    [
      "src/tui.tsx",
      'declare const createRequire: (u: string) => NodeRequire\nconst s = createRequire(import.meta.url)("solid-js")\nexport default s\n',
      /createRequire/,
    ],
    [
      "src/index.ts",
      'declare const createRequire: ((u: string) => NodeRequire) | undefined\nconst m = createRequire?.(import.meta.url)?.("picocolors")\nexport { m }\n',
      /createRequire/,
    ],
    [
      "src/index.ts",
      'const s = process.getBuiltinModule("node:sqlite")\nexport { s }\n',
      /getBuiltinModule/,
    ],
    [
      "src/index.ts",
      'const s = (process as unknown as { getBuiltinModule?: (id: string) => unknown })?.getBuiltinModule?.("node:sqlite")\nexport { s }\n',
      /getBuiltinModule/,
    ],
  ])("flags forbidden dynamic loader escape %s", (file, source, pattern) => {
    const files = good()
    files.set(file, source)
    const problems = checkPackage(files)
    expect(problems).toHaveLength(1)
    expect(problems[0]).toMatch(pattern)
  })

  test.each([
    ["src/index.ts", 'import { statusLine } from "./tui.tsx"\nexport { statusLine }\n', "src/tui.tsx"],
    ["src/index.ts", 'import { statusLine } from "../dist/tui.js"\nexport { statusLine }\n', "dist/tui.js"],
  ])("flags cross-domain server-to-TUI relative runtime import (%s -> %s)", (file, source, target) => {
    const files = good()
    files.set(file, source)
    expect(checkPackage(files)).toEqual([
      `${file}: server/shared module must not runtime-import TUI module "${target}"`,
    ])
  })

  test("flags dist/tui.js importing raw JSX source in src/", () => {
    const files = good()
    files.set("dist/tui.js", 'import rawTui from "../src/tui.tsx";\nexport default rawTui;\n')
    expect(checkPackage(files)).toEqual([
      'dist/tui.js: precompiled TUI artifact must not import raw JSX source "src/tui.tsx"',
    ])
  })

  test.each([
    ["src/index.ts", 'const pkg = "picocolors"\nawait import(pkg)\n'],
    ["src/tui.tsx", "const s = await import(`solid-js`)\n"],
    ["dist/tui.js", 'const s = import(`solid-js`);\nimport { statusLine } from "../src/opencode/usebest";\n'],
    ["src/index.ts", "const x = 'a'\nconst m = await import(`./${x}`)\nexport { m }\n"],
  ])("flags dynamic or template-literal runtime import in %s with a single diagnostic", (file, source) => {
    const files = good()
    files.set(file, source)
    expect(checkPackage(files)).toEqual([
      `${file}: dynamic or template-literal runtime import is not supported`,
    ])
  })

  test.each([
    'import type { Gone } from "./gone"\nexport type { Gone }\n',
    'import { type Gone } from "./gone"\nexport type { Gone }\n',
    'export type { Gone } from "./gone"\n',
    'export { type Gone } from "./gone"\n',
    'export type * from "./gone"\n',
    'export type T = import("./gone").Gone\n',
    'import type Gone = require("./gone")\nexport type { Gone }\n',
  ])("flags broken type-only relative specifier (%j)", (source) => {
    const files = good()
    files.set("src/index.ts", source)
    expect(checkPackage(files)).toEqual(['src/index.ts: import "./gone" does not resolve inside the package'])
  })

  test("flags broken backtick relative URL(..., import.meta.url) on the AST", () => {
    const files = good()
    files.set(
      "src/sources/index.ts",
      "export const SCRIPT = new URL(`../../vendor/gone.py`, import.meta.url)\n",
    )
    expect(checkPackage(files)).toEqual([
      'src/sources/index.ts: URL "../../vendor/gone.py" does not resolve inside the package',
    ])
  })

  test.each([
    ["src/tui.tsx", "const m = await import(`./opencode/usebest`)\nexport default m\n", "./opencode/usebest"],
    ["dist/tui.js", "const m = import(`../src/opencode/usebest`);\nexport default m;\n", "../src/opencode/usebest"],
  ])("flags resolved extensionless template-literal relative import in TUI domain (%s)", (file, source, specifier) => {
    const files = good()
    files.set(file, source)
    expect(checkPackage(files)).toEqual([
      `${file}: template-literal relative import "${specifier}" is not prescanned by OpenTUI's runtime loader`,
    ])
  })

  test("allows .js-suffixed template-literal relative import in TUI domain", () => {
    const files = good()
    files.set("src/tui.tsx", "const m = await import(`../dist/tui.js`)\nexport default m\n")
    expect(checkPackage(files)).toEqual([])
  })

  test.each([
    ["src/tui.tsx", 'const s = require("solid-js")\nexport default s\n', "solid-js"],
    ["src/tui.tsx", 'import s = require("solid-js")\nexport default s\n', "solid-js"],
    ["dist/tui.js", 'const s = require("solid-js");\nimport { statusLine } from "../src/opencode/usebest";\nexport default s;\n', "solid-js"],
  ])("flags synchronous require() of OpenTUI virtual module in %s", (file, source) => {
    const files = good()
    files.set(file, source)
    const problems = checkPackage(files)
    expect(problems).toHaveLength(1)
    expect(problems[0]).toMatch(/require/)
  })

  test.each([
    ["src/tui.tsx", 'import{createSignal}from"solid-js"\nexport default createSignal\n', "solid-js"],
    ["src/tui.tsx", 'import { createSignal } from /* c */ "solid-js"\nexport default createSignal\n', "solid-js"],
    ["src/tui.tsx", 'const s = import("solid-js",)\nexport default s\n', "solid-js"],
    ["src/tui.tsx", 'const s = import("solid-js", { with: { type: "json" } })\nexport default s\n', "solid-js"],
    ["dist/tui.js", 'import{createSignal}from"solid-js";\nimport { statusLine } from "../src/opencode/usebest";\nexport default createSignal;\n', "solid-js"],
    ["dist/tui.js", 'const s = import("solid-js",);\nimport { statusLine } from "../src/opencode/usebest";\nexport default s;\n', "solid-js"],
  ])("flags unrewritable TUI host import syntax in %s", (file, source, specifier) => {
    const files = good()
    files.set(file, source)
    expect(checkPackage(files)).toEqual([
      `${file}: TUI host import "${specifier}" uses syntax OpenTUI's runtime rewriter cannot rewrite`,
    ])
  })

  test("emits exactly one diagnostic when dist/tui.js imports react", () => {
    const files = good()
    files.set(
      "dist/tui.js",
      'import { jsx } from "react/jsx-runtime";\nimport { statusLine } from "../src/opencode/usebest";\n',
    )
    expect(checkPackage(files)).toEqual([
      'dist/tui.js: TUI artifact imports "react/jsx-runtime" — rebuild it with scripts/build-tui.mjs (raw JSX cannot load from node_modules)',
    ])
  })

  test("reports unparseable TypeScript in src/ without throwing", () => {
    const files = good()
    files.set("src/index.ts", "export const broken = {{{\n")
    const problems = checkPackage(files)
    expect(problems).toHaveLength(1)
    expect(problems[0]).toMatch(/^src\/index\.ts: does not parse/)
  })

  test("allows domain-scoped host imports, type-only forms, .ts angle-bracket assertions, and comment/string prose", () => {
    const files = good()
    files.set(
      "src/index.ts",
      [
        '// derived from "default_effort" and from "./nonexistent"',
        'const prose = \'import "./also-nonexistent" and new URL("./fake", import.meta.url)\'',
        'import { execFile } from "node:child_process"',
        'import { Plugin } from "@opencode/plugin"',
        'import { Rpc } from "@opencode/plugin/rpc"',
        'import type { createRequire } from "node:module"',
        'import type { Theme } from "@opencode/theme"',
        'import type { strWidth } from "./tui.tsx"',
        'import { type Mock } from "vitest"',
        'export type * from "vitest"',
        'export { type Mock } from "vitest"',
        'import readme from "../README.md"',
        'import { a } from "./core/a"',
        'const cast = <string>("ok" as unknown)',
        "export { prose, readme, cast, execFile, Plugin, Rpc, a }",
      ].join("\n"),
    )
    files.set(
      "src/tui.tsx",
      [
        '// helper imported from "./opencode/usebest"',
        'import { Plugin } from "@opencode/plugin/tui"',
        'import type { KeymapCommand } from "@opencode/plugin/tui/context"',
        'import { RGBA } from "@opentui/core"',
        'import { createComponent } from "@opentui/solid"',
        'import { Box } from "@opentui/solid/components"',
        'import { jsx } from "@opentui/solid/jsx-runtime"',
        'import { jsxDEV } from "@opentui/solid/jsx-dev-runtime"',
        'import { createSignal } from "solid-js"',
        'import { statusLine } from "./opencode/usebest"',
        "export default { Plugin, RGBA, createComponent, Box, jsx, jsxDEV, createSignal, statusLine }",
      ].join("\n"),
    )
    files.set(
      "dist/tui.js",
      [
        '// helper imported from "./opencode/usebest" (preserved comment from src/tui.tsx)',
        'import { Plugin as P0 } from "@opencode/plugin";',
        'import { Rpc } from "@opencode/plugin/rpc";',
        'import { Plugin } from "@opencode/plugin/tui";',
        'import { RGBA } from "@opentui/core";',
        'import { createComponent } from "@opentui/solid";',
        'import { Box } from "@opentui/solid/components";',
        'import { jsx } from "@opentui/solid/jsx-runtime";',
        'import { jsxDEV } from "@opentui/solid/jsx-dev-runtime";',
        'import { createSignal } from "solid-js";',
        'import { statusLine } from "../src/opencode/usebest";',
        "export default { P0, Rpc, Plugin, RGBA, createComponent, Box, jsx, jsxDEV, createSignal, statusLine };",
      ].join("\n"),
    )
    expect(checkPackage(files)).toEqual([])
  })
})

describe("normalizePackOutput", () => {
  // npm <= 11 prints an array of tarball contents.
  test("reads the npm 10/11 array shape", () => {
    const parsed = [{ filename: "pkg-0.1.1.tgz", name: "pkg" }]
    expect(normalizePackOutput(parsed, "pkg").filename).toBe("pkg-0.1.1.tgz")
  })

  // npm >= 12 buffers one object keyed by the package name (utils/tar.js
  // logTar: output.buffer({ [key]: tarball })).
  test("reads the npm 12 object-keyed-by-package-name shape", () => {
    const parsed = { pkg: { filename: "pkg-0.1.1.tgz", name: "pkg" } }
    expect(normalizePackOutput(parsed, "pkg").filename).toBe("pkg-0.1.1.tgz")
  })

  test("falls back to the sole entry of a keyed object", () => {
    const parsed = { something: { filename: "pkg-0.1.1.tgz" } }
    expect(normalizePackOutput(parsed, "pkg").filename).toBe("pkg-0.1.1.tgz")
  })

  test("throws a clear error on an unrecognizable shape", () => {
    expect(() => normalizePackOutput({}, "pkg")).toThrow(/unrecognizable npm pack --json output/)
    expect(() => normalizePackOutput([], "pkg")).toThrow(/unrecognizable npm pack --json output/)
  })
})

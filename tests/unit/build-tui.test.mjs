// tests/unit/build-tui.test.mjs — scripts/build-tui.mjs, the precompile step
// for the published TUI entry (design: the "./tui" artifact).
//
// Why this exists: OpenCode's TUI host compiles plugin JSX through OpenTUI's
// Solid Bun plugin, whose loader filter skips every file under a node_modules
// directory. The npm-installed package lives under one, so its raw-TSX
// "./tui" export is left to Bun's default JSX transform, which imports
// react/jsx-runtime — react is not installed (this is a Solid plugin), and
// the TUI half fails to load with "Cannot find package 'react'". Local
// directory targets ("./src") are not under node_modules and load the raw
// TSX fine; only the published package needs a precompiled artifact.
//
// The artifact must therefore: compile JSX to the OpenTUI Solid runtime
// (no react reference anywhere), strip type-only imports, keep bare imports
// (solid-js, @opencode/plugin/tui) untouched, and point every relative
// import back into the package's src/ (dist/tui.js sits one level below).
import { describe, expect, test } from "vitest"
import path from "node:path"
import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { fileURLToPath } from "node:url"
import { buildTuiArtifact, BANNER } from "../../scripts/build-tui.mjs"

// A minimal stand-in for src/tui.tsx exercising each requirement: a JSX
// render, a type-only import, a bare runtime import, and one relative
// runtime import.
const minimal = [
  'import { Plugin } from "@opencode/plugin/tui"',
  'import type { JSX } from "@opentui/solid"',
  'import { createSignal } from "solid-js"',
  'import { statusLine } from "./opencode/usebest"',
  "export default Plugin.define({",
  '  id: "t",',
  "  setup(context) {",
  "    const [count] = createSignal(0)",
  '    context.ui.slot({ append: "prompt.footer.status", render: () => <text fg={context.theme.text.base}>{`${statusLine()} ${count()}`}</text> })',
  "  },",
  "})",
].join("\n")

describe("buildTuiArtifact", () => {
  test("compiles JSX to the OpenTUI Solid runtime, with no react import", async () => {
    const { code } = await buildTuiArtifact(minimal)
    expect(code).toContain('from "@opentui/solid"')
    expect(code).not.toContain("react/jsx-runtime")
    expect(code).not.toMatch(/from\s*["']react["']/)
  })

  test("rewrites relative imports to the package src/", async () => {
    const { code } = await buildTuiArtifact(minimal)
    expect(code).toContain('from "../src/opencode/usebest"')
    expect(code).not.toContain('from "./opencode/usebest"')
  })

  test("leaves bare imports alone", async () => {
    const { code } = await buildTuiArtifact(minimal)
    expect(code).toContain('from "solid-js"')
    expect(code).toContain('from "@opencode/plugin/tui"')
  })

  test("strips type-only imports", async () => {
    const { code } = await buildTuiArtifact(minimal)
    expect(code).not.toMatch(/import\s+type\b/)
  })

  test("the real src/tui.tsx compiles clean", async () => {
    const source = readFileSync(new URL("../../src/tui.tsx", import.meta.url), "utf8")
    const { code } = await buildTuiArtifact(source)
    expect(code).not.toContain("react/jsx-runtime")
    expect(code).not.toMatch(/from\s*["']react["']/)
    expect(code).toContain('from "@opentui/solid"')
    // Every relative import points back into src/: dist/tui.js sits one
    // level below the package root, src/ beside it.
    for (const match of code.matchAll(/(?:from|import)\s*\(?\s*["'](\.{1,2}\/[^"']+)["']/g)) {
      expect(match[1]).toMatch(/^\.\.\/src\//)
    }
  })

  test("leaves strings and comments alone (AST-based rebasing)", async () => {
    // String literals and comments that merely LOOK like imports must not be
    // rewritten: the rebaser works on the AST, not on raw text patterns.
    const source = [
      'import { real } from "./real"',
      'const msg = \'import "./old" is fine\'',
      '// written from "./commented" to the dist-relative spelling',
      "export default { real, msg }",
    ].join("\n")
    const { code } = await buildTuiArtifact(source)
    expect(code).toContain('from "../src/real"')
    expect(code).not.toContain("../src/old")
    expect(code).not.toContain("../src/commented")
  })

  test("rebases dynamic import() with a backtick specifier", async () => {
    const source = ["const lazy = import(`./dyn`)", "export default lazy"].join("\n")
    const { code } = await buildTuiArtifact(source)
    expect(code).toContain("../src/dyn")
  })

  test("rebases require() specifiers", async () => {
    const source = ['const m = require("./reqmod")', "export default m"].join("\n")
    const { code } = await buildTuiArtifact(source)
    expect(code).toContain("../src/reqmod")
  })

  test("is deterministic: two runs produce the same artifact", async () => {
    const source = readFileSync(new URL("../../src/tui.tsx", import.meta.url), "utf8")
    const first = await buildTuiArtifact(source)
    const second = await buildTuiArtifact(source)
    expect(second.code).toBe(first.code)
  })

  test("the artifact parses as ESM (no replacer corruption)", async () => {
    // A full syntax check, not a substring match: a broken import rewrite
    // (e.g. stray digits after the closing quote) must fail the build, and a
    // toContain assertion alone cannot see it. `node --check` parses .mjs as
    // a module without evaluating it. The check runs over BANNER + code +
    // trailing newline — exactly what main() writes to dist/tui.js — so a
    // banner corrupted into invalid JS fails here too.
    const source = readFileSync(new URL("../../src/tui.tsx", import.meta.url), "utf8")
    const { code } = await buildTuiArtifact(source)
    const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs")
    const { tmpdir } = await import("node:os")
    const { execFileSync } = await import("node:child_process")
    const dir = mkdtempSync(path.join(tmpdir(), "build-tui-parse-"))
    try {
      const file = path.join(dir, "tui.mjs")
      writeFileSync(file, BANNER + code + "\n")
      execFileSync("node", ["--check", file], { stdio: "pipe" })
      expect(true).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("runs main() when invoked through a symlinked path (no silent no-op)", () => {
    // Node realpaths import.meta.url but keeps argv[1]'s spelling, so a naive
    // `import.meta.url === pathToFileURL(process.argv[1]).href` guard skips
    // main() silently (exit 0, no output) whenever the script path contains a
    // symlink — `npm run build` would appear to succeed without building.
    const dir = mkdtempSync(path.join(tmpdir(), "build-tui-symlink-"))
    try {
      const target = fileURLToPath(new URL("../../scripts/build-tui.mjs", import.meta.url))
      const link = path.join(dir, "build-tui.mjs")
      symlinkSync(target, link)
      const out = execFileSync("node", [link], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      })
      expect(out).toContain("build-tui ok")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

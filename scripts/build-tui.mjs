// scripts/build-tui.mjs — precompile the TUI entry (src/tui.tsx) into the
// plain-JS artifact the published package ships as its "./tui" export
// (dist/tui.js).
//
// Why this build step exists: OpenCode's TUI host compiles plugin JSX through
// OpenTUI's Solid Bun plugin, whose loader filter skips every file under a
// node_modules directory. An npm-installed plugin always lives under one, so
// the published package's raw-TSX "./tui" export is left to Bun's default JSX
// transform — which imports react/jsx-runtime and fails ("Cannot find package
// 'react'"): this plugin is Solid-based, and nothing in its tree provides
// react. Local directory targets ("./src") are not under node_modules, so the
// raw TSX keeps working for in-repo development; only the published package
// needs this artifact.
//
// The transform is the SAME Babel pipeline the host runs (babel-preset-solid
// with generate "universal" and moduleName "@opentui/solid", plus the
// TypeScript preset), taken from the pinned @opentui/solid so the artifact
// stays in lockstep with the loader that will import it. The module is not on
// the package's exports map, so it is resolved from the package root by file
// path; if upstream moves it, this fails loudly rather than emitting output
// from a different transform.
//
// dist/tui.js sits one level below the package root with src/ beside it, so
// every relative import is rebased from src/-relative ("./opencode/usebest")
// to dist-relative ("../src/opencode/usebest"). Bare imports (solid-js,
// @opentui/*, @opencode/plugin/tui) resolve against the installed tree and
// are left untouched — at load time the TUI host's runtime-module rewriting
// maps those bare runtime specifiers to the host-provided modules, the same
// as for locally loaded plugin sources.
//
// Usage: node scripts/build-tui.mjs   (from the repository root; also run by
// `npm run build` and, through it, by prepublishOnly on every publish)

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { createRequire } from "node:module"
import { fileURLToPath, pathToFileURL } from "node:url"
import { invokedDirectly } from "./lib/invoked-directly.mjs"

// -> Promise<{ transformSolidSource: (code: string, options: object) => Promise<string> }>
async function loadSolidTransform() {
  const require = createRequire(import.meta.url)
  const index = require.resolve("@opentui/solid") // …/node_modules/@opentui/solid/index.js
  const transform = path.resolve(path.dirname(index), "scripts", "solid-transform.js")
  if (!existsSync(transform)) {
    throw new Error(
      `@opentui/solid no longer ships scripts/solid-transform.js (looked next to ${index}); ` +
        "update scripts/build-tui.mjs to the new transform surface",
    )
  }
  return import(pathToFileURL(transform).href)
}

// src/-relative → dist/-relative: both specifiers resolve the same file in
// the shipped layout. Virtual absolute prefixes keep the arithmetic honest
// regardless of the repository's real location.
const SRC_ROOT = "/src"
const DIST_ROOT = "/dist"
function rebaseSpecifier(specifier) {
  const target = path.posix.normalize(path.posix.join(SRC_ROOT, specifier))
  return path.posix.relative(DIST_ROOT, target)
}

// Rebasing is AST-based, not text-based: the compiled module is parsed with
// @babel/parser and every relative specifier is rewritten at its exact
// source range, so comments and string literals that merely LOOK like
// imports (text such as: import "./old") are left alone by construction.
// Covered shapes: import declarations, export-from declarations, and dynamic
// import() / require() calls whose argument is a string literal or an
// expression-less template literal. Dynamic imports with interpolated
// specifiers cannot be rebased — do not use them for relative modules.

// -> Promise<(code: string, options: object) => AST> — @babel/parser from the
// transform's own dependency tree (resolved THROUGH the pinned @opentui/solid
// so no npm dependency is added); if it ever stops resolving, this fails
// loudly instead of falling back to text rewriting.
let babelParserPromise = null
function loadBabelParser() {
  babelParserPromise ??= (async () => {
    const require = createRequire(import.meta.url)
    const solidEntry = require.resolve("@opentui/solid")
    let parserPath
    try {
      parserPath = createRequire(solidEntry).resolve("@babel/parser")
    } catch {
      throw new Error(
        `@babel/parser is not resolvable from @opentui/solid (${solidEntry}); ` +
          "scripts/build-tui.mjs needs it to rebase the compiled module's import specifiers",
      )
    }
    const loaded = await import(pathToFileURL(parserPath).href)
    return loaded.parse ?? loaded.default.parse
  })()
  return babelParserPromise
}

const NON_AST_KEYS = new Set([
  "loc",
  "extra",
  "comments",
  "leadingComments",
  "trailingComments",
  "innerComments",
  "tokens",
])

function walkAst(node, visit) {
  if (Array.isArray(node)) {
    for (const item of node) walkAst(item, visit)
    return
  }
  if (node === null || typeof node !== "object" || typeof node.type !== "string") return
  visit(node)
  for (const [key, value] of Object.entries(node)) {
    if (!NON_AST_KEYS.has(key)) walkAst(value, visit)
  }
}

// -> [start, end, replacement] | null — the interior range of a specifier
// argument (between its one-character delimiters) plus the rebased text.
function relativeSpecifierEdit(argument) {
  if (!argument) return null
  let value
  if (argument.type === "StringLiteral") {
    value = argument.value
  } else if (argument.type === "TemplateLiteral" && argument.expressions.length === 0 && argument.quasis.length === 1) {
    value = argument.quasis[0].value.cooked
    if (typeof value !== "string") return null // cooked is null for invalid escapes
  } else {
    return null // interpolated or non-literal specifiers cannot be rebased
  }
  if (!value.startsWith("./") && !value.startsWith("../")) return null
  return [argument.start + 1, argument.end - 1, rebaseSpecifier(value)]
}

function collectRelativeSpecifierEdits(ast) {
  const edits = []
  const record = (argument) => {
    const edit = relativeSpecifierEdit(argument)
    if (edit) edits.push(edit)
  }
  walkAst(ast, (node) => {
    switch (node.type) {
      case "ImportDeclaration":
      case "ExportAllDeclaration":
      case "ExportNamedDeclaration":
        record(node.source)
        break
      case "ImportExpression": // import("…") when the parser builds it
        record(node.source)
        break
      case "CallExpression": {
        // import("…") (parser default: callee node of type "Import") and
        // require("…") — only with a single specifier argument.
        const isDynamicImport = node.callee.type === "Import" && node.arguments.length === 1
        const isRequire = node.callee.type === "Identifier" && node.callee.name === "require" && node.arguments.length === 1
        if (isDynamicImport || isRequire) record(node.arguments[0])
        break
      }
    }
  })
  return edits
}

async function rebaseRelativeImports(code) {
  const parse = await loadBabelParser()
  const ast = parse(code, { sourceType: "module" })
  let rebased = code
  // Splice back-to-front so earlier ranges stay valid.
  for (const [start, end, replacement] of collectRelativeSpecifierEdits(ast).sort((a, b) => b[0] - a[0])) {
    rebased = rebased.slice(0, start) + replacement + rebased.slice(end)
  }
  return rebased
}

// -> { code: string } — the artifact body, without any file banner.
export async function buildTuiArtifact(source, { sourceFile = "src/tui.tsx" } = {}) {
  const { transformSolidSource } = await loadSolidTransform()
  const compiled = await transformSolidSource(source, { filename: sourceFile })
  return { code: await rebaseRelativeImports(compiled) }
}

export const BANNER = `// GENERATED by scripts/build-tui.mjs from src/tui.tsx — do not edit.
// Run \`npm run build\` after changing the source. See the build script's
// header for why the published package ships precompiled JSX.
`

async function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
  const sourcePath = path.join(root, "src", "tui.tsx")
  const { code } = await buildTuiArtifact(readFileSync(sourcePath, "utf8"))
  const artifact = path.join(root, "dist", "tui.js")
  mkdirSync(path.dirname(artifact), { recursive: true })
  writeFileSync(artifact, BANNER + code + "\n")
  console.log(`build-tui ok: ${path.relative(root, sourcePath)} -> ${path.relative(root, artifact)}`)
}

if (invokedDirectly(import.meta.url, process.argv[1])) await main()

// scripts/pack-smoke.mjs — packaging smoke test (design §12, review F-12).
//
// Packs the plugin exactly as `npm publish` would, unpacks the tarball into a
// temp directory and verifies, WITHOUT OpenCode:
//   1. the file set equals the §12 list: package.json, src/**, dist/tui.js,
//      vendor/model_compare.py, vendor/UPSTREAM.json, LICENSE, README.md —
//      nothing from tests/, scripts/, fixtures/, docs/ leaks in and nothing
//      is missing;
//   2. the `exports` map points at files that are in the tarball — with
//      exports["./tui"] required to be the precompiled dist/ artifact, not
//      the raw TSX source (OpenCode's Solid JSX loader skips node_modules
//      paths, so the published raw-TSX entry cannot load);
//   3. every relative import in the packaged TypeScript sources and the
//      dist/ artifact, and the `new URL("…", import.meta.url)` that locates
//      the vendored script, resolves to a file in the tarball;
//   4. the dist/ artifact imports no react — the TUI entry is Solid, and a
//      react import means the artifact was not precompiled;
//   5. package.json is a plain JSON object declaring no install-graph
//      dependency or overrides fields (dependencies, peerDependencies,
//      peerDependenciesMeta, optionalDependencies, bundleDependencies,
//      bundledDependencies, overrides) — OpenCode provides runtime modules in
//      memory, while Arborist and Socket.dev resolve published dependency
//      fields;
//   6. every runtime module specifier in src/ and dist/ resolves either to a
//      packaged relative file or to a StringLiteral matching Node's node:*
//      builtins or that file domain's OpenCode host-provided module set.
//
// Type correctness is `tsc --noEmit`'s job (CI runs it); the typescript
// package at v7 ships no JS API to re-check the unpacked files here.
//
// NOT covered (deferred, spec §12): loading the installed package inside a
// real OpenCode — that needs the opencode binary and credentials, so it stays a
// manual/integration step. `exports` pointing at dist/tui.js is loadable
// plain JS, but only OpenCode itself can confirm it loads.
//
// Usage: node scripts/pack-smoke.mjs   (from the repository root)

import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import path from "node:path"
import { invokedDirectly } from "./lib/invoked-directly.mjs"

// The §12 file list. Only src/**/*.ts and src/tui.tsx are permitted under src/;
// the rest are exact paths.
const EXACT = new Set([
  "package.json",
  "dist/tui.js",
  "vendor/model_compare.py",
  "vendor/UPSTREAM.json",
  "LICENSE",
  "README.md",
])
const PREFIX = "src/"

function isAllowedSrcFile(name) {
  return name === "src/tui.tsx" || /^src\/.+\.ts$/.test(name)
}

function isTuiDomain(name) {
  return name === "src/tui.tsx" || name.startsWith("dist/")
}

const FORBIDDEN_DEP_FIELDS = [
  "dependencies",
  "peerDependencies",
  "peerDependenciesMeta",
  "optionalDependencies",
  "bundleDependencies",
  "bundledDependencies",
  "overrides",
]

// Host virtual modules guaranteed across OpenCode >= 2.2.0:
// - headless server (`ensurePluginRuntime`) provides @opencode/plugin (+ /rpc);
// - TUI (`ensureRuntimePluginSupport` over `@opentui/core/runtime-plugin`) adds
//   @opencode/plugin/tui, @opentui/core, @opentui/solid*, and solid-js.
const SERVER_HOST_SPECIFIERS = new Set(["@opencode/plugin", "@opencode/plugin/rpc"])
const TUI_ONLY_SPECIFIERS = new Set([
  "@opencode/plugin/tui",
  "@opentui/core",
  "@opentui/solid",
  "@opentui/solid/components",
  "@opentui/solid/jsx-runtime",
  "@opentui/solid/jsx-dev-runtime",
  "solid-js",
])
const TUI_HOST_SPECIFIERS = new Set([...SERVER_HOST_SPECIFIERS, ...TUI_ONLY_SPECIFIERS])

// Explicit Node 20.0+ ∩ Bun 1.4+ builtin set (excludes node:module,
// node:sqlite, node:sea, node:test*, node:trace_events, node:sys, and node:_*).
const PORTABLE_NODE_BUILTINS = new Set([
  "node:assert",
  "node:assert/strict",
  "node:async_hooks",
  "node:buffer",
  "node:child_process",
  "node:cluster",
  "node:console",
  "node:constants",
  "node:crypto",
  "node:dgram",
  "node:diagnostics_channel",
  "node:dns",
  "node:dns/promises",
  "node:domain",
  "node:events",
  "node:fs",
  "node:fs/promises",
  "node:http",
  "node:http2",
  "node:https",
  "node:inspector",
  "node:inspector/promises",
  "node:net",
  "node:os",
  "node:path",
  "node:path/posix",
  "node:path/win32",
  "node:perf_hooks",
  "node:process",
  "node:punycode",
  "node:querystring",
  "node:readline",
  "node:readline/promises",
  "node:repl",
  "node:stream",
  "node:stream/consumers",
  "node:stream/promises",
  "node:stream/web",
  "node:string_decoder",
  "node:timers",
  "node:timers/promises",
  "node:tls",
  "node:tty",
  "node:url",
  "node:util",
  "node:util/types",
  "node:v8",
  "node:vm",
  "node:wasi",
  "node:worker_threads",
  "node:zlib",
])

// Mirrors @opentui/core/runtime-plugin.js's ESM rewrite patterns (excluding
// synchronous require(), which fails on OpenTUI's async virtual modules).
const OPENTUI_ESM_REWRITE_PATTERNS = [
  /(from\s+["'])([^"']+)(["'])/g,
  /(import\s+["'])([^"']+)(["'])/g,
  /(import\s*\(\s*["'])([^"']+)(["']\s*\))/g,
]

function isRewritableByOpenTui(source, enclosingNode, argument) {
  if (typeof enclosingNode?.start !== "number" || typeof enclosingNode?.end !== "number") return false
  if (typeof argument?.start !== "number" || typeof argument?.end !== "number") return false
  const slice = source.slice(enclosingNode.start, enclosingNode.end)
  const expectedStart = argument.start - enclosingNode.start + 1
  const expectedEnd = argument.end - enclosingNode.start - 1
  for (const pattern of OPENTUI_ESM_REWRITE_PATTERNS) {
    for (const match of slice.matchAll(pattern)) {
      const prev = slice[(match.index ?? 0) - 1]
      if (prev === '"' || prev === "'" || prev === "`") continue
      const specStart = (match.index ?? 0) + match[1].length
      const specEnd = specStart + match[2].length
      if (specStart === expectedStart && specEnd === expectedEnd) return true
    }
  }
  return false
}

function isAllowedNodeBuiltin(specifier) {
  return PORTABLE_NODE_BUILTINS.has(specifier)
}

function isAllowedRuntimeSpecifier(name, specifier) {
  if (isAllowedNodeBuiltin(specifier)) return true
  const hostSet = isTuiDomain(name) ? TUI_HOST_SPECIFIERS : SERVER_HOST_SPECIFIERS
  return hostSet.has(specifier)
}

let babelParse = null
function loadBabelParserSync() {
  if (babelParse) return babelParse
  const req = createRequire(import.meta.url)
  let parser
  try {
    const solidEntry = req.resolve("@opentui/solid")
    const babelCore = createRequire(solidEntry).resolve("@babel/core")
    parser = createRequire(babelCore)("@babel/parser")
  } catch (error) {
    throw new Error(
      "@babel/parser is not resolvable via @opentui/solid -> @babel/core; " +
        "scripts/pack-smoke.mjs needs it to inspect packaged module specifiers",
      { cause: error },
    )
  }
  babelParse = parser.parse ?? parser.default?.parse
  if (typeof babelParse !== "function") {
    throw new Error("@babel/parser did not expose a parse() function")
  }
  return babelParse
}

function parserPluginsFor(name) {
  if (/\.(?:[mc]?tsx|jsx)$/.test(name)) return ["typescript", "jsx"]
  if (/\.[mc]?ts$/.test(name)) return ["typescript"]
  return []
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

function literalString(node) {
  if (node?.type === "StringLiteral") return node.value
  if (node?.type === "TemplateLiteral" && node.expressions.length === 0 && node.quasis.length === 1) {
    return typeof node.quasis[0].value.cooked === "string" ? node.quasis[0].value.cooked : null
  }
  return null
}

function isMemberNamed(callee, propName) {
  if (callee?.type !== "MemberExpression" && callee?.type !== "OptionalMemberExpression") return false
  if (!callee.computed && callee.property?.type === "Identifier") return callee.property.name === propName
  if (callee.computed && literalString(callee.property) === propName) return true
  return false
}

function isImportMetaUrl(node) {
  return (
    (node?.type === "MemberExpression" || node?.type === "OptionalMemberExpression") &&
    !node.computed &&
    node.property?.type === "Identifier" &&
    node.property.name === "url" &&
    node.object?.type === "MetaProperty" &&
    node.object.meta?.name === "import" &&
    node.object.property?.name === "meta"
  )
}

function inspectAst(ast) {
  const runtimeImports = []
  const typeRelativeArgs = []
  const metaUrlArgs = []
  const forbiddenCalls = []
  const hasAttrs = (node) => (node.attributes?.length ?? 0) > 0 || (node.assertions?.length ?? 0) > 0

  walkAst(ast, (node) => {
    switch (node.type) {
      case "ImportDeclaration": {
        if (!node.source) break
        const isTypeOnly =
          node.importKind === "type" ||
          (node.specifiers.length > 0 &&
            node.specifiers.every((s) => s.type === "ImportSpecifier" && s.importKind === "type"))
        if (isTypeOnly) {
          typeRelativeArgs.push(node.source)
        } else {
          runtimeImports.push({
            argument: node.source,
            enclosingNode: node,
            kind: "import-decl",
            hasExtraArgs: hasAttrs(node),
          })
        }
        break
      }
      case "ExportNamedDeclaration": {
        if (!node.source) break
        const isTypeOnly =
          node.exportKind === "type" ||
          (node.specifiers.length > 0 && node.specifiers.every((s) => s.exportKind === "type"))
        if (isTypeOnly) {
          typeRelativeArgs.push(node.source)
        } else {
          runtimeImports.push({
            argument: node.source,
            enclosingNode: node,
            kind: "export-decl",
            hasExtraArgs: hasAttrs(node),
          })
        }
        break
      }
      case "ExportAllDeclaration": {
        if (!node.source) break
        if (node.exportKind === "type") {
          typeRelativeArgs.push(node.source)
        } else {
          runtimeImports.push({
            argument: node.source,
            enclosingNode: node,
            kind: "export-decl",
            hasExtraArgs: hasAttrs(node),
          })
        }
        break
      }
      case "TSImportEqualsDeclaration": {
        if (node.moduleReference?.type !== "TSExternalModuleReference") break
        if (node.importKind === "type") {
          typeRelativeArgs.push(node.moduleReference.expression)
        } else {
          runtimeImports.push({
            argument: node.moduleReference.expression,
            enclosingNode: node,
            kind: "require",
            hasExtraArgs: false,
          })
        }
        break
      }
      case "TSImportType": {
        const arg = node.argument?.type === "TSLiteralType" ? node.argument.literal : node.argument
        if (arg) typeRelativeArgs.push(arg)
        break
      }
      case "ImportExpression": {
        if (node.source) {
          runtimeImports.push({
            argument: node.source,
            enclosingNode: node,
            kind: "dynamic-import",
            hasExtraArgs: node.options != null,
          })
        }
        break
      }
      case "CallExpression":
      case "OptionalCallExpression": {
        if (
          (node.callee.type === "Identifier" && node.callee.name === "createRequire") ||
          isMemberNamed(node.callee, "createRequire")
        ) {
          forbiddenCalls.push("createRequire")
        } else if (isMemberNamed(node.callee, "getBuiltinModule")) {
          forbiddenCalls.push("getBuiltinModule")
        } else if (node.callee.type === "Import" && node.arguments.length >= 1) {
          runtimeImports.push({
            argument: node.arguments[0],
            enclosingNode: node,
            kind: "dynamic-import",
            hasExtraArgs: node.arguments.length > 1,
          })
        } else if (node.callee.type === "Identifier" && node.callee.name === "require" && node.arguments.length >= 1) {
          runtimeImports.push({
            argument: node.arguments[0],
            enclosingNode: node,
            kind: "require",
            hasExtraArgs: node.arguments.length > 1,
          })
        }
        break
      }
      case "NewExpression": {
        if (
          node.callee.type === "Identifier" &&
          node.callee.name === "URL" &&
          node.arguments.length >= 2 &&
          isImportMetaUrl(node.arguments[1])
        ) {
          metaUrlArgs.push(node.arguments[0])
        }
        break
      }
    }
  })
  return { runtimeImports, typeRelativeArgs, metaUrlArgs, forbiddenCalls }
}

// -> string[] of problems (empty = ok). `files` maps tarball-relative POSIX
// paths to their text content (binary content is irrelevant here).
export function checkPackage(files) {
  const problems = []
  const names = [...files.keys()].sort()

  for (const name of names) {
    if (!EXACT.has(name) && !isAllowedSrcFile(name)) {
      problems.push(`unexpected file in the package: ${name}`)
    }
  }
  for (const name of EXACT) {
    if (!files.has(name)) problems.push(`missing from the package: ${name}`)
  }
  if (!names.some((n) => n.startsWith(PREFIX))) problems.push("no src/ files in the package")

  // exports map + zero-dependency manifest contract
  let pkg = null
  try {
    const parsed = JSON.parse(files.get("package.json") ?? "")
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      pkg = parsed
    } else {
      problems.push("package.json is missing or not a JSON object")
    }
  } catch {
    problems.push("package.json is missing or not a JSON object")
  }
  if (pkg) {
    for (const field of FORBIDDEN_DEP_FIELDS) {
      if (Object.hasOwn(pkg, field) && pkg[field] !== undefined) {
        problems.push(
          `package.json must not declare "${field}" (host provides runtime modules; keep build/test packages in devDependencies)`,
        )
      }
    }
    // exports entries and their constraints: "." is any file in the package;
    // "./tui" must be a plain string naming the precompiled dist/ artifact
    // (see the header) — a conditions object could smuggle raw TSX under the
    // "bun" condition the TUI host actually selects.
    const entries = [[".", null], ["./tui", "dist/"]]
    for (const [key, requirePrefix] of entries) {
      const entry = pkg.exports?.[key]
      if (requirePrefix !== null && entry !== undefined && typeof entry !== "string") {
        problems.push(
          `exports["${key}"] must be a string entry pointing at ${requirePrefix}, got a conditions object ` +
            "(a condition could smuggle raw TSX past this check)",
        )
        continue
      }
      const target = typeof entry === "string" ? entry : entry?.import ?? entry?.default
      if (typeof target !== "string") {
        problems.push(`package.json has no resolvable exports["${key}"]`)
      } else if (!files.has(path.posix.normalize(target))) {
        problems.push(`exports["${key}"] points at ${target}, which is not in the package`)
      } else if (requirePrefix !== null && !path.posix.normalize(target).startsWith(requirePrefix)) {
        problems.push(
          `exports["${key}"] points at ${target}, which is the raw TSX source — ` +
            "it must be the precompiled dist/ artifact (raw TSX cannot load from node_modules)",
        )
      }
    }
  }

  // relative imports, vendored-script locators, and domain-scoped runtime
  // specifiers inside the shipped sources. src/ carries the raw .ts/.tsx
  // sources; dist/ carries the precompiled .js artifact.
  const scanned = names.filter((n) => (n.startsWith("src/") || n.startsWith("dist/")) && /\.(?:[mc]?[jt]sx?)$/.test(n))
  const resolveRelativeTarget = (fromFile, specifier) => {
    const base = path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), specifier))
    return [base, `${base}.ts`, `${base}/index.ts`].find((candidate) => files.has(candidate)) ?? null
  }
  const resolves = (fromFile, specifier) => resolveRelativeTarget(fromFile, specifier) !== null
  const parse = loadBabelParserSync()
  for (const name of scanned) {
    const source = files.get(name) ?? ""
    const reportedBrokenRelative = new Set()
    let distSyntaxOk = true
    if (name.startsWith("dist/")) {
      // Syntax check: the shipped file must survive a real JS parse. The temp
      // copy is .mjs so `node --check` reads it as a module (the artifact is
      // ESM) regardless of the temp directory's package type.
      const checkDir = mkdtempSync(path.join(tmpdir(), "pack-smoke-check-"))
      try {
        const checkFile = path.join(checkDir, "artifact.mjs")
        writeFileSync(checkFile, source)
        execFileSync(process.execPath, ["--check", checkFile], { stdio: "pipe" })
      } catch (error) {
        distSyntaxOk = false
        const detail =
          String(error.stderr ?? error.message)
            .trim()
            .split("\n")
            .findLast((line) => line.trim()) ?? ""
        problems.push(`${name}: does not parse as JavaScript (${detail})`)
      } finally {
        rmSync(checkDir, { recursive: true, force: true })
      }
    }
    if (!distSyntaxOk) continue

    let ast
    try {
      ast = parse(source, { sourceType: "module", plugins: parserPluginsFor(name) })
    } catch (error) {
      problems.push(`${name}: does not parse (${error instanceof Error ? error.message : String(error)})`)
      continue
    }

    const { runtimeImports, typeRelativeArgs, metaUrlArgs, forbiddenCalls } = inspectAst(ast)

    for (const calleeName of forbiddenCalls) {
      problems.push(
        `${name}: runtime ${calleeName}() is not supported (host provides runtime modules in memory, not node_modules)`,
      )
    }

    for (const arg of typeRelativeArgs) {
      const literal = literalString(arg)
      if (typeof literal === "string" && (literal.startsWith("./") || literal.startsWith("../"))) {
        if (!resolves(name, literal) && !reportedBrokenRelative.has(literal)) {
          reportedBrokenRelative.add(literal)
          problems.push(`${name}: import "${literal}" does not resolve inside the package`)
        }
      }
    }

    for (const arg of metaUrlArgs) {
      const literal = literalString(arg)
      if (typeof literal === "string" && (literal.startsWith("./") || literal.startsWith("../"))) {
        if (!resolves(name, literal)) {
          problems.push(`${name}: URL "${literal}" does not resolve inside the package`)
        }
      }
    }

    for (const { argument, enclosingNode, kind, hasExtraArgs } of runtimeImports) {
      const literal = literalString(argument)
      if (typeof literal === "string" && (literal.startsWith("./") || literal.startsWith("../"))) {
        const target = resolveRelativeTarget(name, literal)
        if (!target) {
          if (!reportedBrokenRelative.has(literal)) {
            reportedBrokenRelative.add(literal)
            problems.push(`${name}: import "${literal}" does not resolve inside the package`)
          }
        } else if (!isTuiDomain(name) && isTuiDomain(target)) {
          problems.push(`${name}: server/shared module must not runtime-import TUI module "${target}"`)
        } else if (name.startsWith("dist/") && /\.[mc]?[jt]sx$/.test(target)) {
          problems.push(`${name}: precompiled TUI artifact must not import raw JSX source "${target}"`)
        } else if (isTuiDomain(name) && argument?.type === "TemplateLiteral" && !literal.endsWith(".js")) {
          problems.push(
            `${name}: template-literal relative import "${literal}" is not prescanned by OpenTUI's runtime loader`,
          )
        }
        continue
      }
      if (argument?.type !== "StringLiteral") {
        problems.push(`${name}: dynamic or template-literal runtime import is not supported`)
        continue
      }
      const specifier = argument.value
      if (name.startsWith("dist/") && /^react(-dom)?(\/|$)/.test(specifier)) {
        problems.push(
          `${name}: TUI artifact imports "${specifier}" — ` +
            "rebuild it with scripts/build-tui.mjs (raw JSX cannot load from node_modules)",
        )
      } else if (!isAllowedRuntimeSpecifier(name, specifier)) {
        problems.push(`${name}: runtime bare import "${specifier}" is not provided by Node or the OpenCode host`)
      } else if (isTuiDomain(name) && TUI_ONLY_SPECIFIERS.has(specifier)) {
        if (kind === "require") {
          problems.push(
            `${name}: TUI host import "${specifier}" cannot be loaded with synchronous require() (OpenTUI virtual modules are async)`,
          )
        } else if (hasExtraArgs || !isRewritableByOpenTui(source, enclosingNode, argument)) {
          problems.push(
            `${name}: TUI host import "${specifier}" uses syntax OpenTUI's runtime rewriter cannot rewrite`,
          )
        }
      }
    }
  }
  return problems
}

function readTree(root, dir = root, into = new Map()) {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry)
    if (statSync(full).isDirectory()) readTree(root, full, into)
    else into.set(path.relative(root, full).split(path.sep).join("/"), readFileSync(full, "utf8"))
  }
  return into
}

// -> { filename: string, [key: string]: unknown } — the single pack's tarball
// info, normalized across npm CLI versions. `npm pack --json` output changed
// shape in npm 12: <= 11 printed an ARRAY of tarball-content objects,
// >= 12 (utils/tar.js logTar) buffers ONE object keyed by the package name.
// Anything else is a hard error, not a guess.
export function normalizePackOutput(parsed, packageName) {
  if (Array.isArray(parsed) && parsed[0]?.filename) return parsed[0]
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const entry = parsed[packageName] ?? Object.values(parsed)[0]
    if (entry?.filename) return entry
  }
  throw new Error(
    `unrecognizable npm pack --json output (${JSON.stringify(parsed).slice(0, 120)}) — ` +
      "extend normalizePackOutput for the new npm CLI's shape",
  )
}

async function main() {
  const work = mkdtempSync(path.join(tmpdir(), "pack-smoke-"))
  try {
    // Explicit --dry-run=false: when this script runs under `npm publish
    // --dry-run` (via prepublishOnly), the inherited npm_config_dry_run=true
    // would dry the nested pack too — no tarball is written and the tar step
    // below fails with "Cannot open: No such file or directory". CLI flags
    // beat inherited config env, so the child always writes the tarball.
    // The output shape is normalized for both npm <= 11 (array) and >= 12
    // (object keyed by package name) — see normalizePackOutput.
    const packed = JSON.parse(
      execFileSync("npm", ["pack", "--json", "--dry-run=false", "--pack-destination", work, "--ignore-scripts"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "inherit"],
      }),
    )
    const tarballInfo = normalizePackOutput(packed, "model-compare-opencode-plugin")
    const tarball = path.join(work, tarballInfo.filename)
    const unpacked = path.join(work, "unpacked")
    execFileSync("mkdir", ["-p", unpacked])
    execFileSync("tar", ["-xzf", tarball, "-C", unpacked, "--strip-components=1"])
    const files = readTree(unpacked)

    const problems = checkPackage(files)
    if (problems.length > 0) {
      console.error(`pack-smoke failed (${problems.length}):`)
      for (const p of problems) console.error(`  - ${p}`)
      process.exitCode = 1
      return
    }
    console.log(
      `pack-smoke ok: ${files.size} files in ${tarballInfo.filename}, §12 list matches, exports and imports resolve`,
    )
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

if (invokedDirectly(import.meta.url, process.argv[1])) await main()

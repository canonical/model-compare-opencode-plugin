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
//      react import means the artifact was not precompiled.
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
import { tmpdir } from "node:os"
import path from "node:path"
import { invokedDirectly } from "./lib/invoked-directly.mjs"

// The §12 file list. `src/` is a prefix; the rest are exact paths.
const EXACT = new Set([
  "package.json",
  "dist/tui.js",
  "vendor/model_compare.py",
  "vendor/UPSTREAM.json",
  "LICENSE",
  "README.md",
])
const PREFIX = "src/"

// -> string[] of problems (empty = ok). `files` maps tarball-relative POSIX
// paths to their text content (binary content is irrelevant here).
export function checkPackage(files) {
  const problems = []
  const names = [...files.keys()].sort()

  for (const name of names) {
    if (!EXACT.has(name) && !name.startsWith(PREFIX)) {
      problems.push(`unexpected file in the package: ${name}`)
    }
  }
  for (const name of EXACT) {
    if (!files.has(name)) problems.push(`missing from the package: ${name}`)
  }
  if (!names.some((n) => n.startsWith(PREFIX))) problems.push("no src/ files in the package")

  // exports map -> files
  let pkg = null
  try {
    pkg = JSON.parse(files.get("package.json") ?? "")
  } catch {
    problems.push("package.json is missing or not valid JSON")
  }
  if (pkg) {
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

  // relative imports, vendored-script locators, and (dist/ only) a react
  // import inside the shipped sources. src/ carries the raw .ts/.tsx sources;
  // dist/ carries the precompiled .js artifact.
  const scanned = names.filter(
    (n) => (n.startsWith("src/") && /\.(m|c)?tsx?$/.test(n)) || (n.startsWith("dist/") && /\.(m|c)?js$/.test(n)),
  )
  const resolves = (fromFile, specifier) => {
    const base = path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), specifier))
    return [base, `${base}.ts`, `${base}/index.ts`].some((candidate) => files.has(candidate))
  }
  for (const name of scanned) {
    const source = files.get(name) ?? ""
    for (const match of source.matchAll(/\b(?:from|import|require)\s*\(?\s*(["'`])(\.{1,2}\/[^"'`]*)\1/g)) {
      if (!resolves(name, match[2])) problems.push(`${name}: import "${match[2]}" does not resolve inside the package`)
    }
    for (const match of source.matchAll(/new URL\(\s*["'](\.{1,2}\/[^"']+)["']\s*,\s*import\.meta\.url/g)) {
      if (!resolves(name, match[1])) problems.push(`${name}: URL "${match[1]}" does not resolve inside the package`)
    }
    if (name.startsWith("dist/")) {
      // Bare imports via from/import/require with any quote char — the shapes
      // a JSX transform can emit include require("react/jsx-runtime").
      for (const match of source.matchAll(/\b(?:from|import|require)\s*\(?\s*(["'`])([^."'`][^"'`]*)\1/g)) {
        if (/^react(-dom)?(\/|$)/.test(match[2])) {
          problems.push(
            `${name}: TUI artifact imports "${match[2]}" — ` +
              "rebuild it with scripts/build-tui.mjs (raw JSX cannot load from node_modules)",
          )
        }
      }
      // Syntax check: the regex scans cannot see a corrupted banner or a
      // truncated write — the shipped file must survive a real parse. The
      // temp copy is .mjs so `node --check` reads it as a module (the
      // artifact is ESM) regardless of the temp directory's package type.
      const checkDir = mkdtempSync(path.join(tmpdir(), "pack-smoke-check-"))
      try {
        const checkFile = path.join(checkDir, "artifact.mjs")
        writeFileSync(checkFile, source)
        execFileSync("node", ["--check", checkFile], { stdio: "pipe" })
      } catch (error) {
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

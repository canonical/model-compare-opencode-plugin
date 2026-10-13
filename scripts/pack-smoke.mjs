// scripts/pack-smoke.mjs — packaging smoke test (design §12, review F-12).
//
// Packs the plugin exactly as `npm publish` would, unpacks the tarball into a
// temp directory and verifies, WITHOUT OpenCode:
//   1. the file set equals the §12 list: package.json, src/**, vendor/
//      model_compare.py, vendor/UPSTREAM.json, LICENSE, README.md — nothing
//      from tests/, scripts/, fixtures/, docs/ leaks in and nothing is missing;
//   2. the `exports` map points at files that are in the tarball;
//   3. every relative import in the packaged TypeScript sources, and the
//      `new URL("…", import.meta.url)` that locates the vendored script,
//      resolves to a file in the tarball;
//
// Type correctness is `tsc --noEmit`'s job (CI runs it); the typescript
// package at v7 ships no JS API to re-check the unpacked files here.
//
// NOT covered (deferred, spec §12): loading the installed package inside a
// real OpenCode — that needs the opencode binary and credentials, so it stays a
// manual/integration step. `exports` pointing at raw .ts is the V2 docs'
// pattern, but only OpenCode itself can confirm it loads.
//
// Usage: node scripts/pack-smoke.mjs   (from the repository root)

import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"

// The §12 file list. `src/` is a prefix; the rest are exact paths.
const EXACT = new Set([
  "package.json",
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
    const entry = pkg.exports?.["."]
    const target = typeof entry === "string" ? entry : entry?.import ?? entry?.default
    if (typeof target !== "string") {
      problems.push('package.json has no resolvable exports["."]')
    } else if (!files.has(path.posix.normalize(target))) {
      problems.push(`exports["."] points at ${target}, which is not in the package`)
    }
  }

  // relative imports and vendored-script locators inside src/
  const resolves = (fromFile, specifier) => {
    const base = path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), specifier))
    return [base, `${base}.ts`, `${base}/index.ts`].some((candidate) => files.has(candidate))
  }
  for (const name of names.filter((n) => n.startsWith(PREFIX) && n.endsWith(".ts"))) {
    const source = files.get(name) ?? ""
    for (const match of source.matchAll(/(?:from|import)\s*\(?\s*["'](\.{1,2}\/[^"']+)["']/g)) {
      if (!resolves(name, match[1])) problems.push(`${name}: import "${match[1]}" does not resolve inside the package`)
    }
    for (const match of source.matchAll(/new URL\(\s*["'](\.{1,2}\/[^"']+)["']\s*,\s*import\.meta\.url/g)) {
      if (!resolves(name, match[1])) problems.push(`${name}: URL "${match[1]}" does not resolve inside the package`)
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

async function main() {
  const work = mkdtempSync(path.join(tmpdir(), "pack-smoke-"))
  try {
    // Explicit --dry-run=false: when this script runs under `npm publish
    // --dry-run` (via prepublishOnly), the inherited npm_config_dry_run=true
    // would dry the nested pack too — no tarball is written and the tar step
    // below fails with "Cannot open: No such file or directory". CLI flags
    // beat inherited config env, so the child always writes the tarball.
    const packed = JSON.parse(
      execFileSync("npm", ["pack", "--json", "--dry-run=false", "--pack-destination", work, "--ignore-scripts"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "inherit"],
      }),
    )
    const tarball = path.join(work, packed[0].filename)
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
    console.log(`pack-smoke ok: ${files.size} files in ${packed[0].filename}, §12 list matches, exports and imports resolve`)
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main()

// Re-pin the vendored model_compare.py to an upstream tag of canonical/model-compare.
//
// Usage:
//   node scripts/sync-vendor.mjs <tag>    Resolve <tag> to its commit, fetch model_compare.py AT
//                                         THAT COMMIT (tags are mutable, commits are not), report the sha256
//                                         change, re-pin vendor/UPSTREAM.json (tag, resolved
//                                         commit, sha256), and print the matching CHANGELOG
//                                         section.
//   node scripts/sync-vendor.mjs --check  Verify the vendored file still matches the pinned
//                                         sha256 (offline; exit 1 on drift).

import { createHash } from "node:crypto"
import { readFileSync, writeFileSync } from "node:fs"

const REPO = "canonical/model-compare"
const SCRIPT_NAME = "model_compare.py"
const VENDOR_FILE = "vendor/model_compare.py"
const META_FILE = "vendor/UPSTREAM.json"

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex")
const rawURL = (ref, file) => `https://raw.githubusercontent.com/${REPO}/${ref}/${file}`

async function fetchOK(url, what) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`fetching ${what}: HTTP ${res.status} for ${url}`)
  return res
}

// Annotated tags point at a tag object; dereference until we hold the commit sha.
async function resolveCommit(tag) {
  let ref = await (await fetchOK(`https://api.github.com/repos/${REPO}/git/refs/tags/${tag}`, `ref ${tag}`)).json()
  while (ref.object.type !== "commit") {
    ref = await (await fetchOK(`https://api.github.com/repos/${REPO}/git/tags/${ref.object.sha}`, "tag object")).json()
  }
  return ref.object.sha
}

function changelogSection(text, version) {
  const lines = text.split("\n")
  const start = lines.findIndex((l) => /^##\s/.test(l) && l.includes(version))
  if (start === -1) return null
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i])) {
      end = i
      break
    }
  }
  const section = lines.slice(start, end)
  while (section.length && section[section.length - 1].trim() === "") section.pop()
  return section.join("\n")
}

async function sync(tag) {
  // A missing or unreadable pin is not fatal: report "(none)" and proceed.
  let previous = null
  try {
    previous = JSON.parse(readFileSync(META_FILE, "utf8")).sha256
  } catch {
    // no current pin
  }

  // Resolve first and fetch at the commit sha: the tag is a mutable name, and
  // the pin must describe exactly the bytes written below.
  const commit = await resolveCommit(tag)
  const body = Buffer.from(await (await fetchOK(rawURL(commit, SCRIPT_NAME), SCRIPT_NAME)).arrayBuffer())
  const current = sha256(body)
  if (previous === current) {
    console.log(`no change: ${SCRIPT_NAME} at ${tag} keeps sha256 ${current}`)
  } else {
    console.log(`changed: sha256 ${previous ? `${previous.slice(0, 12)}…` : "(none)"} -> ${current.slice(0, 12)}…`)
  }

  writeFileSync(VENDOR_FILE, body)
  writeFileSync(META_FILE, `${JSON.stringify({ repo: REPO, tag, commit, sha256: current }, null, 2)}\n`)

  const changelog = await fetch(rawURL(commit, "CHANGELOG.md"))
  if (!changelog.ok) {
    console.log(`no CHANGELOG.md at ${tag} (HTTP ${changelog.status})`)
    return
  }
  const version = tag.replace(/^v/, "")
  const section = changelogSection(await changelog.text(), version)
  console.log(section ?? `no CHANGELOG entry for ${version} at ${tag}`)
}

function check() {
  const meta = JSON.parse(readFileSync(META_FILE, "utf8"))
  const actual = sha256(readFileSync(VENDOR_FILE))
  if (actual === meta.sha256) {
    console.log(`ok: ${VENDOR_FILE} matches pinned sha256 ${actual}`)
  } else {
    console.log(`drift: ${VENDOR_FILE} sha256 ${actual} != pinned ${meta.sha256} (tag ${meta.tag})`)
    process.exitCode = 1
  }
}

const arg = process.argv[2]
if (arg === "--check") {
  check()
} else if (arg && !arg.startsWith("-")) {
  try {
    await sync(arg)
  } catch (err) {
    console.error(`sync-vendor: ${err.message}`)
    process.exitCode = 1
  }
} else {
  console.error("usage: node scripts/sync-vendor.mjs <tag>|--check")
  process.exitCode = 2
}
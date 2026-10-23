// scripts/drift-check.mjs — weekly drift check (plan Task 15, Step 3).
//
// Two independent checks; the run fails (exit 1) if either fails.
//
// 1. VENDOR DRIFT. Re-fetches model_compare.py at the commit pinned in
//    vendor/UPSTREAM.json (raw.githubusercontent.com/<repo>/<commit>/...) and
//    compares its sha256 with the vendored file on disk. A mismatch means the
//    vendored copy is not what the pin claims: someone edited the file and/or
//    the recorded sha256 without re-syncing, or the pin names a commit that is
//    not what was vendored. (The offline conformance test only compares the
//    file with the sha256 recorded in the same PR; this is the check that
//    ties the pin to upstream's actual bytes.) It does NOT report that
//    upstream has newer tags — upgrade-pr.yml does that.
//
// 2. PUBLISHED-CONTRACT CONSISTENCY. Fetches the published catalog and, for
//    each priority (balanced, price, quality), checks that the published
//    `rankings[p]` top 5 agrees with the order derived from the published
//    `scores.overall[p]` under upstream's ranking tie-break (-overall,
//    -(quality ?? 0), blended price asc, id asc; design §6). The plugin's
//    no-override ranking returns the published `rankings[p]` verbatim
//    (src/core/rank.ts), so this guards that the ranking data the plugin
//    consumes stays consistent with the scores published beside it.
//    Upstream builds rankings from unrounded scores while the catalog
//    publishes scores rounded to 4 decimals (design §6), so near-tie
//    divergence is expected: a position where the two models' overall scores
//    differ by <= 0.005 is tolerated as a tie. Exit 0 with a warning count for
//    1-2 real position differences, failure only when >= 3 real (non-tie)
//    position differences exist across the three priorities.
//
// The report always goes to stdout (the weekly workflow tees it into an
// artifact). The checks are pure functions below; the CLI wrapper at the
// bottom does the fetching (tests/unit/drift.test.mjs covers the functions).

import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { pathToFileURL } from "node:url"

const PUBLISHED_URL = "https://model-compare.dev/catalog.json"
const PRIORITIES = ["balanced", "price", "quality"] // the plugin's Priority (src/core/types.ts)
const TOP = 5
const TIE = 0.005 // near-ties at or below this overall delta are tolerated (design §6)
export const FAIL_AT = 3 // fail only at this many real position differences
const META_FILE = "vendor/UPSTREAM.json"
const VENDOR_FILE = "vendor/model_compare.py"

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex")

// ---- check 1: vendor drift ---------------------------------------------------

export const upstreamRawURL = (meta) =>
  `https://raw.githubusercontent.com/${meta.repo}/${meta.commit}/model_compare.py`

// -> { ok, line }. `local` and `upstream` are the two files' bytes.
export function checkVendorDrift(meta, local, upstream) {
  const localSha = sha256(local)
  const upstreamSha = sha256(upstream)
  if (localSha === upstreamSha) {
    const recorded = meta.sha256 === localSha ? "matches" : `DIFFERS from the recorded ${meta.sha256}`
    return {
      ok: meta.sha256 === localSha,
      line:
        meta.sha256 === localSha
          ? `vendor: ok — ${VENDOR_FILE} equals ${meta.repo}@${meta.commit.slice(0, 12)} (${meta.tag}), sha256 ${localSha}`
          : `vendor: DRIFT — file equals upstream@${meta.commit.slice(0, 12)} but UPSTREAM.json sha256 ${recorded}`,
    }
  }
  return {
    ok: false,
    line: `vendor: DRIFT — ${VENDOR_FILE} sha256 ${localSha} != ${meta.repo}@${meta.commit.slice(0, 12)} (${meta.tag}) sha256 ${upstreamSha}`,
  }
}

// ---- check 2: published-contract consistency ---------------------------------

// Upstream's ranking_key (design §6) applied to the published rounded scores.
const derivedOrder = (p) => (a, b) => {
  const byScore = b.scores.overall[p] - a.scores.overall[p]
  if (byScore !== 0) return byScore
  const byQuality = (b.quality ?? 0) - (a.quality ?? 0)
  if (byQuality !== 0) return byQuality
  const byPrice = a.pricing.blended_per_1m - b.pricing.blended_per_1m
  if (byPrice !== 0) return byPrice
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

// -> { ok: false, reason } for a structurally unusable catalog, else
//    { ok: true, failed, lines, realDiffs, toleratedTies }.
export function checkRankings(catalog) {
  if (typeof catalog !== "object" || catalog === null || !Array.isArray(catalog.models) || catalog.models.length === 0) {
    return { ok: false, reason: "published catalog has no non-empty models array" }
  }
  // The derived order needs every model's overall[p]; a single hole makes it
  // meaningless, so bail with a reason instead of comparing garbage.
  for (const p of PRIORITIES) {
    for (const model of catalog.models) {
      if (!Number.isFinite(model?.scores?.overall?.[p])) {
        return { ok: false, reason: `model ${model?.id ?? "(no id)"} has no finite scores.overall.${p}` }
      }
    }
  }
  for (const p of PRIORITIES) {
    const ranking = catalog.rankings?.[p]
    if (!Array.isArray(ranking) || ranking.length === 0) {
      return { ok: false, reason: `published catalog has no rankings.${p}` }
    }
  }

  const byId = new Map(catalog.models.map((m) => [m.id, m]))
  const overallOf = (id, p) => {
    const value = byId.get(id)?.scores?.overall?.[p]
    return Number.isFinite(value) ? value : null
  }

  const lines = []
  let realDiffs = 0
  let toleratedTies = 0
  for (const p of PRIORITIES) {
    const published = catalog.rankings[p].slice(0, TOP)
    const derived = [...catalog.models].sort(derivedOrder(p)).map((m) => m.id).slice(0, TOP)
    const agree = []
    const ties = []
    const diffs = []
    for (let i = 0; i < TOP; i++) {
      const a = published[i]
      const b = derived[i]
      if (a === b) {
        agree.push(a)
        continue
      }
      const sa = overallOf(a, p)
      const sb = overallOf(b, p)
      if (sa !== null && sb !== null && Math.abs(sa - sb) <= TIE) {
        ties.push(`${p}[${i}] near-tie tolerated: published ${a} (overall ${sa}) vs derived ${b} (overall ${sb})`)
      } else {
        diffs.push(`${p}[${i}] REAL: published ${a} (overall ${sa}) vs derived ${b} (overall ${sb})`)
      }
    }
    toleratedTies += ties.length
    realDiffs += diffs.length
    lines.push("", `${p}: ${agree.length}/${TOP} positions agree, ${ties.length} near-tie(s) tolerated, ${diffs.length} real difference(s)`)
    lines.push(...ties.map((t) => `  ${t}`))
    lines.push(...diffs.map((d) => `  ${d}`))
  }
  return { ok: true, failed: realDiffs >= FAIL_AT, lines, realDiffs, toleratedTies }
}

// ---- CLI --------------------------------------------------------------------

async function fetchBytes(url, what) {
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) })
  if (!res.ok) throw new Error(`${what}: HTTP ${res.status} for ${url}`)
  return Buffer.from(await res.arrayBuffer())
}

async function main() {
  const report = [`drift report at ${new Date().toISOString()}`, ""]
  let failed = false

  // 1. vendor drift
  const meta = JSON.parse(readFileSync(META_FILE, "utf8"))
  try {
    const upstream = await fetchBytes(upstreamRawURL(meta), `fetching ${VENDOR_FILE} at the pinned commit`)
    const result = checkVendorDrift(meta, readFileSync(VENDOR_FILE), upstream)
    report.push(result.line)
    if (!result.ok) failed = true
  } catch (err) {
    report.push(`vendor: cannot verify the pin (network error or 30s timeout): ${err.message}`)
    failed = true
  }

  // 2. published rankings
  report.push("", `rankings: ${PUBLISHED_URL}`)
  try {
    const catalog = JSON.parse((await fetchBytes(PUBLISHED_URL, "fetching the published catalog")).toString("utf8"))
    const result = checkRankings(catalog)
    if (!result.ok) {
      report.push(`rankings: ${result.reason}`)
      failed = true
    } else {
      report.push(...result.lines, "")
      if (result.failed) {
        report.push(`rankings: FAIL — ${result.realDiffs} real position difference(s) >= threshold ${FAIL_AT}`)
        failed = true
      } else {
        report.push(
          result.realDiffs > 0
            ? `rankings: warn — ${result.realDiffs} real position difference(s), below threshold ${FAIL_AT} (report-only); ${result.toleratedTies} near-tie(s) tolerated`
            : `rankings: ok — published rankings agree with the score-derived order; ${result.toleratedTies} near-tie(s) tolerated`,
        )
      }
    }
  } catch (err) {
    report.push(`rankings: cannot fetch the published catalog (network error or 30s timeout): ${err.message}`)
    failed = true
  }

  report.push("", failed ? "RESULT: FAIL" : "RESULT: ok")
  console.log(report.join("\n"))
  process.exit(failed ? 1 : 0)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main()

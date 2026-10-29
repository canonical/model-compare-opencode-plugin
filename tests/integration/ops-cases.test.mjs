// tests/integration/ops-cases.test.mjs
// Live integration cases for the model-compare plugin (Task 14, spec §13):
// commands, failure and degradation — plus case 7, a regression test for the
// seed-before-register reload fix (the d6a5aa6 behavior). Sibling of
// core-cases.test.mjs (Task 13) and built on the same harness (harness.mjs):
// a dedicated `opencode serve`
// in the scratch project (port 14721, OPENCODE_SERVER_PASSWORD=integration-only),
// driven with `opencode run --server …` / `opencode api …`, observed through the
// probe plugin's wire.jsonl. See harness.mjs's header for the proven mechanics
// (plugin activation on the first session, alias-state polling as the
// refresh-completion signal, global plugin storage neutralized via
// pinDays: 0.00001).
//
// Cases (dispatch order; numbers follow the task brief):
//   1. /use-best switch — POST /api/session/{id}/command {"name":"use-best",
//      "text":"price"} in an existing session; the session's next request
//      wires to the fixture's PRICE pick and the CLI shows the session model
//      ref as the price alias. (The recorded fixture's price pick is a free
//      model this OpenRouter account's data-policy guardrails refuse at the
//      provider level — the run may exit non-zero AFTER the request went out;
//      the case asserts the wire and the CLI ref, which is what the brief
//      pins, and tolerates the provider-side error.)
//   2. /use-best refusal — zero-models state (quality alias disabled): the
//      command answers with the exact refusal synthetic message and does NOT
//      switch the session; the next request still wires to the session's
//      pinned baseline model and completes (no crash). The plain runs pin
//      that model with --model because OpenCode's built-in fallback for an
//      unavailable root default is refused by this account's ZDR guardrails.
//   3. Startup offline (last-known-good) — fixture A run once (doc cache +
//      pins written), then scriptPath swapped to an exit-1 stub with
//      source "local" and the server restarted: setup seeds from the cached
//      doc + stored pin, the background refresh REJECTS (caught, logged, no
//      state change), and the first dispatch still wires to the previous pick.
//   4. auto falls back to remote — a variant with source "auto" + the broken
//      stub: python3 is present so the local run is attempted and fails, and
//      the tick degrades to the REAL published catalog.json. Requires
//      network; skips cleanly when the catalog is unreachable. To make the
//      fallback observable (fetchRemote serves ANY doc/cache record younger
//      than 6 h — including a previous phase's), the plugin's persisted
//      doc/cache row is deleted first, while the server is stopped, via the
//      sqlite3 CLI against OpenCode's kv store (plugin-scoped key; the same
//      storage the plugin itself writes every tick).
//   5. Subagent with a disabled alias — zero-models state: the default agent
//      delegates to mc-sub via the subagent tool; the launch fails with
//      OpenCode's `Model unavailable` BEFORE any HTTP request (the probe logs
//      no http.request for the child). NOTE: the task pinned real-parent as
//      the delegator, but real-parent.md's committed system prompt ("Do not
//      use tools and do not delegate") wins every time — verified live twice
//      (the agent just echoes the prompt) — so the delegation runs on the
//      default agent instead. The pinned prompt also named "mc-quality", an
//      agent that does not exist in the project; the real agent id is mc-sub.
//   6. Non-primary kinds untouched by the guard — zero-models state: a plain
//      run still gets its title request (kind "title") and it completes 200
//      with whatever fallback model OpenCode chose; no guard error anywhere.
//   7. Plugin-file reload re-seeds from storage — fixture A run once, then
//      a watched plugin file is touched (mtime-only utimes). OpenCode's
//      watcher reloads the plugins — setup re-runs — and the re-run must
//      re-seed the aliases from the persisted doc cache + pins BEFORE
//      registering the transform: the follow-up dispatch still wires to the
//      SAME pick, with no guard error and no restart. The reload's observable
//      is a NEW probe setup line (the probe logs one per plugin load; the
//      model-compare plugin logs nothing itself). VERIFIED LIVE (see the
//      in-case comments): the watcher watches the PACKAGE-style plugin entry
//      (the probe's index.ts) and fires on mtime alone — touching the
//      plugin's real src/index.ts does NOT fire it
//      (90 s utimes + content-blip attempts each, no reload). The
//      model-compare plugin's setup re-run is proven via the doc/cache
//      record's acquiredAt: only a fresh setup's kick-off tick rewrites it
//      (local acquire stamps Date.now()), so a bump isolates the reload from
//      a no-op old instance — needs the sqlite3 CLI (skips without it).
//
// Opt-in: set MC_INTEGRATION=1 (e.g.
//   MC_INTEGRATION=1 npx vitest run tests/integration/ops-cases.test.mjs).
// Without it the file skips so plain `npm test` stays hermetic. It also skips
// when the opencode CLI or python3 is missing. Cases 4 and 7 additionally
// skip when the sqlite3 CLI is missing; case 4 also when the network is
// unreachable.

import { afterAll, beforeAll, describe, expect, test } from "vitest"
import { execFileSync } from "node:child_process"
import { utimesSync, writeFileSync } from "node:fs"
import path from "node:path"
import * as h from "./harness.mjs"
import { resolve } from "../../src/core/pins"

const enabled = process.env.MC_INTEGRATION === "1"
const missing = [!h.hasOpencode && "the opencode CLI", !h.hasPython3 && "python3"].filter(Boolean)
const skipReason =
  !enabled
    ? "opt-in suite: run with MC_INTEGRATION=1 (drives a live opencode server on 127.0.0.1:14721)"
    : missing.length > 0
      ? `missing prerequisites: ${missing.join(", ")}`
      : null
if (skipReason !== null) console.warn(`[model-compare integration] SKIPPED — ${skipReason}`)

const suite = skipReason === null ? describe : describe.skip

// ---- local constants and small helpers --------------------------------------
// (Deliberately duplicated from core-cases.test.mjs instead of imported: test
// files must stay independent — importing a test file would re-register its
// suite.)

const CATALOG_URL = "https://model-compare.dev/catalog.json"
const DELEGATION_PROMPT =
  "Use the subagent tool to launch the 'mc-sub' subagent with the prompt " +
  "'reply with exactly: pong'. Then report its answer, or the exact error " +
  "text it returned, verbatim."
const REFUSAL_TEXT =
  "model-compare: openrouter/model-compare/quality is currently disabled " +
  "(no ranking data); not switching"
const GUARD_ERROR = "model-compare: no ranking data for openrouter/model-compare/quality"
// The model the zero-models-state baseline runs pin with --model: the shared
// healthy baseline (see BASELINE_MODEL in harness.mjs — its note covers why
// EVERY unpinned run in this suite is pinned). The root default here is the
// disabled quality alias, so without the pin OpenCode would fall to its own
// built-in choice. The pin applies only to the plain/delegating parent run:
// agent-scoped models (mc-sub's alias) are configured per agent and untouched.
const BASELINE_MODEL = h.BASELINE_MODEL

function context(result) {
  return JSON.stringify(
    {
      result,
      wireTail: h.wireTail(2500),
      serverLogTail: h.serverLogTail(2500),
    },
    null,
    2,
  )
}

// Breaks the harness stub in place: it exits 1 for any argv, so
// runLocalScript reports "local source failed: exit code 1". The script PATH
// stays the same, so the plugin's cached document (keyed by source identity,
// spec §7.9) still belongs to this source: it is the same source going offline,
// not a different source.
function breakStub() {
  h.setStubMode("fail")
}

// The project config for the Task 14 variants: identical structure to the
// harness's dispatch rendering (probe first, the repo's src dir, root
// default = the quality alias, pins expire between instances), with the
// source/scriptPath knobs the failure cases need.
function renderVariantConfig(options) {
  return `{
  "$schema": "https://opencode.ai/config.json",
  "model": "openrouter/model-compare/quality",
  "plugins": [
    { "package": ${JSON.stringify(h.PROBE_DIR)} },
    {
      "package": ${JSON.stringify(h.PLUGIN_SRC_DIR)},
      "options": {
        "source": ${JSON.stringify(options.source)},
        "scriptPath": ${JSON.stringify(options.scriptPath)},
        "pinDays": 0.00001
      }
    }
  ]
}
`
}

function writeVariantConfig(options) {
  writeFileSync(path.join(h.PROJECT_DIR, "opencode.jsonc"), renderVariantConfig(options))
}

// `opencode api` against the live server (password comes from the env the
// harness's clients use).
function api(method, route, data) {
  const args = ["api", method, route, "--server", h.SERVER_URL]
  if (data !== undefined) args.push("--data", JSON.stringify(data))
  try {
    const stdout = execFileSync("opencode", args, {
      cwd: h.PROJECT_DIR,
      env: { ...process.env, OPENCODE_SERVER_PASSWORD: h.SERVER_PASSWORD },
      encoding: "utf8",
      timeout: 60_000,
      maxBuffer: 16 * 1024 * 1024,
    })
    return { ok: true, status: 0, stdout }
  } catch (error) {
    return {
      ok: false,
      status: error.status ?? null,
      stdout: typeof error.stdout === "string" ? error.stdout : "",
      stderr: typeof error.stderr === "string" ? error.stderr : "",
    }
  }
}

function postCommand(sessionID, name, text) {
  return api("post", `/api/session/${sessionID}/command`, { name, text })
}

// The session transcript (synthetic messages included). Route verified live:
// GET /api/session/{id}/message (singular).
function transcript(sessionID) {
  const got = api("get", `/api/session/${sessionID}/message`)
  if (!got.ok) throw new Error(`transcript fetch failed: ${JSON.stringify(got)}`)
  return JSON.parse(got.stdout).data
}

// Polls the transcript until `predicate` matches a message; deterministic
// wait (no fixed dependency — the same pattern as the harness's poll()).
async function pollTranscript(sessionID, predicate, timeoutMs, describe) {
  const deadline = Date.now() + timeoutMs
  let last = []
  while (Date.now() < deadline) {
    last = transcript(sessionID)
    if (last.some(predicate)) return last
    await h.sleep(500)
  }
  throw new Error(
    `timed out after ${timeoutMs}ms waiting for ${describe}; transcript: ` +
      JSON.stringify(last).slice(0, 2000),
  )
}

function lastSessionID() {
  const requests = h.readWire().filter((e) => e.type === "request")
  if (requests.length === 0) throw new Error("no request lines in wire.jsonl")
  return requests.at(-1).sessionID
}

// The openrouter model ids OpenCode lists as enabled, from the probe's
// registry snapshot ("when": "first-request" is the fully materialized one).
function openrouterIdsFromWire() {
  const snaps = h.readWire().filter((e) => e.type === "models" && Array.isArray(e.openrouter))
  return snaps.length > 0 ? snaps.at(-1).openrouter : []
}

// Every primary request of `agent` wired to `expected`. Used by cases 3, 4
// and 7.
function assertPrimaryWire(requests, agent, expected, result) {
  expect(
    requests.length,
    `expected at least one primary http.request for agent "${agent}"\n${context(result)}`,
  ).toBeGreaterThan(0)
  for (const request of requests) {
    expect(
      request.wire,
      `agent "${agent}" primary request wired ${JSON.stringify(request.wire)}, ` +
        `expected ${JSON.stringify(expected)}\n${context(result)}`,
    ).toBe(expected)
  }
}

// The pick id an observed alias entry points at: the registry's modelID when
// it exposes one, else the name the applier writes
// ("Model Compare: <p> → <id>[(fallback)]"). Mirrors harness.mjs's private
// aliasTargetId (case 7 only).
function aliasTargetFrom(alias) {
  if (typeof alias.modelID === "string" && alias.modelID !== "") return alias.modelID
  const name = typeof alias.name === "string" ? alias.name : ""
  const at = name.indexOf("→ ")
  return at === -1 ? null : name.slice(at + 2)
}

// The probe logs one `setup` line per plugin load (the model-compare plugin
// logs nothing itself), so the number of setup lines in wire.jsonl is the
// number of probe loads this server instance has performed.
function countSetupLines() {
  return h.readWire().filter((e) => e.type === "setup").length
}

// Polls until the setup-line count exceeds `baseline` — a watcher reload
// re-runs EVERY plugin's setup, so a new probe setup line is the reload's
// observable. Same poll discipline as pollTranscript (no fixed sleeps); the
// error carries the usual diagnostics. Used by case 7.
async function waitForReloadSetupLine(baseline, timeoutMs, describe) {
  const deadline = Date.now() + timeoutMs
  let last = baseline
  while (Date.now() < deadline) {
    const count = countSetupLines()
    if (count > baseline) return count
    last = count
    await h.sleep(500)
  }
  throw new Error(
    `timed out after ${timeoutMs}ms waiting for ${describe} ` +
      `(baseline ${baseline}, last observed ${last})\n${context({ stdout: "", stderr: "" })}`,
  )
}

// ---- OpenCode's persisted plugin storage (case 4 only) -----------------------
// The plugin's records live in the RUN's scratch sqlite kv store (harness.mjs
// isolates every suite run into its own OpenCode data dir; live state is never
// read or written), keyed
// `plugin:<hex of the plugin id's char codes>:<record key>` (verified live).
// The harness neutralizes persisted PINS via pinDays expiry; the doc/cache
// record has a hardcoded 6 h TTL (fetchRemote serves any younger record
// without a fetch), so case 4 removes the row itself — with the server
// STOPPED — the same way the plugin's own ticks rewrite it.
// The document cache is keyed per source identity (`doc/cache/<hash>`), so the
// rows are addressed by prefix.
const DOC_CACHE_KV_PREFIX =
  "plugin:" +
  [..."model-compare"].map((c) => c.charCodeAt(0).toString(16).padStart(4, "0")).join("") +
  ":doc/cache/"

function hasSqlite3() {
  try {
    execFileSync("sqlite3", ["--version"], { stdio: "ignore", timeout: 10_000 })
    return true
  } catch {
    return false
  }
}

// The SQL goes in on STDIN, together with the .timeout dot-command: sqlite3
// executes command-line SQL arguments and exits WITHOUT reading stdin, and a
// restored doc/cache row's value is the cached catalog document re-serialized
// compactly — ~300 KB for the v6 fixture (the projected doc-cache row ~262 KB),
// past the 128 KiB per-argv cap (spawnSync E2BIG; the v2-era document was
// 91 KB and always just fit).
// Stdin has no such cap. Surfaced 2026-10-22 when the snapshot/restore
// round-trip first ran against the run's scratch database.
function sqlite(sql) {
  return execFileSync("sqlite3", [h.opencodeDbPath()], { encoding: "utf8", input: `.timeout 10000\n${sql}\n` })
}

function sqliteJson(sql) {
  return execFileSync("sqlite3", ["-json", h.opencodeDbPath()], { encoding: "utf8", input: `.timeout 10000\n${sql}\n` })
}

function docCacheRowCount() {
  return Number(sqlite(`SELECT count(*) FROM kv WHERE key LIKE '${DOC_CACHE_KV_PREFIX}%';`).trim())
}

async function deleteDocCacheRow() {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    sqlite(`DELETE FROM kv WHERE key LIKE '${DOC_CACHE_KV_PREFIX}%';`)
    if (docCacheRowCount() === 0) return
    console.warn(`[model-compare integration] doc/cache row still present (attempt ${attempt})`)
    // The pause is the point: a setup-triggered plugin tick can re-write the
    // row while this case runs, and the retries exist to land after it.
    await h.sleep(500)
  }
  throw new Error(`could not delete ${DOC_CACHE_KV_PREFIX}* from ${h.opencodeDbPath()}`)
}

// Every persisted document-cache row (all columns, exact values), for cases
// that neutralize the cache and must restore it afterwards: the rows are
// shared global state that later cases' warm starts seed from (case 5 reads
// the local-stub record to find the stored pins).
function docCacheRows() {
  const out = sqliteJson(`SELECT key, value, time_created, time_updated FROM kv WHERE key LIKE '${DOC_CACHE_KV_PREFIX}%';`).trim()
  if (out === "") return []
  return JSON.parse(out)
}

// Re-inserts rows snapshotted by docCacheRows() (no-op for an empty snapshot).
// All columns are restored: kv.time_created/time_updated are NOT NULL without
// defaults, so an INSERT omitting them fails.
function restoreDocCacheRows(rows) {
  const lit = (s) => `'${String(s).replaceAll("'", "''")}'`
  for (const row of rows) {
    sqlite(
      `INSERT OR REPLACE INTO kv (key, value, time_created, time_updated) ` +
        `VALUES (${lit(row.key)}, ${lit(row.value)}, ${Number(row.time_created)}, ${Number(row.time_updated)});`,
    )
  }
}

// Every persisted document-cache record (one per source identity), newest
// first. A row's value is the JSON record the plugin wrote.
function docCacheRecords() {
  const out = sqlite(`SELECT value FROM kv WHERE key LIKE '${DOC_CACHE_KV_PREFIX}%';`).trim()
  if (out === "") return []
  return out
    .split("\n")
    .map((line) => JSON.parse(line))
    .filter((record) => record?.v === 1 && typeof record.doc === "object" && typeof record.acquiredAt === "number")
    .sort((a, b) => b.acquiredAt - a.acquiredAt)
}

// The projected catalog document the plugin persisted after its successful
// fetch — the exact document its resolution used.
function readDocCacheDoc() {
  const [newest] = docCacheRecords()
  if (newest === undefined) throw new Error("doc/cache row missing after the remote fallback tick")
  return newest.doc
}

// The newest doc/cache record's acquiredAt (ms since epoch). The local source
// stamps Date.now() on every acquire, and the tick rewrites the record at the
// end of every successful refresh — and a tick only ever STARTS from a plugin
// setup (the kick-off; the interval is 30 minutes). A bumped acquiredAt is
// therefore the proof that the plugin's setup re-ran, which case 7 needs to
// tell a real reload apart from a vacuous old instance that merely kept
// serving.
function docCacheAcquiredAt() {
  const [newest] = docCacheRecords()
  if (newest === undefined) throw new Error("doc/cache row missing")
  return newest.acquiredAt
}

// Polls until the doc/cache acquiredAt exceeds `previous` — the fresh
// kick-off tick of a re-run setup (case 7).
async function waitForDocCacheBump(previous, timeoutMs, describe) {
  const deadline = Date.now() + timeoutMs
  let last = previous
  while (Date.now() < deadline) {
    const at = docCacheAcquiredAt()
    if (at > previous) return at
    last = at
    await h.sleep(500)
  }
  throw new Error(
    `timed out after ${timeoutMs}ms waiting for ${describe} ` +
      `(before ${new Date(previous).toISOString()}, last ${new Date(last).toISOString()})\n` +
      context({ stdout: "", stderr: "" }),
  )
}

suite("model-compare integration: commands, failure and degradation (spec §13)", () => {
  beforeAll(async () => {
    await h.setFixture("a")
  }, 300_000)

  afterAll(async () => {
    await h.finalCleanup()
  }, 120_000)

  test(
    "case 1: /use-best switches the session to the price pick; the follow-up dispatches through it",
    async () => {
      const pricePick = h.expectedPick("a", "price")

      // A session created by a plain run.
      h.truncateWire()
      const first = h.run(["Reply with exactly: one"])
      await h.settle()
      expect(first.ok, `plain run failed\n${context(first)}`).toBe(true)
      const sessionID = lastSessionID()
      const initial = h.primaryRequests("build").at(-1)
      expect(
        initial?.sessionID,
        `expected the plain run's primary request in the wire\n${context(first)}`,
      ).toBe(sessionID)
      expect(
        initial.wire,
        `the session should start on the root default alias's pick, got ${JSON.stringify(initial.wire)}\n${context(first)}`,
      ).toBe(h.expectedPick("a", "quality"))

      // The command: switch this session to the price priority.
      const post = postCommand(sessionID, "use-best", "price")
      expect(
        post.ok,
        `command POST failed\n${JSON.stringify(post)}\n${context({ stdout: "", stderr: "" })}`,
      ).toBe(true)

      // Transcript: OpenCode's own switch record (the switch is immediate;
      // the notice is NOT — with resume:false it is an inbox item that only
      // surfaces at the session's next turn, so the confirmation is polled
      // after the follow-up below).
      const messages = await pollTranscript(
        sessionID,
        (m) => m.type === "model-switched",
        30_000,
        "the model-switched transcript record",
      )
      const switched = messages.find((m) => m.type === "model-switched")
      expect(
        switched.model,
        `expected the session model record to be the price alias\n${JSON.stringify(switched)}`,
      ).toEqual({ id: "model-compare/price", providerID: "openrouter" })

      // The follow-up run continues the session on the switched model.
      const followUp = h.run(["-s", sessionID, "Reply with exactly: two"])
      await h.settle()
      // The recorded fixture's price pick is a free model this OpenRouter
      // account's guardrails refuse at the provider level; the CLI still
      // shows the session model ref and the request still went out — the
      // brief's assertion targets. A provider-side failure after the request
      // is tolerated (documented in the file header).
      const afterSwitch = h
        .readWire()
        .filter((e) => e.type === "request" && e.sessionID === sessionID && e.kind === "primary")
        .slice(1) // drop the initial run's request; the rest is the follow-up
      assertPrimaryWire(afterSwitch, "build", pricePick, followUp)

      // The confirmation is an inbox item (resume:false): it surfaces at the
      // session's next turn — which the follow-up just was.
      const confirmation = transcript(sessionID).find(
        (m) => m.type === "synthetic" && (m.text ?? "").includes("switched to"),
      )
      expect(
        confirmation?.text,
        `expected the /use-best confirmation after the follow-up turn\n${JSON.stringify(
          transcript(sessionID).filter((m) => m.type === "synthetic"),
        )}`,
      ).toBe(
        `model-compare: switched to openrouter/model-compare/price (currently ${pricePick})`,
      )
      // The session-model contract is asserted through the probe: every
      // post-switch request's eventModel must be the price alias ref. (An
      // earlier version asserted the CLI's `> agent · model` banner instead,
      // but that banner proved presentation-variable — present in interactive
      // captures, absent in some captured runs — while the probe is ground
      // truth for which model ref the session actually resolves.)
      for (const e of afterSwitch) {
        // switchModel stamps `variant: "default"` on the ref (spike-observed);
        // compare the identity fields only.
        expect(
          { id: e.eventModel?.id, providerID: e.eventModel?.providerID },
          `post-switch request must carry the price alias ref\n${context(followUp)}`,
        ).toEqual({ id: "model-compare/price", providerID: "openrouter" })
      }

      const completed = h
        .readWire()
        .filter((e) => e.type === "response" && e.sessionID === sessionID && e.kind === "primary")
      console.log(
        `[use-best evidence] session=${sessionID} pick=${JSON.stringify(pricePick)} ` +
          `followUpRuns=${afterSwitch.length} primaryResponses=${completed.length} ` +
          `runOk=${followUp.ok}`,
      )
    },
    240_000,
  )

  test(
    "case 2: /use-best refusal when the alias is disabled; the session stays on its pinned model",
    async () => {
      await h.setFixture("empty")

      // A working session in the zero-models state: the root default is the
      // disabled quality alias, so this run pins BASELINE_MODEL explicitly —
      // OpenCode's built-in fallback (meta/muse-wonder) is ZDR-blocked on this
      // account and would fail the run before the behavior under test runs.
      h.truncateWire()
      const first = h.run(["--model", BASELINE_MODEL, "Reply with exactly: one"])
      await h.settle()
      expect(first.ok, `plain run failed\n${context(first)}`).toBe(true)
      const sessionID = lastSessionID()
      const initial = h.primaryRequests("build").at(-1)
      expect(initial?.sessionID, `expected the plain run's request\n${context(first)}`).toBe(
        sessionID,
      )
      const fallbackWire = initial.wire

      const post = postCommand(sessionID, "use-best", "quality")
      expect(
        post.ok,
        `command POST failed\n${JSON.stringify(post)}\n${context({ stdout: "", stderr: "" })}`,
      ).toBe(true)

      // No switch: the refusal must not change the session model.
      const messages = await pollTranscript(
        sessionID,
        (m) => m.type === "model-switched",
        10_000,
        "the (absent) model-switched record",
      ).catch(() => [])
      expect(
        messages.some((m) => m.type === "model-switched"),
        "a refusal must not switch the session model",
      ).toBe(false)

      // The refusal notice is an inbox item with resume:false: it surfaces
      // at the session's NEXT turn, so the follow-up is issued first and the
      // transcript is polled afterwards.
      const followUp = h.run(["-s", sessionID, "--model", BASELINE_MODEL, "Reply with exactly: two"])
      await h.settle()
      const refusal = transcript(sessionID).find(
        (m) => m.type === "synthetic" && (m.text ?? "").includes("is currently disabled"),
      )
      expect(
        refusal?.text,
        `expected the refusal notice in the transcript after the follow-up\n${JSON.stringify(
          transcript(sessionID).filter((m) => m.type === "synthetic"),
        )}`,
      ).toBe(REFUSAL_TEXT)

      // The session keeps working on its pinned model — unswitched, no crash.
      const afterRefusal = h
        .readWire()
        .filter((e) => e.type === "request" && e.sessionID === sessionID && e.kind === "primary")
        .slice(1) // drop the initial run's request; the rest is the follow-up
      assertPrimaryWire(afterRefusal, "build", fallbackWire, followUp)
      expect(followUp.ok, `continuation run failed\n${context(followUp)}`).toBe(true)

      console.log(
        `[refusal evidence] session=${sessionID} fallback=${JSON.stringify(fallbackWire)} ` +
          `refusal=${JSON.stringify(refusal?.text ?? null)}`,
      )
    },
    240_000,
  )

  test(
    "case 3: startup offline — the stored pin serves when the local source fails",
    async () => {
      // Fresh fixture A state: the tick rewrites the doc cache and the pins.
      await h.setFixture("a")
      const aPick = h.expectedPick("a", "quality")

      // Swap to an exit-1 stub with source "local" and restart. Storage
      // persists: setup seeds from the cached doc + stored pin, the
      // background refresh REJECTS (caught and logged, no state change), and
      // the aliases stay on the last-known-good pick.
      breakStub()
      writeVariantConfig({ source: "local", scriptPath: h.STUB_FILE })
      await h.startServer()
      await h.waitReady("a")

      h.truncateWire()
      const run = h.run(["--agent", "mc-sub", "Reply with exactly: pong"])
      await h.settle()
      expect(run.ok, `dispatch failed on the last-known-good state\n${context(run)}`).toBe(true)
      assertPrimaryWire(h.primaryRequests("mc-sub"), "mc-sub", aPick, run)

      console.log(
        `[last-known-good evidence] brokenLocalSource=exit-1 pick=${JSON.stringify(aPick)} ` +
          `wire=${JSON.stringify(h.primaryRequests("mc-sub")[0].wire)}`,
      )
    },
    240_000,
  )

  test(
    "case 4: auto degrades to the remote catalog after the local source fails (network required)",
    async (ctx) => {
      if (!hasSqlite3()) {
        ctx.skip(true, "the sqlite3 CLI is needed to neutralize the persisted doc/cache record")
      }
      // Pre-flight: the case asserts a REAL remote fetch, so it skips cleanly
      // when the published catalog is unreachable.
      let online = false
      try {
        const response = await fetch(CATALOG_URL, { signal: AbortSignal.timeout(15_000) })
        online = response.ok
      } catch {
        online = false
      }
      if (!online) ctx.skip(true, `${CATALOG_URL} is unreachable — the remote fallback needs network`)

      // Remove the persisted doc/cache record (server STOPPED): fetchRemote
      // serves any record younger than 6 h, which would hide the fallback.
      // The DELETE takes out EVERY source identity's cached document, and
      // later cases seed from the local-stub record — so snapshot and restore
      // the rows around this case (surfaced 2026-10-11: with sqlite3 present
      // and the network reachable, case 4 stopped skipping and case 5's warm
      // start ran cold — no cached doc → no pins → every alias disabled).
      const cacheSnapshot = docCacheRows()
      try {
        await h.stopServer()
        await deleteDocCacheRow()
        breakStub()
        writeVariantConfig({ source: "auto", scriptPath: h.STUB_FILE })
        await h.startServer()

        // Warmup: activates the plugins; every alias is cold-disabled, so the
        // plain run goes through OpenCode's own fallback.
        const warmup = h.run(["Reply with exactly: ready"])
        await h.waitForWireLine(
          (e) => e.type === "models" && e.when === "first-request",
          60_000,
          "the probe's openrouter model list (first request)",
        )
        const enabledIds = openrouterIdsFromWire()

        // The tick: probePython passes → the broken local run fails → remote
        // fallback fetches the published catalog → the quality alias flips on.
        await h.waitForWireLine(
          (e) => {
            if (e.type !== "alias-state" || !Array.isArray(e.aliases)) return false
            const quality = e.aliases.find((a) => a.id === "model-compare/quality")
            return quality !== undefined && quality.enabled === true
          },
          240_000,
          "the quality alias enabled after the remote fallback",
        )

        // The expected pick, resolved from the very document the tick
        // persisted, with the plugin's own resolution logic (cold start: no
        // stored pin, no fallback, pinDays as configured).
        const doc = readDocCacheDoc()
        const expected = resolve({
          catalog: doc,
          p: "quality",
          runnable: (id) => enabledIds.includes(id),
          fallback: null,
          stored: null,
          now: Date.now(),
          pinDays: 0.00001,
          minLead: 0.03,
        }).targetId
        expect(
          expected,
          "the remote catalog must yield a runnable quality pick\n" +
            `doc models=${doc.models?.length} enabledIds=${enabledIds.length}`,
        ).toBeTruthy()

        const flip = h
          .readWire()
          .filter((e) => e.type === "alias-state")
          .at(-1)
          .aliases.find((a) => a.id === "model-compare/quality")
        expect(
          flip.modelID,
          `the alias flip points at ${JSON.stringify(flip.modelID)}, expected ${JSON.stringify(expected)}`,
        ).toBe(expected)

        h.truncateWire()
        const run = h.run(["--agent", "mc-sub", "Reply with exactly: pong"])
        await h.settle()
        expect(run.ok, `dispatch failed after the remote fallback\n${context(run)}`).toBe(true)
        assertPrimaryWire(h.primaryRequests("mc-sub"), "mc-sub", expected, run)

        console.log(
          `[remote-fallback evidence] source=auto(broken local) remoteDoc=${doc.generatedAt} ` +
            `pick=${JSON.stringify(expected)} wire=${JSON.stringify(h.primaryRequests("mc-sub")[0].wire)}`,
        )
      } finally {
        restoreDocCacheRows(cacheSnapshot)
      }
    },
    240_000,
  )

  test(
    "case 5: subagent launch with a disabled alias fails before any HTTP request",
    async () => {
      await h.setFixture("empty")

      h.truncateWire()
      const run = h.run(["--model", BASELINE_MODEL, DELEGATION_PROMPT])
      await h.settle()
      expect(run.ok, `the delegating run failed\n${context(run)}`).toBe(true)

      const output = `${run.stdout}\n${run.stderr}`
      expect(
        output,
        `expected OpenCode's Model unavailable error in the CLI output\n${context(run)}`,
      ).toContain("Model unavailable: openrouter/model-compare/quality")

      // The child never got as far as an HTTP request: the probe (first in
      // plugin order) logs every http.request — there must be none for mc-sub.
      expect(
        h.primaryRequests("mc-sub"),
        `the disabled-alias child must not produce any http.request\n${context(run)}`,
      ).toEqual([])
      expect(
        h.readWire().filter((e) => e.agent === "mc-sub"),
        `no wire events at all for the mc-sub child\n${context(run)}`,
      ).toEqual([])

      // The parent itself ran to completion on its own model.
      const parentResponses = h.primaryResponses("build")
      expect(
        parentResponses.length,
        `expected the parent's primary turn(s) to complete\n${context(run)}`,
      ).toBeGreaterThan(0)

      console.log(
        `[subagent evidence] delegator=build child=mc-sub(disabled quality alias) ` +
          `childRequests=0 parentResponses=${parentResponses.length}`,
      )
    },
    240_000,
  )

  test(
    "case 6: non-primary kinds run untouched with a disabled alias (title completes)",
    async () => {
      // Same zero-models instance as case 5: the quality alias is disabled
      // and the root default points at it, yet the session's title request —
      // a non-primary kind the guard must pass through — still completes.
      // The run pins BASELINE_MODEL (see the constant): the fallback choice
      // is ZDR-blocked on this account and would fail the primary run first.
      h.truncateWire()
      const run = h.run(["--model", BASELINE_MODEL, "Reply with exactly: three"])
      await h.settle()
      expect(run.ok, `plain run failed\n${context(run)}`).toBe(true)
      const output = `${run.stdout}\n${run.stderr}`
      expect(
        output,
        `the guard error must not surface for a plain run\n${context(run)}`,
      ).not.toContain(GUARD_ERROR)

      const sessionID = lastSessionID()
      const titleRequest = h
        .readWire()
        .find((e) => e.type === "request" && e.sessionID === sessionID && e.kind === "title")
      expect(
        titleRequest,
        `expected a title-kind request for the session\n${context(run)}`,
      ).toBeDefined()
      expect(
        typeof titleRequest.wire,
        `the title request must carry a wire model\n${JSON.stringify(titleRequest)}`,
      ).toBe("string")
      expect(
        titleRequest.wire.startsWith("model-compare/"),
        `the title request must run on a concrete model, got ${JSON.stringify(titleRequest.wire)}`,
      ).toBe(false)
      // The title generation is a real completion on a free model — its
      // latency is the provider's (observed 0.6 s–10 s), and the run command
      // returns as soon as the PRIMARY turn is done, so the response must be
      // WAITED for (bounded, observation-driven), not read after a settle.
      await h.waitForWireLine(
        (e) => e.type === "response" && e.sessionID === sessionID && e.kind === "title",
        60_000,
        "the title response for the session",
      )
      const titleResponse = h
        .readWire()
        .find((e) => e.type === "response" && e.sessionID === sessionID && e.kind === "title")
      expect(
        titleResponse?.status,
        `the title request must complete\n${JSON.stringify(titleResponse)}`,
      ).toBe(200)
      const primaryResponse = h
        .readWire()
        .find((e) => e.type === "response" && e.sessionID === sessionID && e.kind === "primary")
      expect(
        primaryResponse?.status,
        `the primary request must complete alongside it\n${JSON.stringify(primaryResponse)}`,
      ).toBe(200)

      console.log(
        `[title evidence] session=${sessionID} titleWire=${JSON.stringify(titleRequest.wire)} ` +
          `titleStatus=${titleResponse.status} primaryStatus=${primaryResponse.status}`,
      )
    },
    240_000,
  )

  test(
    "case 7: a plugin-file reload re-seeds from storage — same pick, no disabled gap",
    async (ctx) => {
      // The setup-re-ran proof reads the doc/cache record (see
      // docCacheAcquiredAt) — the same sqlite3 dependency case 4 has.
      if (!hasSqlite3()) {
        ctx.skip(true, "the sqlite3 CLI is needed to prove the plugin's setup re-ran")
      }

      // Fresh fixture A state: the kick-off tick rewrites the persisted doc
      // cache + pins (exactly the records the reload's re-seed reads; the
      // pin RECORD stays in storage regardless of its expiry — readRecord is
      // expiry-blind, so the seed re-enables the alias even with pinDays
      // 0.00001 long blown).
      await h.setFixture("a")
      const pick = h.expectedPick("a", "quality")

      // Baseline dispatch through the alias before the reload.
      h.truncateWire()
      const first = h.run(["--agent", "mc-sub", "Reply with exactly: pong"])
      await h.settle()
      expect(first.ok, `dispatch failed before the reload\n${context(first)}`).toBe(true)
      assertPrimaryWire(h.primaryRequests("mc-sub"), "mc-sub", pick, first)
      expect(
        `${first.stdout}\n${first.stderr}`,
        `the guard error must not surface before the reload\n${context(first)}`,
      ).not.toContain(GUARD_ERROR)

      // Touch a WATCHED plugin file — mtime only (utimes is the programmatic
      // `touch`), the content stays byte-identical. Verified live against
      // this very server shape: the watcher watches the package-style plugin
      // entry (the probe's index.ts) and fires on mtime alone, while the
      // plugin's real src/index.ts stays
      // unwatched (90 s utimes AND content-blip attempts each, no reload) —
      // so the probe's entry is the trigger, and OpenCode reloads ALL
      // plugins on it. Reloads can take tens of seconds; one utimes retry
      // covers a missed inotify event.
      const probeIndex = path.join(h.PROBE_DIR, "index.ts")
      const baseline = countSetupLines()
      const docBefore = docCacheAcquiredAt()
      utimesSync(probeIndex, new Date(), new Date())
      try {
        await waitForReloadSetupLine(
          baseline,
          90_000,
          "a new probe setup line after the watched-file touch",
        )
      } catch {
        utimesSync(probeIndex, new Date(), new Date())
        await waitForReloadSetupLine(
          baseline,
          90_000,
          "a new probe setup line after the watched-file touch (retry)",
        )
      }

      // Prove the model-compare plugin's setup re-ran (not just the probe's):
      // the reload's fresh kick-off tick rewrites the doc/cache record with a
      // new acquiredAt — a tick only ever starts from a setup.
      const docAfter = await waitForDocCacheBump(
        docBefore,
        45_000,
        "the reloaded plugin's kick-off tick rewriting the doc/cache record",
      )

      // The re-seeded registry: the reloaded plugin's setup seeded from the
      // persisted doc cache + pins BEFORE registering the transform, so the
      // quality alias is observed enabled at the SAME pick — no disabled gap.
      await h.waitForWireLine(
        (e) => {
          if (e.type !== "alias-state" || !Array.isArray(e.aliases)) return false
          const quality = e.aliases.find((a) => a.id === "model-compare/quality")
          return (
            quality !== undefined &&
            quality.enabled === true &&
            aliasTargetFrom(quality) === pick
          )
        },
        60_000,
        "the re-seeded quality alias observed enabled at the same pick",
      )

      // The dispatch after the reload: the re-seeded plugin serves the same
      // pick from storage — no restart needed, no guard error anywhere.
      h.truncateWire()
      const second = h.run(["--agent", "mc-sub", "Reply with exactly: pong"])
      await h.settle()
      expect(second.ok, `dispatch failed after the reload\n${context(second)}`).toBe(true)
      assertPrimaryWire(h.primaryRequests("mc-sub"), "mc-sub", pick, second)
      const output = `${second.stdout}\n${second.stderr}`
      expect(
        output,
        `the guard error must not surface after the reload\n${context(second)}`,
      ).not.toContain(GUARD_ERROR)
      expect(
        output,
        `a disabled-alias launch failure would mean the re-seed left a gap\n${context(second)}`,
      ).not.toContain("Model unavailable")

      console.log(
        `[reload-reseed evidence] setupBaseline=${baseline} ` +
          `docCacheAcquiredAt=${new Date(docBefore).toISOString()}->${new Date(docAfter).toISOString()} ` +
          `pick=${JSON.stringify(pick)} wire=${JSON.stringify(h.primaryRequests("mc-sub")[0]?.wire)}`,
      )
    },
    480_000,
  )
})
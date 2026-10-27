// tests/integration/harness.mjs
// Live-server harness for the model-compare plugin (Task 13). Spawns a
// dedicated `opencode serve` in the scratch project (tests/integration/project/,
// port 14721, OPENCODE_SERVER_PASSWORD=integration-only), drives it with
// `opencode run --server …`, and reads the probe plugin's observations from
// tests/integration/wire.jsonl.
//
// Mechanisms proven by the design spike and by this suite's own probes:
// - `opencode serve` binds within seconds, but PLUGINS ACTIVATE ON THE FIRST
//   SESSION. Plugin setup completes before that session's model call, so the
//   readiness sequence is: one warmup `opencode run` → wait for the probe's
//   `setup` line in wire.jsonl → wait for the alias-state observation that
//   matches the CURRENT fixture's expectation. No fixed sleeps anywhere.
// - The plugin's console.warn does NOT land in the server's stdio (serve
//   writes nothing there, with or without --print-logs — which also breaks the
//   server's client handshake) nor in the shared opencode log file. The
//   refresh's completion is therefore observed THROUGH THE REGISTRY: the
//   probe polls ctx.model.list() and logs every change to the plugin's alias
//   models, and the harness waits until the quality alias's observed target
//   equals the current fixture's pick (or is disabled in the guard phase —
//   list() omits disabled aliases entirely, so absence IS the disabled
//   state). When the seed already yields the current pick, the wait matches
//   the first snapshot — the pending refresh re-adopts the same pick, a
//   no-op for dispatch.
// - Plugin storage is keyed by plugin id in OpenCode's database. The suite
//   gives every run its OWN scratch database (XDG_DATA_HOME → tests/
//   integration/data/<run>/, see runDirs), so pins survive server restarts
//   WITHIN a run but never leak into — or in from — the machine's live
//   opencode state (whose live sessions re-write the same records mid-run).
//   §7 keeps a runnable last-known-good even when fresh rules yield nothing —
//   a persisted pin would defeat the pick-change case. The scratch config
//   therefore sets pinDays: 0.00001 (~0.9 s): every pin is expired by the
//   time the next server instance's refresh resolves, so each restart adopts
//   the CURRENT fixture's top pick.
// - The spawned server (and the run client) also get a scratch
//   OPENCODE_CONFIG_DIR: the user's global config installs
//   model-compare-opencode-plugin, whose generation shares the plugin id with
//   this repo's local entry — OpenCode keeps the FIRST generation per id, so
//   the project entry (the only one carrying options) was dropped as a
//   duplicate and the global package plugin ran with default options instead
//   (observed under opencode 2.0.16: the tick's doc-cache identity was
//   local:vendored, never the stub's). Hiding the global config from the
//   suite leaves the project's options as the only source.
// - The guard case needs the alias DISABLED. With warm storage the setup seed
//   always finds the pin under the previous fixture's effective-weights key.
//   The guard phase therefore rewrites the project config with a
//   never-used-before pin key (a quality weight override changes the effective
//   weights; the guard tick itself writes no pin), so nothing is seeded, the
//   empty-catalog refresh resolves "none", and the aliases stay disabled.
// - State control: the plugin reads options once per server instance. Changing
//   picks = rewrite the fixture the stub prints + restart the server.

import { spawn, execFileSync } from "node:child_process"
import net from "node:net"
import {
  existsSync,
  mkdirSync,
  openSync,
  closeSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import os from "node:os"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { fileURLToPath } from "node:url"

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const HERE = path.dirname(fileURLToPath(import.meta.url))

export const INTEGRATION_DIR = HERE
export const REPO_ROOT = path.resolve(HERE, "..", "..")
export const PROJECT_DIR = path.join(HERE, "project")
export const AGENTS_DIR = path.join(PROJECT_DIR, ".opencode", "agents")
export const PROBE_DIR = path.join(HERE, "probe")
export const WIRE_FILE = path.join(HERE, "wire.jsonl")
export const SERVER_LOG = path.join(HERE, "server.out")
export const FIXTURE_FILE = path.join(HERE, "project-fixture.json")
// ONE stub script serves every phase: the plugin's document cache is keyed by
// source identity (local:<scriptPath>, spec §7.9), so a phase that changed the
// script path would be a different source and a cold start. Phases change what
// the stub PRINTS (FIXTURE_FILE) or whether it FAILS (MODE_FILE) instead.
export const STUB_FILE = path.join(HERE, "project-fixture-stub.py")
export const MODE_FILE = path.join(HERE, "project-fixture-mode.txt")
export const PLUGIN_SRC_DIR = path.join(REPO_ROOT, "src")
export const NO_QUALITY_FIXTURE = path.join(REPO_ROOT, "fixtures", "catalog-no-quality.json")

export const PORT = 14721
export const SERVER_URL = `http://127.0.0.1:${PORT}`
export const SERVER_PASSWORD = "integration-only"

// ---- per-run scratch data/config dirs --------------------------------------

// The spawned server (and every run client) get their own OpenCode home for
// the whole suite run (see the header's isolation notes). Unique per harness
// module instance — vitest runs the two integration files sequentially, each
// with a fresh module graph, so each file's phases share one scratch store
// while the two files stay isolated from each other and from live state.
// One seeding is deliberate: the run's OPENROUTER_API_KEY env export (server
// and run clients, see runDirs) — the fresh scratch database's legacy
// credential import does not populate the credential table under opencode
// 2.0.16, and without a resolvable key the openrouter provider materializes
// ZERO models, so every model call would fail. A/B-verified 2026-10-22 under
// scratch data+config dirs: the env export alone materializes the provider
// (372 models, warmup completes); a copy of the live auth.json alone
// materializes none — so NO auth.json copy is made, keeping the live
// credential out of the scratch tree entirely.
export const RUN_SCRATCH_ROOT = path.join(HERE, "data")

let runDirsCache = null
function runDirs() {
  if (runDirsCache === null) {
    // Sweep stale run-* scratch roots before creating this run's: a SIGKILLed
    // run (or a harness crash) never reaches finalCleanup and leaves its
    // scratch store behind. Safe under the suite's single-session constraint
    // — no other run may be live (Ruling: the suite must run from ONE session
    // at a time per worktree).
    if (existsSync(RUN_SCRATCH_ROOT)) {
      for (const entry of readdirSync(RUN_SCRATCH_ROOT)) {
        if (entry.startsWith("run-")) {
          rmSync(path.join(RUN_SCRATCH_ROOT, entry), { recursive: true, force: true })
        }
      }
    }
    const root = path.join(RUN_SCRATCH_ROOT, `run-${process.pid}-${randomUUID().slice(0, 8)}`)
    const data = path.join(root, "data")
    const config = path.join(root, "config")
    mkdirSync(path.join(data, "opencode"), { recursive: true })
    mkdirSync(config, { recursive: true })
    // The only credential the scratch setup needs is the openrouter API key,
    // exported as OPENROUTER_API_KEY to the server and run clients (see the
    // header's seeding note — the auth.json copy is NOT load-bearing). The
    // live auth.json is only ever READ here; nothing of it lands on disk.
    const liveData = path.join(
      process.env.XDG_DATA_HOME ?? path.join(os.homedir(), ".local", "share"),
      "opencode",
    )
    const authSrc = path.join(liveData, "auth.json")
    let openrouterApiKey
    if (existsSync(authSrc)) {
      try {
        const entry = JSON.parse(readFileSync(authSrc, "utf8")).openrouter
        if (entry?.type === "api" && typeof entry.key === "string" && entry.key !== "") {
          openrouterApiKey = entry.key
        }
      } catch {
        // An unparseable live auth file leaves the provider unauthenticated;
        // the suite's model calls fail visibly rather than silently.
      }
    }
    runDirsCache = { root, data, config, openrouterApiKey }
  }
  return runDirsCache
}

// The scratch database the run's server writes (cases that inspect or
// neutralize the plugin's persisted records address THIS one — never the
// machine's live database).
export function opencodeDbPath() {
  return path.join(runDirs().data, "opencode", "opencode.db")
}

const RUN_TIMEOUT_MS = 150_000 // B-phase runs block through the 90-105s reload chain (ledger: thin headroom; flakes observed 2026-10-10)
const SETUP_TIMEOUT_MS = 120_000 // post-restart alias flips observed at 90-105s
const PORT_TIMEOUT_MS = 30_000

// The suite's healthy baseline model — the id every unpinned run is pinned
// to, shared by the warmup (harness) and the baseline runs (ops-cases). ONE
// source of truth: the literal's validity depends on the live OpenRouter
// catalog, and the two comment blocks that used to describe the unpinned
// fallback disagreed (the muse-wonder text here predates the 2026-10-22
// opencode-2.0.16 isolation work — experiment-verified since: an UNPINNED
// request falls to OpenCode's own default, `available[0]`, currently the
// opencode provider's flint-40b-free, whose endpoint 503s and is retried
// with backoff for minutes SERVER-SIDE; a killed client does not stop the
// retries, which then hang the next server's graceful shutdown and cascade
// into port-contention failures). Pinning the warmup and the baseline runs
// to this healthy model costs nothing — the probe logs even guard-aborted
// requests — and keeps shutdowns clean.
export const BASELINE_MODEL = "openrouter/z-ai/glm-5.3-flash"

// The warmup run's model (waitReady). The phase's own alias may be ABSENT
// (cold start) or DISABLED (guard phase) when the warmup fires — exactly the
// unpinned situation BASELINE_MODEL's note above describes; the warmup only
// needs to activate the plugins and produce the observations.
const WARMUP_MODEL = BASELINE_MODEL

// ---- prerequisites ----------------------------------------------------------

function hasBinary(cmd, args = ["--version"]) {
  try {
    execFileSync(cmd, args, { stdio: "ignore", timeout: 20_000 })
    return true
  } catch {
    return false
  }
}

export const hasOpencode = hasBinary("opencode")
export const hasPython3 = hasBinary("python3", ["-c", "print('ok')"])

// ---- generated artifacts ----------------------------------------------------

// The stub prints whichever fixture copy the harness last wrote. Same argv
// contract as tests/fixtures/stub-model-compare.py (--version / --catalog).
const STUB_SOURCE = (fixtureFile, modeFile, stubFile, label) => `#!/usr/bin/env python3
"""Integration-harness stub (${label}): prints the harness-controlled fixture.

Mirrors tests/fixtures/stub-model-compare.py's argv contract, but reads the
fixture copy this suite rewrites between server restarts, so setFixture can
change the plugin's picks deterministically (no network anywhere). When the
mode file says "fail" the stub exits 1 for every argv — the SAME source
identity, now broken (the "source went offline" scenario).
"""

import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
FIXTURE = os.path.join(HERE, ${JSON.stringify(path.basename(fixtureFile))})
MODE = os.path.join(HERE, ${JSON.stringify(path.basename(modeFile))})

try:
    with open(MODE, encoding="utf-8") as handle:
        if handle.read().strip() == "fail":
            print("stub: failing on purpose (mode file says fail)", file=sys.stderr)
            sys.exit(1)
except FileNotFoundError:
    pass

if "--version" in sys.argv[1:]:
    print("model-compare 9.9.9")
elif "--catalog" in sys.argv[1:]:
    with open(FIXTURE, encoding="utf-8") as handle:
        sys.stdout.write(handle.read())
else:
    print("usage: ${path.basename(stubFile)} [--version | --catalog]", file=sys.stderr)
    sys.exit(2)
`

export function writeStubs() {
  writeFileSync(STUB_FILE, STUB_SOURCE(FIXTURE_FILE, MODE_FILE, STUB_FILE, "pick fixtures A/B/empty"))
}

// Fixture variants. A = the recorded no-quality catalog verbatim (the plugin
// ranks verbatim from its published rankings: quality top = first entry).
// B = a copy with every ranking reversed (quality top = the old last entry).
// empty = a valid (schema v4) document with ZERO models (the guard case's data
// source; it was written with schema_version 1 before the plugin went v2-only,
// which made it an INVALID document instead of an empty one).
export function fixtureVariants() {
  const a = JSON.parse(readFileSync(NO_QUALITY_FIXTURE, "utf8"))
  const b = structuredClone(a)
  for (const p of ["balanced", "price", "quality"]) {
    b.rankings[p] = [...a.rankings[p]].reverse()
  }
  const empty = {
    schema_version: 4,
    generated_at: "2026-10-09T00:00:00+00:00",
    models: [],
  }
  return { a, b, empty }
}

// 0.5 plus a few millionths: valid (finite, >= 0), different on every call.
function guardOverridePrice() {
  return 0.5 + (Date.now() % 1_000_000) / 1e9
}

// The scratch project's opencode.jsonc. `shape` selects the fixture phase:
//   "a" | "b"    — verbatim-ranking dispatch phases (no weight override)
//   "empty"      — guard phase: the stub prints an empty (zero-model) catalog +
//                  a quality weight override that hashes to a pin key nothing
//                  ever wrote, so the quality alias is not seeded and stays
//                  disabled (balanced/price keep their pins)
export function renderProjectConfig(shape) {
  const dispatch = shape !== "empty"
  const scriptPath = STUB_FILE
  const weightOverride = dispatch
    ? ""
    : `,
        // Guard phase only: a quality weight override shifts the effective-
        // weights hash, so the setup seed finds NO pin for the quality alias
        // (the dispatch phases ran without an override); balanced and price
        // keep their pins and stay enabled, which proves the transform
        // registered. The override's value is unique per phase: a tick with a
        // pin that no candidate can replace re-writes it under the current
        // weights key, and the run's scratch store keeps earlier phases' pins,
        // so a fixed override value would be "never-used" only the first time.
        "weights": { "quality": { "price": ${guardOverridePrice()} } }`
  return `{
  // Integration scratch project (Task 13). GENERATED by harness.mjs and
  // git-ignored: it holds absolute paths of this checkout. The suite writes
  // it before every server start and removes it in finalCleanup.
  "$schema": "https://opencode.ai/config.json",
  // Root default = the quality alias: every primary run (any agent) dispatches
  // through it to the current pick.
  "model": "openrouter/model-compare/quality",
  // The title agent must complete 200 through an authenticated provider (an
  // ops case asserts it): the user's global config — whose small_model this
  // pins — is hidden from the suite (scratch OPENCODE_CONFIG_DIR), so the
  // suite supplies the setting itself.
  "agents": { "title": { "model": "openrouter/xiaomi/mimo-v2.6-flash" } },
  "plugins": [
    // Probe FIRST: its http.request hook runs before the guard's, so even an
    // aborted (guard-error) request is still logged.
    { "package": ${JSON.stringify(PROBE_DIR)} },
    {
      // The plugin under test, loaded straight from the repo's src/ —
      // OpenCode's local loader resolves src/index.ts (and the ./tui half,
      // src/tui.tsx) directly from a directory target.
      "package": ${JSON.stringify(PLUGIN_SRC_DIR)},
      "options": {
        "source": "local",
        "scriptPath": ${JSON.stringify(scriptPath)},
        // Pins persist in the run's scratch plugin storage across restarts,
        // and §7 keeps a runnable last-known-good even against an empty
        // catalog. 0.00001 days (~0.9 s) expires every pin between server
        // instances, so each restart's refresh adopts the CURRENT fixture's
        // top pick (the stale-dispatch discipline's precondition).
        "pinDays": 0.00001${weightOverride}
      }
    }
  ]
}
`
}

export function writeProjectConfig(shape) {
  writeFileSync(path.join(PROJECT_DIR, "opencode.jsonc"), renderProjectConfig(shape))
}

function writeFixtures(shape) {
  const { a, b, empty } = fixtureVariants()
  writeFileSync(FIXTURE_FILE, JSON.stringify(shape === "empty" ? empty : shape === "b" ? b : a, null, 2) + "\n")
  setStubMode("ok")
}

// "ok" (print the fixture) or "fail" (exit 1): the stub's mode, read on every
// run. The script path never changes, so the document cache identity is stable.
export function setStubMode(mode) {
  writeFileSync(MODE_FILE, `${mode}\n`)
}

// The scratch project's opencode.jsonc is GENERATED (absolute paths of this
// checkout, per-phase options) and git-ignored: every phase writes it before
// starting the server (setFixture / writeVariantConfig), and the suite removes
// it at the end so no machine-specific file lingers.
export function removeGeneratedConfig() {
  rmSync(path.join(PROJECT_DIR, "opencode.jsonc"), { force: true })
}

// ---- server lifecycle -------------------------------------------------------

let serverProc = null
let serverPid = null

function clientEnv() {
  const dirs = runDirs()
  return {
    ...process.env,
    // OpenCode 2.1.4 resolves the project from PWD (not the spawned cwd), so
    // pin it: a vitest run from the repo root would otherwise load the repo
    // root's project config and never the scratch project's plugins.
    PWD: PROJECT_DIR,
    OPENCODE_SERVER_PASSWORD: SERVER_PASSWORD,
    // Per-run OpenCode home: a fresh kv database (the plugin's storage) plus
    // an empty global config dir — both isolated from live state (runDirs).
    XDG_DATA_HOME: dirs.data,
    OPENCODE_CONFIG_DIR: dirs.config,
    // The provider key the scratch database cannot supply (see runDirs).
    ...(dirs.openrouterApiKey !== undefined ? { OPENROUTER_API_KEY: dirs.openrouterApiKey } : {}),
  }
}

function tryConnect() {
  return new Promise((resolve) => {
    const socket = net.connect({ port: PORT, host: "127.0.0.1" })
    socket.once("connect", () => {
      socket.destroy()
      resolve(true)
    })
    socket.once("error", () => {
      socket.destroy()
      resolve(false)
    })
  })
}

async function waitForPort(available, timeoutMs, describe) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if ((await tryConnect()) === available) return
    await sleep(250)
  }
  throw new Error(
    `timed out after ${timeoutMs}ms waiting for the server ${available ? "to listen" : "to release"} ` +
      `127.0.0.1:${PORT} (${describe})\n--- server log tail ---\n${serverLogTail()}`,
  )
}

export function serverLogTail(chars = 4000) {
  try {
    const text = readFileSync(SERVER_LOG, "utf8")
    return text.length > chars ? text.slice(-chars) : text
  } catch {
    return "(no server log)"
  }
}

export async function startServer() {
  if (serverProc !== null) await stopServer()
  writeStubs()
  // Truncate the per-instance server log AND the wire log: the readiness
  // predicates and case assertions must only ever see the CURRENT instance's
  // observations — stale lines from earlier runs/phases could satisfy a wait
  // before this instance's plugin has done anything.
  const fd = openSync(SERVER_LOG, "w")
  closeSync(fd)
  const wireFd = openSync(WIRE_FILE, "w")
  closeSync(wireFd)
  // Append-mode fds handed to the child: each instance's log is self-contained
  // and the child owns its descriptor for its whole life.
  const outFd = openSync(SERVER_LOG, "a")
  const proc = spawn(
    "opencode",
    ["serve", "--hostname", "127.0.0.1", "--port", String(PORT)],
    {
      cwd: PROJECT_DIR,
      env: clientEnv(),
      stdio: ["ignore", outFd, outFd],
      detached: true, // own process group, so stopServer can kill wrapper + server
    },
  )
  closeSync(outFd) // the child dup()ed it; our copy is no longer needed
  serverProc = proc
  serverPid = proc.pid
  await waitForPort(true, PORT_TIMEOUT_MS, `opencode serve pid ${proc.pid}`)
  return serverPid
}

export async function stopServer() {
  if (serverProc === null) return
  const pid = serverPid
  serverProc = null
  serverPid = null
  // Kill the whole process group (snap's wrapper forks the real server).
  try {
    process.kill(-pid, "SIGTERM")
  } catch {
    /* already gone */
  }
  await waitForPort(false, 15_000, "SIGTERM to take effect")
  try {
    process.kill(-pid, 0) // still alive?
    process.kill(-pid, "SIGKILL")
  } catch {
    /* gone */
  }
  await waitForPort(false, 10_000, "SIGKILL fallback")
}

// ---- client -----------------------------------------------------------------

// Shells `opencode run --server …` in the scratch project. Never throws: the
// result carries ok/status/stdout/stderr so the guard-error case can assert on
// a failing run's output.
export function run(cliArgs, opts = {}) {
  const args = ["run", "--server", SERVER_URL, "--auto", ...cliArgs]
  try {
    const stdout = execFileSync("opencode", args, {
      cwd: PROJECT_DIR,
      env: clientEnv(),
      encoding: "utf8",
      timeout: opts.timeoutMs ?? RUN_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
    })
    return { ok: true, status: 0, stdout, stderr: "" }
  } catch (error) {
    return {
      ok: false,
      status: error.status ?? null,
      stdout: typeof error.stdout === "string" ? error.stdout : "",
      stderr: typeof error.stderr === "string" ? error.stderr : "",
      message: String(error.message).slice(0, 800),
    }
  }
}

// ---- readiness --------------------------------------------------------------

async function poll(check, timeoutMs, describe) {
  const deadline = Date.now() + timeoutMs
  let lastError = null
  while (Date.now() < deadline) {
    try {
      const result = check()
      if (result) return result
      lastError = null
    } catch (error) {
      lastError = error
    }
    await sleep(250)
  }
  throw new Error(
    `timed out after ${timeoutMs}ms waiting for ${describe}` +
      (lastError === null ? "" : ` (last error: ${lastError.message})`) +
      `\n--- server log tail ---\n${serverLogTail()}` +
      `\n--- wire tail ---\n${wireTail()}`,
  )
}

function readLines(file) {
  if (!existsSync(file)) return []
  return readFileSync(file, "utf8").split("\n").filter((line) => line.trim() !== "")
}

export function wireTail(chars = 3000) {
  try {
    const text = readFileSync(WIRE_FILE, "utf8")
    return text.length > chars ? text.slice(-chars) : text
  } catch {
    return "(no wire log)"
  }
}

export function waitForWireLine(predicate, timeoutMs = SETUP_TIMEOUT_MS, describe = "a wire line") {
  return poll(() => readLines(WIRE_FILE).some((line) => {
    try {
      return predicate(JSON.parse(line))
    } catch {
      return false
    }
  }), timeoutMs, describe)
}

let openrouterEnabled = null

// The pick id an observed alias entry points at: the registry's modelID when
// it exposes one, else the name the applier writes
// ("Model Compare: <p> → <id>[(fallback)]").
function aliasTargetId(alias) {
  if (typeof alias.modelID === "string" && alias.modelID !== "") return alias.modelID
  const name = typeof alias.name === "string" ? alias.name : ""
  const at = name.indexOf("→ ")
  return at === -1 ? null : name.slice(at + 2)
}

function qualityAliasState() {
  return (e) =>
    e.type === "alias-state" && Array.isArray(e.aliases)
      ? e.aliases.find((a) => a.id === "model-compare/quality") ?? null
      : null
}

// One warmup run: triggers plugin activation for the (re)started server, then
// the probe's setup line and the alias state matching THIS phase's
// expectation must both land. Ends by truncating wire.jsonl so case
// assertions only see their own runs.
export async function waitReady(shape) {
  await run(["--model", WARMUP_MODEL, "Reply with exactly: ready"])
  await waitForWireLine((e) => e.type === "setup", SETUP_TIMEOUT_MS, "the probe's setup line")
  await waitForWireLine(
    (e) => e.type === "models" && e.when === "first-request",
    SETUP_TIMEOUT_MS,
    "the probe's openrouter model list (first request)",
  )
  captureModels()
  if (shape === "empty") {
    // Guard phase: nothing is seeded under the guard config's never-used pin
    // key, so the quality alias must end up DISABLED — and a disabled alias
    // is OMITTED from ctx.model.list() entirely (observed live), so the
    // expectation is "quality absent or enabled:false, while another alias's
    // presence proves the transform registered". The empty catalog's refresh
    // resolves "none" (no fallback configured) and keeps it that way.
    await waitForWireLine(
      (e) => {
        if (e.type !== "alias-state" || !Array.isArray(e.aliases)) return false
        const quality = e.aliases.find((a) => a.id === "model-compare/quality") ?? null
        const others = e.aliases.filter((a) => a.id !== "model-compare/quality")
        return (quality === null || quality.enabled === false) && others.length > 0
      },
      SETUP_TIMEOUT_MS,
      "the quality alias observed disabled (guard phase seed)",
    )
  } else {
    const pick = expectedPick(shape, "quality")
    await waitForWireLine(
      (e) => {
        const alias = qualityAliasState()(e)
        return alias !== null && alias.enabled === true && aliasTargetId(alias) === pick
      },
      SETUP_TIMEOUT_MS,
      `the quality alias observed pointing at the fixture "${shape}" pick ${pick}`,
    )
  }
  truncateWire()
}

function captureModels() {
  const entries = readWire().filter((e) => e.type === "models" && Array.isArray(e.openrouter))
  if (entries.length > 0) openrouterEnabled = entries.at(-1).openrouter
}

export function openrouterEnabledIds() {
  return openrouterEnabled ?? []
}

// ---- wire access ------------------------------------------------------------

export function readWire() {
  return readLines(WIRE_FILE)
    .map((line) => {
      try {
        return JSON.parse(line)
      } catch {
        return null
      }
    })
    .filter(Boolean)
}

export function truncateWire() {
  const fd = openSync(WIRE_FILE, "w")
  closeSync(fd)
}

export function primaryRequests(agent) {
  return readWire().filter(
    (e) => e.type === "request" && e.kind === "primary" && e.agent === agent,
  )
}

export function primaryResponses(agent) {
  return readWire().filter(
    (e) => e.type === "response" && e.kind === "primary" && e.agent === agent,
  )
}

// The pick the CURRENT fixture must resolve to: the first id of the fixture's
// ranking that OpenCode lists as an enabled openrouter model — exactly the
// plugin's runnable-set walk (§7.1).
export function expectedPick(shape, priority = "quality") {
  const { a, b } = fixtureVariants()
  const doc = shape === "b" ? b : a
  const ids = doc.rankings[priority] ?? []
  const enabled = openrouterEnabledIds()
  const pick = ids.find((id) => enabled.includes(id))
  if (pick === undefined) {
    throw new Error(
      `no runnable candidate for ${priority} in fixture "${shape}": ranking head ` +
        `${JSON.stringify(ids.slice(0, 3))}, enabled openrouter ids ` +
        `${enabled.length > 0 ? `${enabled.length} entries` : "(not captured)"}`,
    )
  }
  return pick
}

// Small settle after a CLI run: the probe writes synchronously during the
// requests, and the CLI only exits once the session is done — this is belt and
// braces for the file write, not a timing dependency.
export async function settle() {
  await sleep(400)
}

// ---- phase control ----------------------------------------------------------

// Rewrites the fixture copy + project config for `shape`, (re)starts the
// server, and waits for full readiness (probe setup + the alias state this
// phase expects). Every state change in the suite goes through this.
export async function setFixture(shape) {
  writeFixtures(shape)
  writeProjectConfig(shape)
  await startServer()
  await waitReady(shape)
}

// ---- cleanup ----------------------------------------------------------------

export async function finalCleanup() {
  await stopServer()
  removeGeneratedConfig()
  // The run's scratch OpenCode home (fresh kv database) goes with it:
  // nothing of the run survives on disk.
  if (runDirsCache !== null) {
    rmSync(runDirsCache.root, { recursive: true, force: true })
    runDirsCache = null
  }
  // Orphan verification (self-review requirement): anything still serving the
  // integration port is killed; the suite asserts none remain.
  try {
    const out = execFileSync("pgrep", ["-f", `opencode serve --hostname 127.0.0.1 --port ${PORT}`], {
      encoding: "utf8",
    })
    const pids = out.split("\n").filter(Boolean).map(Number)
    if (pids.length > 0) {
      for (const pid of pids) {
        try {
          process.kill(pid, "SIGKILL")
        } catch {
          /* gone */
        }
      }
      console.warn(`[integration] killed orphaned server processes: ${pids.join(", ")}`)
    }
  } catch {
    /* pgrep exit 1 = no orphans */
  }
}
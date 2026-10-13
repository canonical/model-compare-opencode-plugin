// src/sources/local.ts
// The local catalog source (design §9, §11): run the vendored script with
// execFile — no shell, a timeout, and a minimal environment — then parse and
// validate whatever it printed. Any failure (missing interpreter, non-zero
// exit, timeout, invalid JSON, rejected document) rejects as
// "local source failed: <reason>"; the exit code only refines the message,
// with stderr informing it (§9).

import { execFile as execFileCallback } from "node:child_process"
import { promisify } from "node:util"
import { validateCatalog } from "../core/catalog"
import type { Sourced } from "../core/types"

const execFile = promisify(execFileCallback)

const STDERR_TAIL_CHARS = 500

// execFile's default maxBuffer is 1 MiB — easily exceeded by a catalog
// stdout, and the default kill would report it as a generic failure. An
// explicit, generous cap keeps normal runs safe while bounding memory.
export const MAX_BUFFER_BYTES = 64 * 1024 * 1024 // 64 MiB

// The version probe prints one line; ten seconds is generous. A hung
// interpreter (a stuck version-manager shim) must not stall the refresh tick.
const PROBE_TIMEOUT_MS = 10_000

// Environment variables the script may need beyond HOME and PATH (design
// §11): its cache location, the AA key, proxy settings in both casings, and
// custom CA paths. Passed through only when set and non-empty.
const PASSTHROUGH_ENV = [
  "XDG_CACHE_HOME",
  "AA_API_KEY",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
] as const

// The shape execFile rejects with on failure: `code` is the exit status for a
// non-zero exit, "ENOENT" when the interpreter is missing, and null when the
// child was killed by a signal; `stdout`/`stderr` carry what was collected.
type ExecFileError = Error & {
  code?: string | number
  killed?: boolean
  signal?: NodeJS.Signals | null
  stdout?: string
  stderr?: string
}

// The script's environment (design §11): HOME and PATH from process.env
// (omitted when absent) plus the passthrough list when set and non-empty.
// Built fresh — process.env itself is never touched.
export function scriptEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const key of ["HOME", "PATH"] as const) {
    const value = process.env[key]
    if (value !== undefined) env[key] = value
  }
  for (const key of PASSTHROUGH_ENV) {
    const value = process.env[key]
    if (value !== undefined && value !== "") env[key] = value
  }
  return env
}

// The trimmed last chunk of stderr for failure messages; empty stderr
// contributes nothing to the message.
function stderrTail(stderr: string | undefined): string {
  const text = (stderr ?? "").trim()
  if (text === "") return ""
  const tail = text.length > STDERR_TAIL_CHARS ? text.slice(-STDERR_TAIL_CHARS) : text
  return `; stderr: ${tail}`
}

// Whether the plugin can run the vendored script at all: python3 present and
// at least 3.10 (design §9). The reason names what failed.
export async function probePython(
  timeoutMs = PROBE_TIMEOUT_MS,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  let version: string
  try {
    const { stdout } = await execFile(
      "python3",
      ["-c", "import sys; print('.'.join(map(str, sys.version_info[:2])))"],
      { timeout: timeoutMs, maxBuffer: MAX_BUFFER_BYTES },
    )
    version = stdout.trim()
  } catch (error) {
    const err = error as ExecFileError
    if (err.code === "ENOENT") {
      return { ok: false, reason: "python3 not found (spawn ENOENT)" }
    }
    if (err.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
      return { ok: false, reason: `python3 probe output exceeded the ${MAX_BUFFER_BYTES / (1024 * 1024)} MiB cap` }
    }
    if (err.killed && err.signal) {
      return { ok: false, reason: `python3 probe timed out after ${timeoutMs}ms` }
    }
    return { ok: false, reason: `python3 could not be probed: ${err.message}` }
  }

  const match = /^(\d+)\.(\d+)$/.exec(version)
  if (match === null) {
    return {
      ok: false,
      reason: `python3 reported unparseable version info: ${JSON.stringify(version)}`,
    }
  }
  const major = Number(match[1])
  const minor = Number(match[2])
  if (major < 3 || (major === 3 && minor < 10)) {
    return { ok: false, reason: `python3 is ${major}.${minor}, need >= 3.10` }
  }
  return { ok: true }
}

// Run the script (an explicit path — resolving the vendored default is the
// caller's job), validate its stdout, and stamp the plugin's own acquisition
// time on the document (design §5, §9).
export async function runLocalScript(
  scriptPath: string,
  timeoutMs = 60_000,
): Promise<Sourced> {
  let stdout: string
  try {
    const result = await execFile("python3", [scriptPath, "--catalog"], {
      env: scriptEnv(),
      timeout: timeoutMs,
      maxBuffer: MAX_BUFFER_BYTES,
    })
    stdout = result.stdout
  } catch (error) {
    const err = error as ExecFileError
    const stderr = stderrTail(err.stderr)
    if (err.code === "ENOENT") {
      throw new Error(`local source failed: python3 not found (spawn ENOENT)${stderr}`)
    }
    // Checked before the signal branch: the maxBuffer kill also sets
    // killed/signal, but its reason is distinct — the output cap, not the
    // timeout.
    if (err.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
      throw new Error(
        `local source failed: script output exceeded the ${MAX_BUFFER_BYTES / (1024 * 1024)} MiB cap${stderr}`,
      )
    }
    if (err.signal) {
      const cause = err.killed
        ? `timed out after ${timeoutMs}ms`
        : `terminated by ${err.signal}`
      throw new Error(`local source failed: ${cause} (killed with ${err.signal})${stderr}`)
    }
    if (typeof err.code === "number") {
      throw new Error(`local source failed: exit code ${err.code}${stderr}`)
    }
    throw new Error(`local source failed: ${err.message}${stderr}`)
  }

  let raw: unknown
  try {
    raw = JSON.parse(stdout)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`local source failed: invalid JSON on stdout (${message})`)
  }

  const validated = validateCatalog(raw)
  if (!validated.ok) {
    throw new Error(`local source failed: invalid catalog document: ${validated.reason}`)
  }
  return { doc: validated.catalog, acquiredAt: Date.now() }
}
// src/sources/index.ts
// Source selection and acquisition (design §3, §9): pick the catalog source
// and run it. "local" runs the configured-or-vendored script and rejects on
// failure — the caller keeps its last-known-good document. "auto" probes
// python first, runs local when it passes, and degrades to the remote catalog
// with an actionable warning when python is unusable or the local run fails
// (§3: warn and degrade, never throw from setup). "remote" fetches the
// published catalog without ever touching python. Only a failed remote
// fallback rejects.

import { fileURLToPath } from "node:url"
import type { Config } from "../config"
import type { Sourced } from "../core/types"
import { localIdentity, remoteIdentity, type Storage } from "../opencode/storage"
import { probePython, runLocalScript } from "./local"
import { fetchRemote } from "./remote"

// The vendored script, resolved from this module (src/sources/) back to the
// package root so it is found regardless of the process's working directory.
const VENDORED_SCRIPT = fileURLToPath(new URL("../../vendor/model_compare.py", import.meta.url))

// Injectable seams for tests; each defaults to the real implementation.
// storage is required because the remote path cannot proceed without it.
export type AcquireDeps = {
  storage: Storage
  probePython?: typeof probePython
  runLocal?: typeof runLocalScript
  fetchRemote?: typeof fetchRemote
}

export type Acquired = {
  sourced: Sourced
  source: "local" | "remote"
  // The cache identity of the source that produced the document (storage.ts):
  // the tick persists the document under it.
  identity: string
  fromCache: boolean
  warnings: string[]
}

// runLocalScript prefixes every failure with this; the fallback warning
// re-wraps the cause instead of repeating the prefix.
const LOCAL_PREFIX = "local source failed: "

function asReason(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export async function acquire(cfg: Config, deps: AcquireDeps): Promise<Acquired> {
  const probe = deps.probePython ?? probePython
  const runLocal = deps.runLocal ?? runLocalScript
  const doFetch = deps.fetchRemote ?? fetchRemote

  const scriptPath = cfg.scriptPath ?? VENDORED_SCRIPT

  // Remote mode never probes python or runs the script (§9). fetchRemote's
  // fromCache flag is lifted to the result; sourced itself stays a plain
  // Sourced (§5).
  if (cfg.source === "remote") {
    const { doc, acquiredAt, fromCache } = await doFetch(cfg.catalogURL, deps.storage)
    return {
      sourced: { doc, acquiredAt },
      source: "remote",
      identity: remoteIdentity(cfg.catalogURL),
      fromCache,
      warnings: [],
    }
  }

  if (cfg.source === "local") {
    const sourced = await runLocal(scriptPath)
    return { sourced, source: "local", identity: localIdentity(cfg.scriptPath), fromCache: false, warnings: [] }
  }

  // Auto: probe first; a usable python gets one local attempt. Either
  // failure — the probe or the run — degrades to remote with the cause named.
  const warnings: string[] = []
  const probed = await probe()
  if (probed.ok) {
    try {
      const sourced = await runLocal(scriptPath)
      return {
        sourced,
        source: "local",
        identity: localIdentity(cfg.scriptPath),
        fromCache: false,
        warnings: [],
      }
    } catch (error) {
      const cause = asReason(error).replace(LOCAL_PREFIX, "")
      warnings.push(`local source failed (${cause}); using remote catalog`)
    }
  } else {
    warnings.push(`${probed.reason}; using remote catalog`)
  }

  const { doc, acquiredAt, fromCache } = await doFetch(cfg.catalogURL, deps.storage)
  return {
    sourced: { doc, acquiredAt },
    source: "remote",
    identity: remoteIdentity(cfg.catalogURL),
    fromCache,
    warnings,
  }
}

// The cache identities a configuration can have produced a document under:
// setup seeds from the newest of them (under `auto` either source may have won).
export function cacheIdentities(cfg: Config): string[] {
  const local = localIdentity(cfg.scriptPath)
  const remote = remoteIdentity(cfg.catalogURL)
  if (cfg.source === "local") return [local]
  if (cfg.source === "remote") return [remote]
  return [local, remote]
}

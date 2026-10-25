// tests/unit/acquire.test.ts
// Source selection and acquisition (design §3, §9): explicit local runs the
// script and rejects on failure; explicit remote fetches without ever
// touching python; auto probes python first, runs local when it passes, and
// degrades to the remote catalog with an actionable warning when python is
// unusable or the local run fails — only a failed remote fallback rejects.
// Every seam is injected; no test spawns python or hits the network.
import { existsSync } from "node:fs"
import { describe, expect, test } from "vitest"
import type { Config } from "../../src/config"
import { validateCatalog } from "../../src/core/catalog"
import type { Sourced } from "../../src/core/types"
import type { Storage } from "../../src/opencode/storage"
import { acquire, cacheIdentities } from "../../src/sources"

const CATALOG_URL = "https://models.example.com/catalog.json"
const SCRIPT = "/opt/tools/model_compare.py"

function cfg(overrides: Partial<Config> = {}): Config {
  return {
    source: "auto",
    defaultPriority: "balanced",
    fallback: null,
    weights: {},
    pinDays: 14,
    minLead: 0.03,
    catalogURL: CATALOG_URL,
    scriptPath: null,
    ...overrides,
  }
}

// One schema-valid document, validated once and shared by the stubs.
const raw = {
  schema_version: 4,
  generated_at: "2026-10-09T00:00:00+00:00",
  models: [
    {
      id: "acme/mini",
      name: "Acme Mini",
      pricing: { blended_per_1m: 0.5 },
      context: 128000,
      scores: {
        quality: 0.5,
        price: 0.5,
        context: 0.5,
        age: 0.5,
        overall: { balanced: 0.5, price: 0.5, quality: 0.5 },
      },
    },
  ],
}
const validated = validateCatalog(raw)
if (!validated.ok) throw new Error(`test document is invalid: ${validated.reason}`)
const DOC = validated.catalog

function sourced(acquiredAt: number): Sourced {
  return { doc: DOC, acquiredAt }
}

// A Map-backed Storage with the structural shape of ctx.storage.
function memoryStorage(): Storage {
  const map = new Map<string, unknown>()
  return {
    get: async (key) => map.get(key),
    set: async (key, value) => {
      map.set(key, value)
    },
  }
}

// A probe stub standing in for probePython, counting its calls.
function probeOf(result: { ok: true } | { ok: false; reason: string }) {
  let calls = 0
  const probe = async () => {
    calls++
    return result
  }
  return { probe, calls: () => calls }
}

// A runLocal stub resolving with the given Sourced and recording its paths.
function runLocalReturns(s: Sourced) {
  const paths: string[] = []
  const runLocal = async (scriptPath: string) => {
    paths.push(scriptPath)
    return s
  }
  return { runLocal, paths, calls: () => paths.length }
}

// A runLocal stub that always rejects and records its paths.
function runLocalFails(error: Error) {
  const paths: string[] = []
  const runLocal = async (scriptPath: string) => {
    paths.push(scriptPath)
    throw error
  }
  return { runLocal, paths, calls: () => paths.length }
}

// A fetchRemote stub resolving with the given result and recording its URLs.
function fetchReturns(result: Sourced & { fromCache: boolean }) {
  const urls: string[] = []
  const fetchRemote = async (url: string) => {
    urls.push(url)
    return result
  }
  return { fetchRemote, urls, calls: () => urls.length }
}

// A fetchRemote stub that always rejects and records its URLs.
function fetchFails(error: Error) {
  const urls: string[] = []
  const fetchRemote = async (url: string) => {
    urls.push(url)
    throw error
  }
  return { fetchRemote, urls, calls: () => urls.length }
}

// Resolves with the rejection reason (the Error message) when the promise
// rejects; fails the test when it resolves instead.
async function rejectionOf(run: Promise<unknown>): Promise<string> {
  try {
    await run
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
  throw new Error("expected the promise to reject")
}

describe("acquire — source: local", () => {
  test("success returns the Sourced from the script without probing python", async () => {
    const probe = probeOf({ ok: false, reason: "python3 is 3.9, need >= 3.10" })
    const runner = runLocalReturns(sourced(111))

    const result = await acquire(cfg({ source: "local", scriptPath: SCRIPT }), {
      storage: memoryStorage(),
      probePython: probe.probe,
      runLocal: runner.runLocal,
    })

    expect(result).toEqual({
      sourced: sourced(111),
      source: "local",
      identity: `local:${SCRIPT}`,
      fromCache: false,
      warnings: [],
    })
    expect(runner.paths).toEqual([SCRIPT])
    expect(probe.calls()).toBe(0)
  })

  test("failure rejects with the reason and never reaches remote", async () => {
    const runner = runLocalFails(new Error("local source failed: exit code 1; stderr: boom"))
    const fetcher = fetchReturns({ ...sourced(222), fromCache: false })

    const reason = await rejectionOf(
      acquire(cfg({ source: "local", scriptPath: SCRIPT }), {
        storage: memoryStorage(),
        runLocal: runner.runLocal,
        fetchRemote: fetcher.fetchRemote,
      }),
    )

    expect(reason).toContain("local source failed")
    expect(reason).toContain("exit code 1")
    expect(fetcher.calls()).toBe(0)
  })

  test("a null scriptPath resolves the vendored copy at the package root", async () => {
    const runner = runLocalReturns(sourced(333))

    await acquire(cfg({ source: "local" }), {
      storage: memoryStorage(),
      runLocal: runner.runLocal,
    })

    expect(runner.paths).toHaveLength(1)
    const [path] = runner.paths
    expect(path.replace(/\\/g, "/").endsWith("vendor/model_compare.py")).toBe(true)
    expect(existsSync(path)).toBe(true)
  })
})

describe("acquire — source: auto", () => {
  test("a passing probe runs the local script and never fetches", async () => {
    const probe = probeOf({ ok: true })
    const runner = runLocalReturns(sourced(444))
    const fetcher = fetchReturns({ ...sourced(555), fromCache: false })

    const result = await acquire(cfg({ source: "auto", scriptPath: SCRIPT }), {
      storage: memoryStorage(),
      probePython: probe.probe,
      runLocal: runner.runLocal,
      fetchRemote: fetcher.fetchRemote,
    })

    expect(result).toEqual({
      sourced: sourced(444),
      source: "local",
      identity: `local:${SCRIPT}`,
      fromCache: false,
      warnings: [],
    })
    expect(probe.calls()).toBe(1)
    expect(runner.paths).toEqual([SCRIPT])
    expect(fetcher.calls()).toBe(0)
  })

  test("a failing probe degrades to the remote catalog with a warning naming python", async () => {
    const probe = probeOf({ ok: false, reason: "python3 is 3.9, need >= 3.10" })
    const runner = runLocalReturns(sourced(666))
    const fetcher = fetchReturns({ ...sourced(777), fromCache: false })

    const result = await acquire(cfg({ source: "auto" }), {
      storage: memoryStorage(),
      probePython: probe.probe,
      runLocal: runner.runLocal,
      fetchRemote: fetcher.fetchRemote,
    })

    expect(result).toEqual({
      sourced: sourced(777),
      source: "remote",
      identity: `remote:${CATALOG_URL}`,
      fromCache: false,
      warnings: ["python3 is 3.9, need >= 3.10; using remote catalog"],
    })
    expect(probe.calls()).toBe(1)
    expect(runner.calls()).toBe(0)
    expect(fetcher.urls).toEqual([CATALOG_URL])
  })

  test("a local failure under auto degrades to remote with the local reason", async () => {
    const probe = probeOf({ ok: true })
    const runner = runLocalFails(new Error("local source failed: exit code 1; stderr: boom"))
    const fetcher = fetchReturns({ ...sourced(888), fromCache: false })

    const result = await acquire(cfg({ source: "auto", scriptPath: SCRIPT }), {
      storage: memoryStorage(),
      probePython: probe.probe,
      runLocal: runner.runLocal,
      fetchRemote: fetcher.fetchRemote,
    })

    expect(result.sourced).toEqual(sourced(888))
    expect(result.source).toBe("remote")
    expect(result.identity).toBe(`remote:${CATALOG_URL}`)
    expect(result.warnings).toEqual(["local source failed (exit code 1; stderr: boom); using remote catalog"])
    expect(fetcher.calls()).toBe(1)
  })

  test("a failing probe with a failing remote rejects with the remote reason", async () => {
    const probe = probeOf({ ok: false, reason: "python3 not found (spawn ENOENT)" })
    const fetcher = fetchFails(new Error("remote source failed: network down"))

    const reason = await rejectionOf(
      acquire(cfg({ source: "auto" }), {
        storage: memoryStorage(),
        probePython: probe.probe,
        fetchRemote: fetcher.fetchRemote,
      }),
    )

    expect(reason).toContain("remote source failed")
    expect(reason).toContain("network down")
  })
})

describe("acquire — source: remote", () => {
  test("fetches the configured URL without probing python or running the script", async () => {
    const probe = probeOf({ ok: false, reason: "python3 not found (spawn ENOENT)" })
    const runner = runLocalReturns(sourced(999)) // a call here would fail the test
    const fetcher = fetchReturns({ ...sourced(1010), fromCache: true })

    const result = await acquire(cfg({ source: "remote" }), {
      storage: memoryStorage(),
      probePython: probe.probe,
      runLocal: runner.runLocal,
      fetchRemote: fetcher.fetchRemote,
    })

    expect(result).toEqual({
      sourced: sourced(1010),
      source: "remote",
      identity: `remote:${CATALOG_URL}`,
      fromCache: true,
      warnings: [],
    })
    expect(fetcher.urls).toEqual([CATALOG_URL])
    expect(probe.calls()).toBe(0)
    expect(runner.calls()).toBe(0)
  })
})

describe("cacheIdentities", () => {
  test("remote → the URL's identity only; local → the script's; auto → both", () => {
    expect(cacheIdentities(cfg({ source: "remote" }))).toEqual([`remote:${CATALOG_URL}`])
    expect(cacheIdentities(cfg({ source: "local", scriptPath: SCRIPT }))).toEqual([`local:${SCRIPT}`])
    expect(cacheIdentities(cfg({ source: "auto", scriptPath: SCRIPT }))).toEqual([
      `local:${SCRIPT}`,
      `remote:${CATALOG_URL}`,
    ])
  })

  test("the vendored default has a path-independent identity", () => {
    expect(cacheIdentities(cfg({ source: "local", scriptPath: null }))).toEqual(["local:vendored"])
  })
})

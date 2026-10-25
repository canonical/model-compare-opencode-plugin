// tests/unit/local-source.test.ts
// The local source runner (design §9, §11): python3 runs the vendored script
// under execFile — no shell, a minimal environment, a timeout — and whatever
// it prints must parse and validate into a Sourced catalog. Real subprocesses
// through stub fixtures; every failure path rejects with a
// "local source failed: <reason>" message instead of throwing.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, test } from "vitest"
import { validateCatalog } from "../../src/core/catalog"
import { probePython, runLocalScript, scriptEnv } from "../../src/sources/local"

const STUB_CATALOG = "tests/fixtures/stub-model-compare.py"
const CATALOG_FIXTURE = "fixtures/catalog-no-quality.json"

// The environment keys the local source reads; snapshotted and restored
// around every test so nothing leaks into other tests or workers.
const ENV_KEYS = [
  "HOME",
  "PATH",
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

let savedEnv: Record<string, string | undefined> = {}

beforeEach(() => {
  savedEnv = {}
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key]
})

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = savedEnv[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

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

// A PATH pointing at an empty directory: nothing on it, python3 included.
function emptyPathDir(): string {
  return mkdtempSync(join(tmpdir(), "local-source-empty-path-"))
}

// A PATH whose only entry is a fake python3 printing one line, like the real
// interpreter does for the version probe (major.minor only).
function fakePythonPathDir(version: string): string {
  const dir = mkdtempSync(join(tmpdir(), "local-source-fake-python3-"))
  writeFileSync(join(dir, "python3"), `#!/bin/sh\necho ${version}\n`, { mode: 0o755 })
  return dir
}

describe("scriptEnv", () => {
  test("always carries HOME and PATH from process.env", () => {
    const env = scriptEnv()
    expect(env.HOME).toBe(process.env.HOME)
    expect(env.PATH).toBe(process.env.PATH)
  })

  test("omits HOME and PATH when process.env lacks them", () => {
    for (const key of ENV_KEYS) delete process.env[key]
    expect(scriptEnv()).toEqual({})
  })

  test("passes through only the listed variables, and only when non-empty", () => {
    for (const key of ENV_KEYS) delete process.env[key]
    process.env.HOME = "/home/tester"
    process.env.PATH = "/usr/bin:/bin"
    process.env.AA_API_KEY = "secret"
    process.env.https_proxy = "http://proxy:3128"
    process.env.SSL_CERT_FILE = "/etc/ca.pem"
    process.env.NO_PROXY = "" // present but empty -> dropped

    expect(scriptEnv()).toEqual({
      HOME: "/home/tester",
      PATH: "/usr/bin:/bin",
      AA_API_KEY: "secret",
      https_proxy: "http://proxy:3128",
      SSL_CERT_FILE: "/etc/ca.pem",
    })
  })

  test("does not mutate process.env", () => {
    process.env.AA_API_KEY = "secret"
    const env = scriptEnv()
    env.AA_API_KEY = "tampered"
    expect(process.env.AA_API_KEY).toBe("secret")
  })
})

describe("probePython", () => {
  test("resolves on the real interpreter", async () => {
    await expect(probePython()).resolves.toEqual({ ok: true })
  })

  test("reports an interpreter older than 3.10 with its version", async () => {
    const dir = fakePythonPathDir("2.7")
    try {
      process.env.PATH = dir
      const probe = await probePython()
      if (probe.ok) throw new Error("expected the probe to reject python 2.7")
      expect(probe.reason).toContain("2.7")
      expect(probe.reason).toMatch(/3\.10/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("honors the timeout option: a hung interpreter is reported, not awaited forever (F-01)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "local-source-hung-python3-"))
    writeFileSync(join(dir, "python3"), "#!/bin/sh\nsleep 30\n", { mode: 0o755 })
    try {
      process.env.PATH = `${dir}:${process.env.PATH}`
      const started = Date.now()
      const probe = await probePython(150)
      if (probe.ok) throw new Error("expected the probe to time out")
      expect(probe.reason).toMatch(/timed out after 150ms/)
      expect(Date.now() - started).toBeLessThan(5_000)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("reports a missing interpreter as spawn ENOENT", async () => {
    const dir = emptyPathDir()
    try {
      process.env.PATH = dir
      const probe = await probePython()
      if (probe.ok) throw new Error("expected the probe to fail without python3")
      expect(probe.reason).toMatch(/ENOENT/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("runLocalScript", () => {
  test("the stub resolves with the fixture's models and acquiredAt ≈ now", async () => {
    const fixture = JSON.parse(readFileSync(CATALOG_FIXTURE, "utf8"))
    const expected = validateCatalog(fixture)
    if (!expected.ok) throw new Error(`fixture no longer validates: ${expected.reason}`)

    const before = Date.now()
    const sourced = await runLocalScript(STUB_CATALOG)
    const after = Date.now()

    expect(sourced.doc).toEqual(expected.catalog)
    expect(sourced.acquiredAt).toBeGreaterThanOrEqual(before)
    expect(sourced.acquiredAt).toBeLessThanOrEqual(after)
  })

  test("a stub whose pool lost models at the endpoint stage reports the shrink in warnings", async () => {
    const doc = {
      schema_version: 4,
      generated_at: "2026-10-09T00:00:00+00:00",
      // context rides along: the by-design funnel drops must not trigger or
      // inflate the endpoint-stage warning.
      pool: { dropped: { endpoint_fetch_failed: 2, context: 275 } },
      models: [],
    }
    const stub = join(mkdtempSync(join(tmpdir(), "local-source-drops-")), "stub.py")
    writeFileSync(stub, `import json, sys\njson.dump(${JSON.stringify(doc)}, sys.stdout)\n`)
    const sourced = await runLocalScript(stub)
    expect(sourced.warnings).toEqual([
      "catalog pool shrunk: 2 model(s) dropped at the endpoint stage (endpoint_fetch_failed: 2)",
    ])
  })

  test("the healthy funnel shape (endpoint_fetch_failed: 0, normal drops nonzero) emits no warning", async () => {
    // Deterministic inline stub — STUB_CATALOG fetches live upstream data, so
    // its dropped map is not stable across cache states.
    const doc = {
      schema_version: 4,
      generated_at: "2026-10-09T00:00:00+00:00",
      pool: { dropped: { endpoint_fetch_failed: 0, context: 275, "not ZDR": 64 } },
      models: [],
    }
    const stub = join(mkdtempSync(join(tmpdir(), "local-source-clean-")), "stub.py")
    writeFileSync(stub, `import json, sys\njson.dump(${JSON.stringify(doc)}, sys.stdout)\n`)
    const sourced = await runLocalScript(stub)
    expect(sourced.warnings).toEqual([])
  })

  test("a stub exiting 1 rejects with the exit code and the stderr tail", async () => {
    const reason = await rejectionOf(runLocalScript("tests/fixtures/stub-exit-1.py"))
    expect(reason).toContain("local source failed")
    expect(reason).toContain("exit code 1")
    expect(reason).toContain("simulated fetch failure")
  })

  test("an invalid-JSON stub rejects with a parse failure", async () => {
    const reason = await rejectionOf(runLocalScript("tests/fixtures/stub-invalid-json.py"))
    expect(reason).toContain("local source failed")
    expect(reason).toMatch(/invalid JSON/)
  })

  test("a rejected document rejects with the validator's reason", async () => {
    // A runtime-written stub printing schema-valid JSON that fails catalog
    // validation; keeps the fixture set at four while covering the branch.
    const dir = mkdtempSync(join(tmpdir(), "local-source-bad-doc-"))
    try {
      const stub = join(dir, "stub-bad-schema.py")
      writeFileSync(stub, `print('{"schema_version": 3}')\n`)
      const reason = await rejectionOf(runLocalScript(stub))
      expect(reason).toContain("local source failed")
      expect(reason).toContain("schema_version must be 4")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("a stub past its timeout rejects mentioning the timeout", async () => {
    const reason = await rejectionOf(runLocalScript("tests/fixtures/stub-slow.py", 100))
    expect(reason).toContain("local source failed")
    expect(reason).toMatch(/timed out/i)
  })

  test("a stub flooding stdout past the 64 MiB cap rejects with the distinct cap reason", async () => {
    // The execFile maxBuffer kill also sets killed/signal — the taxonomy must
    // report the output cap, not a timeout.
    const dir = mkdtempSync(join(tmpdir(), "local-source-overflow-"))
    try {
      const stub = join(dir, "stub-overflow.py")
      writeFileSync(stub, "import sys\nsys.stdout.write('x' * (70 * 1024 * 1024))\n")
      const reason = await rejectionOf(runLocalScript(stub))
      expect(reason).toContain("local source failed")
      expect(reason).toMatch(/64 MiB cap/)
      expect(reason).not.toMatch(/timed out/i)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("a missing python3 rejects with the spawn failure named", async () => {
    const dir = emptyPathDir()
    try {
      process.env.PATH = dir
      const reason = await rejectionOf(runLocalScript(STUB_CATALOG))
      expect(reason).toContain("local source failed")
      expect(reason).toContain("python3 not found")
      expect(reason).toMatch(/ENOENT/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
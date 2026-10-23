// tests/unit/wiring.test.ts
// Plugin entrypoint wiring (design §8–§10): setup seeds state from storage
// BEFORE registering the transform (§8's startup chain: pin → fallback →
// disabled), kicks off the first refresh in the background (exactly one
// immediate, un-awaited acquire), runs the primary-kind guard hook, the
// /use-best and /model-compare commands, and the non-overlapping refresh tick
// with provider→model→agent reloads. All ctx behavior is mocked; acquire, the
// timer and the clock are injected.
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { validateCatalog } from "../../src/core/catalog"
import { effectiveWeights } from "../../src/core/rank"
import { pinKey, type Pin } from "../../src/core/pins"
import type { Catalog, Priority, Sourced } from "../../src/core/types"
import {
  docCacheKey,
  localIdentity,
  remoteIdentity,
  writeCachedDoc,
} from "../../src/opencode/storage"
import type { Acquired } from "../../src/sources"
import { wire, type PluginCtx, type WireDeps } from "../../src/index"

const NOW = Date.now()
const PRIORITIES: Priority[] = ["balanced", "price", "quality"]

// One schema-valid document with a single model, so every priority's ranking
// has the same predictable winner. Validated once and shared by the fixtures.
const raw = {
  schema_version: 3,
  generated_at: "2026-10-09T00:00:00+00:00",
  models: [
    {
      id: "acme/alpha",
      name: "Acme Alpha",
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
const DOC: Catalog = validated.catalog
const raw_ = raw // the module-level document, for tests whose harness shadows `raw`

// The same single-model document with a steering block on its only model —
// the catalog the steering-injection tests seed (validateCatalog unwraps the
// raw { model, provider } block into ModelEntry.steering).
const steeredRaw = {
  ...raw,
  models: [
    {
      ...raw.models[0],
      steering: {
        model: raw.models[0].id,
        provider: {
          order: ["novita/fp8", "deepinfra/fp8"],
          ignore: ["coreweave/fp4"],
          quantizations: ["fp8"],
          allow_fallbacks: true,
        },
      },
    },
  ],
}
const steeredChecked = validateCatalog(steeredRaw)
if (!steeredChecked.ok) throw new Error(`steered test document is invalid: ${steeredChecked.reason}`)
const STEERED_DOC: Catalog = steeredChecked.catalog
const STEERING = STEERED_DOC.models[0].steering
if (STEERING === undefined) throw new Error("steered fixture lost its steering block")

// The pin key as the plugin computes it for a document without overrides.
function pinKeyFor(doc: Catalog, p: Priority): string {
  return pinKey(p, effectiveWeights(doc, p, undefined).weights)
}

// The identity the stubbed acquire reports (the default config's catalogURL).
const REMOTE_IDENTITY = remoteIdentity("https://model-compare.dev/catalog.json")

function sourced(acquiredAt: number): Sourced {
  return { doc: DOC, acquiredAt }
}

// A canned acquire result from the stub.
function acquired(acquiredAt = NOW): Acquired {
  return {
    sourced: sourced(acquiredAt),
    source: "remote",
    identity: REMOTE_IDENTITY,
    fromCache: false,
    warnings: [],
  }
}

// ---- mocks -----------------------------------------------------------------

type ModelRef = { providerID: string; id: string }

type EditorModel = {
  providerID: string
  modelID: string
  name: string
  enabled: boolean
  capabilities: unknown
  limit: unknown
  cost: unknown
  variants: unknown
  time: unknown
  status: unknown
}

type Editor = {
  get(providerID: string, modelID: string): EditorModel | undefined
  update(providerID: string, modelID: string, update: (model: EditorModel) => void): void
}

type HookEvent = {
  sessionID: string
  agent: string
  model: ModelRef
  kind: string
  request: unknown
}

type CommandDef = {
  name: string
  description?: string
  execute: (input: { sessionID: string; prompt: { text: string } }) => Promise<void>
}

// The editor slice the applier touches; update creates the model when missing
// (the spike verified update-creates semantics in OpenCode). Models are keyed
// by their registry key (providerID/modelID at update time) — an enabled
// update rewrites the record's modelID, but the registry slot stays put.
function makeEditor(initial: EditorModel[] = []) {
  const byKey = new Map<string, EditorModel>()
  const keyOf = (providerID: string, modelID: string) => `${providerID}/${modelID}`
  for (const model of initial) byKey.set(keyOf(model.providerID, model.modelID), model)
  const editor: Editor = {
    get: (providerID, modelID) => byKey.get(keyOf(providerID, modelID)),
    update: (providerID, modelID, update) => {
      const key = keyOf(providerID, modelID)
      let model = byKey.get(key)
      if (model === undefined) {
        model = {
          providerID,
          modelID,
          name: "",
          enabled: false,
          capabilities: {},
          limit: {},
          cost: [],
          variants: [],
          time: { released: 0 },
          status: "active",
        }
        byKey.set(key, model)
      }
      update(model)
    },
  }
  return { editor, byKey }
}

// A concrete OpenRouter model as the editor's `get` would return it.
function concrete(id: string): EditorModel {
  return {
    providerID: "openrouter",
    modelID: id,
    name: id,
    enabled: true,
    capabilities: { tools: true, input: ["text"], output: ["text"] },
    limit: { context: 128000, output: 8192 },
    cost: [{ input: 1, output: 2, cache: { read: 0.1, write: 0.2 } }],
    variants: [],
    time: { released: 1700000000000 },
    status: "active",
  }
}

// Alias records as a previous transform replay would have left them, with a
// stale target — lets tests assert modelID is left untouched when disabled.
function staleAlias(p: Priority): EditorModel {
  return { ...concrete(`stale/${p}`), providerID: "openrouter", modelID: `model-compare/${p}` }
}

function aliasOf(byKey: Map<string, EditorModel>, p: Priority): EditorModel {
  const found = byKey.get(`openrouter/model-compare/${p}`)
  if (found === undefined) throw new Error(`alias for ${p} was never updated`)
  return found
}

// A controllable timer: records the scheduled ticks; the cancel fn removes one.
function fakeTimers() {
  const fns: Array<() => void> = []
  const setInterval = (fn: () => void, _ms: number) => {
    fns.push(fn)
    return () => {
      const index = fns.indexOf(fn)
      if (index >= 0) fns.splice(index, 1)
    }
  }
  return { setInterval, fns }
}

// A plain mock of the plugin ctx: vi.fn()s capture every registration and
// session call; storage is a Map; agent "mc-quality" is alias-configured.
function makeCtx() {
  const storageMap = new Map<string, unknown>()
  const transformCallbacks: Array<(editor: Editor) => void> = []
  const hookCallbacks: Array<(event: HookEvent) => Promise<void>> = []
  const commands: CommandDef[] = []
  const rpcHandlers: Record<string, (input: unknown) => Promise<unknown> | unknown> = {}
  const rpcEmit = vi.fn(async (_name: string, _data: unknown) => {})
  const reloads: string[] = []
  const agentModels: Record<string, ModelRef | undefined> = {
    "mc-quality": { providerID: "openrouter", id: "model-compare/quality" },
  }

  const ctx = {
    options: {},
    app: { version: "2.0.16" },
    storage: {
      get: vi.fn(async (key: string) => storageMap.get(key)),
      set: vi.fn(async (key: string, value: unknown) => {
        storageMap.set(key, value)
      }),
    },
    model: {
      transform: vi.fn(async (cb: (editor: Editor) => void) => {
        transformCallbacks.push(cb)
        return { dispose: vi.fn(async () => {}) }
      }),
      // A plain (non-promise) return on purpose: wire must tolerate both.
      // The union keeps async implementations assignable (the abandonment
      // tests hang the runnable-set fetch on a promise).
      list: vi.fn(():
        | { location: unknown; data: Array<{ id: string; providerID: string; enabled: boolean }> }
        | Promise<{ location: unknown; data: Array<{ id: string; providerID: string; enabled: boolean }> }> => ({
        location: {},
        data: [{ id: "acme/alpha", providerID: "openrouter", enabled: true }],
      })),
      reload: vi.fn(async () => {
        reloads.push("model")
      }),
    },
    provider: {
      reload: vi.fn(async () => {
        reloads.push("provider")
      }),
    },
    agent: {
      reload: vi.fn(async () => {
        reloads.push("agent")
      }),
      get: vi.fn(async ({ agentID }: { agentID: string }) => ({
        location: {},
        data: { model: agentModels[agentID] },
      })),
    },
    session: {
      hook: vi.fn(async (_name: "http.request", cb: (event: HookEvent) => Promise<void>) => {
        hookCallbacks.push(cb)
        return { dispose: vi.fn(async () => {}) }
      }),
      switchModel: vi.fn(async (_input: { sessionID: string; model: ModelRef }) => {}),
      synthetic: vi.fn(async (_input: { sessionID: string; text: string; resume?: boolean | null }) => ({})),
    },
    command: {
      transform: vi.fn(async (cb: (editor: { add(definition: CommandDef): void }) => void) => {
        cb({ add: (definition) => commands.push(definition) })
        return { dispose: vi.fn(async () => {}) }
      }),
    },
    rpc: {
      register: vi.fn(async (
        _definition: { id: string },
        handlers: Record<string, (input: unknown) => Promise<unknown> | unknown>,
      ) => {
        Object.assign(rpcHandlers, handlers)
        return { dispose: vi.fn(async () => {}), events: { emit: rpcEmit } }
      }),
    },
  }
  return {
    ctx: ctx as unknown as PluginCtx,
    raw: ctx,
    storageMap,
    transformCallbacks,
    hookCallbacks,
    commands,
    reloads,
    rpcHandlers,
    rpcEmit,
  }
}

async function seedDocCache(target: PluginCtx["storage"], acquiredAt = NOW) {
  // Under the default config (source auto) setup seeds from the newest of the
  // local and remote identities; either works.
  await writeCachedDoc(target, localIdentity(null), { doc: DOC, acquiredAt })
}

async function seedPin(
  target: PluginCtx["storage"],
  doc: Catalog,
  p: Priority,
  pin: Pin,
) {
  await target.set(pinKeyFor(doc, p), pin)
}

// Default deps: acquire, the timer and the clock, all stubbed. A zero-arg
// acquire stub is assignable to the real two-arg signature.
function deps(
  acquire: () => Promise<Acquired>,
  timers: ReturnType<typeof fakeTimers>,
): WireDeps {
  return { acquire, setInterval: timers.setInterval, now: () => NOW }
}

// Lets every pending microtask chain settle — notably the background first
// refresh `wire` kicks off, which setup deliberately does not await.
async function drain(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

// Polls a condition so a test can park on a gated mock before manipulating
// the tick deadline; bounded so a regression fails the test, not the runner.
async function waitUntil(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
  const started = Date.now()
  while (!condition()) {
    if (Date.now() - started > timeoutMs) throw new Error("waitUntil timed out")
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

let warnSpy: ReturnType<typeof vi.spyOn>
let errorSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
})

afterEach(() => {
  warnSpy.mockRestore()
  errorSpy.mockRestore()
})

// ---- setup -----------------------------------------------------------------

describe("setup", () => {
  test("starts ONE background refresh: exactly one immediate acquire, not awaited by setup", async () => {
    const { ctx } = makeCtx()
    const timers = fakeTimers()
    let release!: (value: Acquired) => void
    const gate = new Promise<Acquired>((resolveGate) => {
      release = resolveGate
    })
    const acquire = vi.fn(async () => gate)

    const cleanup = await wire(ctx, deps(acquire, timers))

    // §8: setup kicks the first refresh off in the background — exactly one
    // immediate acquire — while setup's promise is already resolved (the gate
    // is still closed, so setup cannot have been waiting on the tick).
    expect(acquire).toHaveBeenCalledTimes(1)
    expect(timers.fns).toHaveLength(1)

    // The 30-minute timer still fires its own tick afterwards.
    release(acquired())
    await drain()
    await timers.fns[0]()
    expect(acquire).toHaveBeenCalledTimes(2)

    // Cleanup clears the interval — no timer leak.
    cleanup()
    expect(timers.fns).toHaveLength(0)
  })

  test("seeds state BEFORE registering the transform: the callback's first invocation sees the stored pin", async () => {
    const { ctx, raw } = makeCtx()
    const { editor, byKey } = makeEditor([concrete("acme/alpha")])
    // Registration-time application (the design-spike timing): this mock
    // invokes the captured callback ONCE, immediately, as OpenCode does when
    // the transform is registered. Seeding must therefore already have
    // happened — under the old register-first order the callback computed
    // every alias from empty state and this assertion failed.
    raw.model.transform.mockImplementation(async (cb) => {
      cb(editor)
      return { dispose: vi.fn(async () => {}) }
    })
    await seedDocCache(ctx.storage)
    await seedPin(ctx.storage, DOC, "quality", { v: 1, id: "acme/alpha", since: NOW })

    await wire(ctx, deps(vi.fn(), fakeTimers()))
    await drain()

    const quality = aliasOf(byKey, "quality")
    expect(quality.enabled).toBe(true)
    expect(quality.modelID).toBe("acme/alpha")
    expect(quality.name).toBe("Model Compare: quality → acme/alpha")
    // Priorities without a stored pin stay disabled.
    expect(aliasOf(byKey, "balanced").enabled).toBe(false)
    expect(aliasOf(byKey, "price").enabled).toBe(false)
  })

  test("cold start with a runnable fallback → aliases start enabled from the fallback", async () => {
    const { ctx, raw } = makeCtx()
    // A bare id that itself contains a slash proves only the provider prefix
    // is stripped ("openrouter/zeta/fallback" → "zeta/fallback").
    raw.options = { fallback: "openrouter/zeta/fallback" }
    raw.model.list.mockReturnValue({
      location: {},
      data: [{ id: "zeta/fallback", providerID: "openrouter", enabled: true }],
    })
    const { editor, byKey } = makeEditor([concrete("zeta/fallback")])
    raw.model.transform.mockImplementation(async (cb) => {
      cb(editor)
      return { dispose: vi.fn(async () => {}) }
    })

    await wire(ctx, deps(vi.fn(), fakeTimers()))
    await drain()

    for (const p of PRIORITIES) {
      const alias = aliasOf(byKey, p)
      expect(alias.enabled).toBe(true)
      expect(alias.modelID).toBe("zeta/fallback")
      expect(alias.name).toBe(`Model Compare: ${p} → zeta/fallback (fallback)`)
    }
    // The fallback is never stored as a pin (§7.8) and no doc was cached.
    // Only the two document-cache records (local and remote identity) were read.
    expect(raw.storage.get).toHaveBeenCalledTimes(2)
  })

  test("cold start with a non-runnable fallback → aliases disabled with one warning", async () => {
    const { ctx, transformCallbacks, raw } = makeCtx()
    raw.options = { fallback: "openrouter/gone/model" }

    await wire(ctx, deps(vi.fn(), fakeTimers()))
    await drain()

    const { editor, byKey } = makeEditor([concrete("acme/alpha")])
    transformCallbacks[0](editor)
    for (const p of PRIORITIES) expect(aliasOf(byKey, p).enabled).toBe(false)
    const warns = warnSpy.mock.calls.map((call: unknown[]) => call.join(" "))
    expect(warns).toContainEqual(
      expect.stringContaining(
        "no cached ranking; startup fallback gone/model is not runnable; aliases disabled until first refresh",
      ),
    )
  })

  test("a stored pin with a cached doc enables that alias from storage", async () => {
    const { ctx, transformCallbacks } = makeCtx()
    await seedDocCache(ctx.storage)
    await seedPin(ctx.storage, DOC, "quality", { v: 1, id: "acme/alpha", since: NOW })

    await wire(ctx, deps(vi.fn(), fakeTimers()))
    expect(transformCallbacks).toHaveLength(1)

    const { editor, byKey } = makeEditor([concrete("acme/alpha")])
    transformCallbacks[0](editor)

    const quality = aliasOf(byKey, "quality")
    expect(quality.enabled).toBe(true)
    expect(quality.modelID).toBe("acme/alpha")
    expect(quality.name).toBe("Model Compare: quality → acme/alpha")
    const source = editor.get("openrouter", "acme/alpha")
    expect(quality.capabilities).toEqual(source?.capabilities)
    expect(quality.capabilities).not.toBe(source?.capabilities) // deep-copied
    expect(quality.limit).toEqual(source?.limit)
    expect(quality.status).toBe(source?.status)

    // No pins for the other priorities → those aliases stay disabled.
    expect(aliasOf(byKey, "balanced").enabled).toBe(false)
    expect(aliasOf(byKey, "price").enabled).toBe(false)
    expect(aliasOf(byKey, "price").name).toBe("Model Compare: price (unavailable)")
  })

  test("warm start: a non-runnable stored pin falls back to the runnable fallback (§8: pin → fallback → disabled)", async () => {
    const { ctx, raw } = makeCtx()
    raw.options = { fallback: "openrouter/acme/alpha" }
    const { editor, byKey } = makeEditor([concrete("acme/alpha")])
    raw.model.transform.mockImplementation(async (cb) => {
      cb(editor)
      return { dispose: vi.fn(async () => {}) }
    })
    await seedDocCache(ctx.storage)
    // The pin names a model OpenRouter no longer lists as enabled.
    await seedPin(ctx.storage, DOC, "quality", { v: 1, id: "gone/model", since: NOW })

    await wire(ctx, deps(vi.fn(), fakeTimers()))

    const quality = aliasOf(byKey, "quality")
    expect(quality.enabled).toBe(true)
    expect(quality.modelID).toBe("acme/alpha")
    expect(quality.name).toBe("Model Compare: quality → acme/alpha (fallback)")
  })

  test("warm start: no pin record at all also falls back to the runnable fallback", async () => {
    const { ctx, raw } = makeCtx()
    raw.options = { fallback: "openrouter/acme/alpha" }
    const { editor, byKey } = makeEditor([concrete("acme/alpha")])
    raw.model.transform.mockImplementation(async (cb) => {
      cb(editor)
      return { dispose: vi.fn(async () => {}) }
    })
    await seedDocCache(ctx.storage)

    await wire(ctx, deps(vi.fn(), fakeTimers()))

    for (const p of PRIORITIES) expect(aliasOf(byKey, p).enabled).toBe(true)
  })

  test("warm start: a non-runnable pin and no fallback → disabled (unchanged behavior)", async () => {
    const { ctx, raw } = makeCtx()
    const { editor, byKey } = makeEditor([concrete("acme/alpha")])
    raw.model.transform.mockImplementation(async (cb) => {
      cb(editor)
      return { dispose: vi.fn(async () => {}) }
    })
    await seedDocCache(ctx.storage)
    await seedPin(ctx.storage, DOC, "quality", { v: 1, id: "gone/model", since: NOW })

    await wire(ctx, deps(vi.fn(), fakeTimers()))

    expect(aliasOf(byKey, "quality").enabled).toBe(false)
  })

  test("setup seeds from the newest cached document among the source identities (auto)", async () => {
    const { ctx, raw } = makeCtx()
    const { editor, byKey } = makeEditor([concrete("acme/alpha")])
    raw.model.transform.mockImplementation(async (cb) => {
      cb(editor)
      return { dispose: vi.fn(async () => {}) }
    })
    await writeCachedDoc(ctx.storage, localIdentity(null), { doc: DOC, acquiredAt: NOW - 1000 })
    await writeCachedDoc(ctx.storage, REMOTE_IDENTITY, { doc: DOC, acquiredAt: NOW })
    await seedPin(ctx.storage, DOC, "quality", { v: 1, id: "acme/alpha", since: NOW })
    await wire(ctx, deps(vi.fn(), fakeTimers()))
    expect(aliasOf(byKey, "quality").enabled).toBe(true)
  })

  test("a cached document stored for another source is ignored at setup", async () => {
    const { ctx, raw } = makeCtx()
    raw.options = { source: "remote", catalogURL: "https://mine.example.com/c.json" }
    const { editor, byKey } = makeEditor([concrete("acme/alpha")])
    raw.model.transform.mockImplementation(async (cb) => {
      cb(editor)
      return { dispose: vi.fn(async () => {}) }
    })
    await seedDocCache(ctx.storage) // cached for the local identity only
    await seedPin(ctx.storage, DOC, "quality", { v: 1, id: "acme/alpha", since: NOW })
    await wire(ctx, deps(vi.fn(), fakeTimers()))
    // Cold start for this source: no pin lookup, nothing enabled.
    expect(aliasOf(byKey, "quality").enabled).toBe(false)
  })

  test("a corrupt cached document is a cold start, not a crash", async () => {
    const { ctx, raw } = makeCtx()
    const { editor, byKey } = makeEditor([concrete("acme/alpha")])
    raw.model.transform.mockImplementation(async (cb) => {
      cb(editor)
      return { dispose: vi.fn(async () => {}) }
    })
    await ctx.storage.set(docCacheKey(localIdentity(null)), {
      v: 1,
      source: localIdentity(null),
      doc: { generatedAt: "x", models: "not-an-array" },
      acquiredAt: NOW,
    })
    await wire(ctx, deps(vi.fn(), fakeTimers()))
    expect(aliasOf(byKey, "quality").enabled).toBe(false)
    const warns = warnSpy.mock.calls.map((call: unknown[]) => call.join(" "))
    expect(warns).toContainEqual(expect.stringContaining("discarding the cached catalog"))
  })

  test("no storage → all aliases disabled with the no-cached-ranking warning", async () => {
    const { ctx, transformCallbacks } = makeCtx()
    await wire(ctx, deps(vi.fn(), fakeTimers()))

    const { editor, byKey } = makeEditor([
      staleAlias("balanced"),
      staleAlias("price"),
      staleAlias("quality"),
      concrete("acme/alpha"),
    ])
    transformCallbacks[0](editor)

    for (const p of PRIORITIES) {
      const alias = aliasOf(byKey, p)
      expect(alias.enabled).toBe(false)
      expect(alias.modelID).toBe(`model-compare/${p}`) // modelID unchanged when disabled
      expect(alias.name).toBe(`Model Compare: ${p} (unavailable)`)
    }
    const warns = warnSpy.mock.calls.map((call: unknown[]) => call.join(" "))
    expect(warns).toContainEqual(
      expect.stringContaining("no cached ranking; aliases disabled until first refresh"),
    )
  })

  test.each([
    ["a non-numeric id", { v: 1, id: 42, since: NOW }],
    ["a non-numeric since", { v: 1, id: "acme/alpha", since: "junk" }],
    ["an empty id", { v: 1, id: "", since: NOW }],
    // JSON.parse("1e999") is Infinity — valid JSON, invalid pin.
    ["a non-finite since", { v: 1, id: "acme/alpha", since: JSON.parse("1e999") }],
  ])("corrupt pin record (%s) → warning, alias disabled, no throw", async (_name, pin) => {
    const { ctx, transformCallbacks } = makeCtx()
    await seedDocCache(ctx.storage)
    await ctx.storage.set(pinKeyFor(DOC, "quality"), pin)

    // wire must resolve despite the garbage record.
    await wire(ctx, deps(vi.fn(), fakeTimers()))

    const warns = warnSpy.mock.calls.map((call: unknown[]) => call.join(" "))
    expect(warns.some((w: string) => w.includes("corrupt pin record for quality"))).toBe(true)

    const { editor, byKey } = makeEditor([concrete("acme/alpha")])
    transformCallbacks[0](editor)
    expect(aliasOf(byKey, "quality").enabled).toBe(false)
  })
})

// ---- refresh tick ----------------------------------------------------------

describe("refresh tick", () => {
  test("changed pick → reloads in provider→model→agent order, pin and doc written", async () => {
    const { ctx, storageMap, reloads } = makeCtx()
    const timers = fakeTimers()
    const acquire = vi.fn(async () => acquired())

    await wire(ctx, deps(acquire, timers))
    await drain() // the background first refresh produced the first change
    await timers.fns[0]()

    expect(reloads).toEqual(["provider", "model", "agent"])
    for (const p of PRIORITIES) {
      expect(storageMap.get(pinKeyFor(DOC, p))).toEqual({ v: 1, id: "acme/alpha", since: NOW })
    }
    expect(storageMap.get(docCacheKey(REMOTE_IDENTITY))).toEqual({
      v: 1,
      source: REMOTE_IDENTITY,
      doc: DOC,
      acquiredAt: NOW,
    })
  })

  test("unchanged pick → no reloads", async () => {
    const { ctx, storageMap, reloads } = makeCtx()
    const timers = fakeTimers()
    const acquire = vi.fn(async () => acquired())

    // Seed the state the tick would otherwise produce: same doc, same picks.
    await seedDocCache(ctx.storage)
    for (const p of PRIORITIES) {
      await seedPin(ctx.storage, DOC, p, { v: 1, id: "acme/alpha", since: NOW })
    }

    await wire(ctx, deps(acquire, timers))
    await drain() // the background first refresh already saw these picks
    await timers.fns[0]()

    expect(reloads).toEqual([])
    expect(storageMap.get(pinKeyFor(DOC, "quality"))).toEqual({
      v: 1,
      id: "acme/alpha",
      since: NOW,
    })
  })

  test("a failed refresh re-resolves without a catalog: a pin that became non-runnable falls back (§9)", async () => {
    const { ctx, raw, reloads, transformCallbacks } = makeCtx()
    raw.options = { fallback: "openrouter/zeta/fb" }
    const timers = fakeTimers()
    raw.model.list.mockReturnValue({
      location: {},
      data: [
        { id: "acme/alpha", providerID: "openrouter", enabled: true },
        { id: "zeta/fb", providerID: "openrouter", enabled: true },
      ],
    })
    await seedDocCache(ctx.storage)
    for (const p of PRIORITIES) {
      await seedPin(ctx.storage, DOC, p, { v: 1, id: "acme/alpha", since: NOW })
    }
    const acquire = vi.fn(async (): Promise<Acquired> => {
      throw new Error("offline")
    })
    await wire(ctx, deps(acquire, timers))
    await drain()
    expect(reloads).toEqual([]) // pin still runnable: nothing changed

    // acme/alpha disappears from OpenRouter's enabled list while we are offline.
    raw.model.list.mockReturnValue({
      location: {},
      data: [{ id: "zeta/fb", providerID: "openrouter", enabled: true }],
    })
    await timers.fns[0]()

    expect(reloads).toEqual(["provider", "model", "agent"])
    const { editor, byKey } = makeEditor([concrete("zeta/fb")])
    transformCallbacks[0](editor)
    const quality = aliasOf(byKey, "quality")
    expect(quality.enabled).toBe(true)
    expect(quality.modelID).toBe("zeta/fb")
    expect(quality.name).toBe("Model Compare: quality → zeta/fb (fallback)")
  })

  test("overlapping refresh → the second tick is skipped", async () => {
    const { ctx } = makeCtx()
    const timers = fakeTimers()
    let release!: (value: Acquired) => void
    const gate = new Promise<Acquired>((resolveGate) => {
      release = resolveGate
    })
    const acquire = vi.fn(async () => gate)

    await wire(ctx, deps(acquire, timers))
    // The background first refresh holds the non-overlap guard; let it finish
    // so the overlap scenario below starts from an idle tick.
    release(acquired())
    await drain()

    let release2!: (value: Acquired) => void
    const gate2 = new Promise<Acquired>((resolveGate) => {
      release2 = resolveGate
    })
    acquire.mockImplementation(() => gate2)
    const first = timers.fns[0]()
    const second = timers.fns[0]()
    release2(acquired())
    await Promise.all([first, second])

    // One from the background kick-off, one from the first manual tick — the
    // second manual tick was skipped while the first was still running.
    expect(acquire).toHaveBeenCalledTimes(2)
  })

  test("a hung acquire hits the deadline: the tick logs, resets its guard, and the next tick runs (F-01)", async () => {
    const { ctx } = makeCtx()
    const timers = fakeTimers()
    const acquire = vi.fn<() => Promise<Acquired>>(() => new Promise(() => {})) // never settles
    await wire(ctx, { ...deps(acquire, timers), deadlineMs: 20 })
    await new Promise((resolve) => setTimeout(resolve, 60)) // the kick-off tick hits its deadline

    expect(errorSpy).toHaveBeenCalledWith("[model-compare]", expect.objectContaining({
      message: expect.stringMatching(/deadline/),
    }))

    // The guard was reset: a later tick is NOT skipped, and it can complete.
    acquire.mockImplementation(async () => acquired())
    await timers.fns[0]()
    expect(acquire).toHaveBeenCalledTimes(2)
  })

  test("an abandoned tick touches neither state nor storage (the pre-write re-check)", async () => {
    const { ctx, raw, storageMap, reloads } = makeCtx()
    const timers = fakeTimers()
    // The runnable-set fetch hangs past the deadline: the body resumes after
    // the abandonment and must stop BEFORE persisting anything.
    let releaseList!: () => void
    raw.model.list.mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseList = () =>
            resolve({
              location: {},
              data: [{ id: "acme/alpha", providerID: "openrouter", enabled: true }],
            })
        }),
    )
    const acquire = vi.fn(async () => acquired())

    await wire(ctx, { ...deps(acquire, timers), deadlineMs: 250 })
    // The body reaches the gated call in milliseconds; once it is parked
    // there, wait well past the deadline and only then resume it.
    await waitUntil(() => releaseList !== undefined)
    await new Promise((resolve) => setTimeout(resolve, 400)) // the deadline fires
    releaseList()
    await new Promise((resolve) => setTimeout(resolve, 10)) // let the body reach its re-check

    expect(storageMap.size).toBe(0) // no pin record, no cached doc
    expect(reloads).toEqual([])
  })

  test("an abandoned tick never commits its plan (the post-reload re-check)", async () => {
    const { ctx, raw, hookCallbacks } = makeCtx()
    const timers = fakeTimers()
    const acquire = vi.fn(async () => acquired())
    // The reload chain outlives the deadline: the body resumes after the
    // abandonment and must stop BEFORE commitApplied.
    let releaseReload!: () => void
    raw.provider.reload.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          releaseReload = resolve
        }),
    )

    await wire(ctx, { ...deps(acquire, timers), deadlineMs: 250 })
    await waitUntil(() => releaseReload !== undefined) // parked mid-reload
    await new Promise((resolve) => setTimeout(resolve, 400)) // the deadline fires
    releaseReload()
    await new Promise((resolve) => setTimeout(resolve, 10)) // the chain finishes, silently

    // The applied view did not move: the alias stays disabled for the guard
    // (and /use-best), and the next tick's diff retries the reload.
    await expect(
      hookCallbacks[0]({
        sessionID: "s1",
        agent: "mc-quality",
        model: { providerID: "openrouter", id: "model-compare/quality" },
        kind: "primary",
        request: {},
      }),
    ).rejects.toThrow(/no ranking data/)
  })

  test("acquire failure → logged via console.error, never thrown", async () => {
    const { ctx, reloads } = makeCtx()
    const timers = fakeTimers()
    const acquire = vi.fn(async () => {
      throw new Error("source exploded")
    })

    await wire(ctx, deps(acquire, timers))
    await drain() // the background first refresh fails and logs
    await expect(timers.fns[0]()).resolves.toBeUndefined()

    expect(errorSpy).toHaveBeenCalledWith("[model-compare]", expect.any(Error))
    expect(reloads).toEqual([])
  })
})

// ---- state/registry consistency (F-10) ------------------------------------

describe("state and registry stay consistent (F-10)", () => {
  const guardEvent = {
    sessionID: "s1",
    agent: "mc-quality",
    model: { providerID: "openrouter", id: "model-compare/quality" },
    kind: "primary",
    request: {},
  }
  const guardMessage =
    "model-compare: no ranking data for openrouter/model-compare/quality; set options.fallback or check the data source"

  // acquire fails the kick-off tick (cold, nothing to adopt), then serves DOC.
  async function coldThenFresh() {
    const harness = makeCtx()
    const timers = fakeTimers()
    const acquire = vi.fn(async (): Promise<Acquired> => {
      throw new Error("offline")
    })
    await wire(harness.ctx, deps(acquire, timers))
    await drain()
    acquire.mockImplementation(async () => acquired())
    return { ...harness, timers, acquire }
  }

  test("a throwing storage write leaves the state untouched; the next tick retries and applies", async () => {
    const { raw, reloads, hookCallbacks, timers } = await coldThenFresh()
    let broken = true
    const working = raw.storage.set.getMockImplementation()!
    raw.storage.set.mockImplementation(async (key: string, value: unknown) => {
      if (broken) throw new Error("storage is down")
      return working(key, value)
    })

    await expect(timers.fns[0]()).resolves.toBeUndefined() // logged, not thrown
    // Nothing was claimed or applied: no reload, and the guard still sees a
    // disabled alias.
    expect(reloads).toEqual([])
    await expect(hookCallbacks[0](guardEvent)).rejects.toThrow(guardMessage)

    broken = false
    await timers.fns[0]()
    expect(reloads).toEqual(["provider", "model", "agent"])
    await expect(hookCallbacks[0](guardEvent)).resolves.toBeUndefined()
  })

  test("a throwing provider.reload is not reported as applied; the next tick retries the whole chain", async () => {
    const { raw, reloads, hookCallbacks, commands, timers, transformCallbacks } = await coldThenFresh()
    let broken = true
    raw.provider.reload.mockImplementation(async () => {
      if (broken) throw new Error("reload failed")
      reloads.push("provider")
    })

    await timers.fns[0]()
    expect(errorSpy).toHaveBeenCalledWith("[model-compare]", expect.objectContaining({ message: "reload failed" }))
    // The applied view (guard, /use-best) did not move: the change was not applied.
    await expect(hookCallbacks[0](guardEvent)).rejects.toThrow(guardMessage)
    const useBest = commands.find((c) => c.name === "use-best")!
    await useBest.execute({ sessionID: "s1", prompt: { text: "quality" } })
    expect(raw.session.switchModel).not.toHaveBeenCalled()
    // ...while the registry's next replay already serves the new plan.
    const { editor, byKey } = makeEditor([concrete("acme/alpha")])
    transformCallbacks[0](editor)
    expect(aliasOf(byKey, "quality").enabled).toBe(true)

    broken = false
    await timers.fns[0]() // pins and doc are persisted already: only the difference drives the retry
    expect(reloads).toEqual(["provider", "model", "agent"])
    await expect(hookCallbacks[0](guardEvent)).resolves.toBeUndefined()
    await useBest.execute({ sessionID: "s1", prompt: { text: "quality" } })
    expect(raw.session.switchModel).toHaveBeenCalledTimes(1)
  })

  test("a later reload failure (agent.reload) is retried too", async () => {
    const { raw, reloads, timers } = await coldThenFresh()
    let broken = true
    raw.agent.reload.mockImplementation(async () => {
      if (broken) throw new Error("agent reload failed")
      reloads.push("agent")
    })
    await timers.fns[0]()
    expect(reloads).toEqual(["provider", "model"])
    broken = false
    await timers.fns[0]()
    expect(reloads).toEqual(["provider", "model", "provider", "model", "agent"])
  })

  test("a settled tick with nothing new does not reload again", async () => {
    const { reloads, timers } = await coldThenFresh()
    await timers.fns[0]()
    await timers.fns[0]()
    expect(reloads).toEqual(["provider", "model", "agent"])
  })

  test("applyAliases disables the alias for the guard and /use-best when the concrete model is missing from the editor", async () => {
    const { ctx, raw, hookCallbacks, commands } = makeCtx()
    // Registration-time application against an editor WITHOUT acme/alpha, even
    // though ctx.model.list() reported it runnable (another plugin removed it).
    const { editor, byKey } = makeEditor([])
    raw.model.transform.mockImplementation(async (cb) => {
      cb(editor)
      return { dispose: vi.fn(async () => {}) }
    })
    await seedDocCache(ctx.storage)
    await seedPin(ctx.storage, DOC, "quality", { v: 1, id: "acme/alpha", since: NOW })

    await wire(ctx, deps(vi.fn(), fakeTimers()))

    expect(aliasOf(byKey, "quality").enabled).toBe(false) // the registry disabled it
    await expect(hookCallbacks[0](guardEvent)).rejects.toThrow(guardMessage)
    const useBest = commands.find((c) => c.name === "use-best")!
    await useBest.execute({ sessionID: "s1", prompt: { text: "quality" } })
    expect(raw.session.switchModel).not.toHaveBeenCalled()
  })

  test("a registry-disabled alias does not trigger a reload on every tick", async () => {
    const { ctx, raw, reloads } = makeCtx()
    const { editor } = makeEditor([])
    raw.model.transform.mockImplementation(async (cb) => {
      cb(editor)
      return { dispose: vi.fn(async () => {}) }
    })
    const timers = fakeTimers()
    await seedDocCache(ctx.storage)
    for (const p of PRIORITIES) await seedPin(ctx.storage, DOC, p, { v: 1, id: "acme/alpha", since: NOW })
    await wire(ctx, deps(async () => acquired(), timers))
    await drain()
    await timers.fns[0]()
    expect(reloads).toEqual([])
  })
})

// ---- guard hook ------------------------------------------------------------

describe("guard hook", () => {
  function primaryEvent(overrides: Partial<{ agent: string; kind: string }> = {}) {
    return {
      sessionID: "s1",
      agent: overrides.agent ?? "mc-quality",
      model: { providerID: "openrouter", id: "model-compare/quality" },
      kind: overrides.kind ?? "primary",
      request: {},
    }
  }

  test("disabled alias + alias-configured agent → throws the exact message", async () => {
    const { ctx, hookCallbacks } = makeCtx()
    await wire(ctx, deps(vi.fn(), fakeTimers()))
    // Two registrations now: [0] the guard, [1] the steering injection hook
    // (spike fact 4a: a second http.request hook in the same plugin coexists).
    expect(hookCallbacks).toHaveLength(2)

    await expect(hookCallbacks[0](primaryEvent())).rejects.toThrow(
      "model-compare: no ranking data for openrouter/model-compare/quality; set options.fallback or check the data source",
    )
  })

  test("disabled alias + non-alias agent → no throw, disabled-alias warning logged", async () => {
    const { ctx, hookCallbacks } = makeCtx()
    await wire(ctx, deps(vi.fn(), fakeTimers()))

    await expect(hookCallbacks[0](primaryEvent({ agent: "build" }))).resolves.toBeUndefined()
    // Non-primary kinds never fire, even for an alias-configured agent.
    await expect(hookCallbacks[0](primaryEvent({ kind: "title" }))).resolves.toBeUndefined()

    const warns = warnSpy.mock.calls.map((call: unknown[]) => call.join(" "))
    expect(warns.some((w: string) => w.includes("aliases disabled"))).toBe(true)
  })
})

// ---- steering injection hook -----------------------------------------------

describe("steering injection hook", () => {
  // The provider sub-object the fixture's steering block projects to
  // (STEERED_DOC.models[0].steering, built field-by-field by injectSteering).
  const PROVIDER = {
    order: ["novita/fp8", "deepinfra/fp8"],
    ignore: ["coreweave/fp4"],
    quantizations: ["fp8"],
    allow_fallbacks: true,
  }

  const REQUEST_URL = "https://openrouter.ai/api/v1/chat/completions"

  // wire() with the steered catalog seeded and the price pick resolved to the
  // steered model. The injection hook is the SECOND registration ([1], after
  // the guard's).
  async function wired() {
    const harness = makeCtx()
    await writeCachedDoc(harness.ctx.storage, localIdentity(null), {
      doc: STEERED_DOC,
      acquiredAt: NOW,
    })
    await seedPin(harness.ctx.storage, STEERED_DOC, "price", { v: 1, id: "acme/alpha", since: NOW })
    await wire(harness.ctx, deps(vi.fn(), fakeTimers()))
    await drain()
    expect(harness.hookCallbacks).toHaveLength(2)
    return harness
  }

  function steeredEvent(
    opts: {
      model?: ModelRef
      kind?: string
      sessionID?: string
      body?: unknown
      request?: unknown
    } = {},
  ) {
    return {
      sessionID: opts.sessionID ?? "s1",
      agent: "build",
      model: opts.model ?? { providerID: "openrouter", id: "model-compare/price" },
      kind: opts.kind ?? "primary",
      request:
        opts.request ??
        new Request(REQUEST_URL, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "content-length": "123",
            "content-encoding": "gzip",
          },
          body: JSON.stringify(
            opts.body ?? {
              model: "acme/alpha",
              messages: [{ role: "user", content: "hi" }],
              stream: true,
            },
          ),
        }),
    }
  }

  async function bodyOf(request: Request): Promise<Record<string, unknown>> {
    return JSON.parse(await request.text()) as Record<string, unknown>
  }

  test("an alias-scoped request is re-created with the steering provider injected into its body", async () => {
    const { hookCallbacks } = await wired()
    const event = steeredEvent()
    const original = event.request as Request

    await hookCallbacks[1](event)

    const rebuilt = event.request as Request
    expect(rebuilt).not.toBe(original)
    expect(rebuilt.url).toBe(original.url)
    expect(rebuilt.method).toBe("POST")
    // The copied headers survive minus the stale length/encoding pair the
    // runtime re-derives (spike fact 2's recipe).
    expect(rebuilt.headers.get("content-type")).toBe("application/json")
    expect(rebuilt.headers.has("content-length")).toBe(false)
    expect(rebuilt.headers.has("content-encoding")).toBe(false)

    const body = await bodyOf(rebuilt)
    expect(body.model).toBe("acme/alpha")
    expect(body.messages).toEqual([{ role: "user", content: "hi" }])
    expect(body.stream).toBe(true)
    expect(body.provider).toEqual(PROVIDER)
  })

  test("a compaction-kind request bound to the alias is steered too (no kind filter)", async () => {
    const { hookCallbacks } = await wired()
    const event = steeredEvent({ kind: "compaction" })
    await hookCallbacks[1](event)
    const body = await bodyOf(event.request as Request)
    expect(body.provider).toEqual(PROVIDER)
  })

  test("a DIRECTLY-PICKED request whose model id equals the pick's is untouched (the anti-goal)", async () => {
    const { hookCallbacks } = await wired()
    const event = steeredEvent({ model: { providerID: "openrouter", id: "acme/alpha" } })
    const original = event.request
    await hookCallbacks[1](event)
    expect(event.request).toBe(original)
    expect(Object.hasOwn(await bodyOf((original as Request).clone()), "provider")).toBe(false)
  })

  test("a body that already carries a provider key is untouched (no clobber)", async () => {
    const { hookCallbacks } = await wired()
    const event = steeredEvent({
      body: {
        model: "acme/alpha",
        provider: { order: ["elsewhere/fp4"], ignore: [], allow_fallbacks: false },
      },
    })
    const original = event.request
    await hookCallbacks[1](event)
    expect(event.request).toBe(original)
    expect((await bodyOf((original as Request).clone())).provider).toEqual({
      order: ["elsewhere/fp4"],
      ignore: [],
      allow_fallbacks: false,
    })
  })

  test("a non-alias request is untouched", async () => {
    const { hookCallbacks } = await wired()
    const event = steeredEvent({ model: { providerID: "openrouter", id: "z-ai/glm-5.3-flash" } })
    const original = event.request
    await hookCallbacks[1](event)
    expect(event.request).toBe(original)
  })

  test("a body whose model differs from the pick's id is untouched", async () => {
    const { hookCallbacks } = await wired()
    const event = steeredEvent({ body: { model: "other/model" } })
    const original = event.request
    await hookCallbacks[1](event)
    expect(event.request).toBe(original)
  })

  test("a pick whose model carries no steering block is untouched", async () => {
    const harness = makeCtx()
    await seedDocCache(harness.ctx.storage) // DOC's model carries no steering block
    await seedPin(harness.ctx.storage, DOC, "price", { v: 1, id: "acme/alpha", since: NOW })
    await wire(harness.ctx, deps(vi.fn(), fakeTimers()))
    await drain()
    const event = steeredEvent()
    const original = event.request
    await harness.hookCallbacks[1](event)
    expect(event.request).toBe(original)
  })

  test("an unparseable or missing body is left untouched", async () => {
    const { hookCallbacks } = await wired()
    const unparseable = new Request(REQUEST_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    })
    const event = steeredEvent({ request: unparseable })
    await expect(hookCallbacks[1](event)).resolves.toBeUndefined()
    expect(event.request).toBe(unparseable)

    // A bodyless GET parses to nothing: untouched too.
    const bodyless = new Request(REQUEST_URL)
    const event2 = steeredEvent({ request: bodyless })
    await expect(hookCallbacks[1](event2)).resolves.toBeUndefined()
    expect(event2.request).toBe(bodyless)
  })

  test("a hook failure is swallowed: the original request proceeds", async () => {
    const { hookCallbacks } = await wired()
    const broken = {
      clone() {
        throw new Error("boom")
      },
    }
    const event = steeredEvent({ request: broken })
    await expect(hookCallbacks[1](event)).resolves.toBeUndefined()
    expect(event.request).toBe(broken)
  })
})

// ---- commands --------------------------------------------------------------

describe("commands", () => {
  test("/use-best refuses to switch to a disabled alias", async () => {
    const { ctx, commands, raw } = makeCtx()
    await wire(ctx, deps(vi.fn(), fakeTimers()))

    const useBest = commands.find((c) => c.name === "use-best")
    expect(useBest).toBeDefined()
    await useBest!.execute({ sessionID: "s1", prompt: { text: "" } })

    expect(raw.session.switchModel).not.toHaveBeenCalled()
    expect(raw.session.synthetic).toHaveBeenCalledWith({
      sessionID: "s1",
      text: "model-compare: openrouter/model-compare/balanced is currently disabled (no ranking data); not switching",
      resume: false,
    })
  })

  test("/use-best with an unknown priority → refused with the valid names", async () => {
    const { ctx, commands, raw } = makeCtx()
    await wire(ctx, deps(vi.fn(), fakeTimers()))

    const useBest = commands.find((c) => c.name === "use-best")!
    await useBest.execute({ sessionID: "s1", prompt: { text: "fastest" } })

    expect(raw.session.switchModel).not.toHaveBeenCalled()
    expect(raw.session.synthetic).toHaveBeenCalledWith({
      sessionID: "s1",
      text: expect.stringContaining('unknown priority "fastest"'),
      resume: false,
    })
  })

  test("/use-best on an enabled alias switches to the alias ref", async () => {
    const { ctx, commands, raw } = makeCtx()
    await seedDocCache(ctx.storage)
    for (const p of PRIORITIES) {
      await seedPin(ctx.storage, DOC, p, { v: 1, id: "acme/alpha", since: NOW })
    }
    await wire(ctx, deps(vi.fn(), fakeTimers()))

    const useBest = commands.find((c) => c.name === "use-best")!
    await useBest.execute({ sessionID: "s2", prompt: { text: "price" } })

    expect(raw.session.switchModel).toHaveBeenCalledWith({
      sessionID: "s2",
      model: { providerID: "openrouter", id: "model-compare/price" },
    })
    expect(raw.session.synthetic).toHaveBeenCalledWith({
      sessionID: "s2",
      text: "model-compare: switched to openrouter/model-compare/price (currently acme/alpha)",
      resume: false,
    })
  })

  test("/model-compare with no data says so", async () => {
    const { ctx, commands, raw } = makeCtx()
    await wire(ctx, deps(vi.fn(), fakeTimers()))

    const report = commands.find((c) => c.name === "model-compare")
    expect(report).toBeDefined()
    await report!.execute({ sessionID: "s1", prompt: { text: "" } })

    expect(raw.session.synthetic).toHaveBeenCalledWith({
      sessionID: "s1",
      text: "model-compare: no ranking data available yet",
      resume: false,
    })
  })

  test("/model-compare with data renders the report", async () => {
    const { ctx, commands, raw } = makeCtx()
    await seedDocCache(ctx.storage)
    await wire(ctx, deps(vi.fn(), fakeTimers()))

    const report = commands.find((c) => c.name === "model-compare")!
    await report.execute({ sessionID: "s3", prompt: { text: "" } })

    expect(raw.session.synthetic).toHaveBeenCalledTimes(1)
    const text = raw.session.synthetic.mock.calls[0][0].text
    expect(text).toContain("**model-compare**")
    expect(text).toContain("### quality")
    expect(text).toContain("1. acme/alpha (0.500)")
    expect(raw.session.synthetic.mock.calls[0][0].resume).toBe(false)
  })

  test("/model-compare ranks with the configured weights and marks the current pick (F-07)", async () => {
    const { ctx, commands, raw } = makeCtx()
    // Two models that swap places when price is everything: upstream's
    // published quality ranking says [aaa, zzz]; a price-only override says [zzz, aaa].
    const twoRaw = {
      ...raw_,
      models: ["aaa", "zzz"].map((id, i) => ({
        id: `acme/${id}`,
        name: id,
        pricing: { blended_per_1m: 1 },
        context: 1000,
        scores: {
          quality: i === 0 ? 0.9 : 0.1,
          price: i === 0 ? 0.1 : 0.9,
          context: 0.5,
          age: 0.5,
          overall: { balanced: 0.5, price: 0.5, quality: i === 0 ? 0.8 : 0.2 },
        },
      })),
      rankings: { quality: ["acme/aaa", "acme/zzz"] },
    }
    const checked = validateCatalog(twoRaw)
    if (!checked.ok) throw new Error(checked.reason)
    const options = { weights: { quality: { quality: 0, price: 1, context: 0, age: 0 } } }
    raw.options = options
    raw.model.list.mockReturnValue({
      location: {},
      data: ["aaa", "zzz"].map((id) => ({ id: `acme/${id}`, providerID: "openrouter", enabled: true })),
    })
    await writeCachedDoc(ctx.storage, localIdentity(null), { doc: checked.catalog, acquiredAt: NOW })
    const key = pinKey("quality", effectiveWeights(checked.catalog, "quality", options.weights.quality).weights)
    await ctx.storage.set(key, { v: 1, id: "acme/aaa", since: NOW }) // pinned to the OLD leader
    await wire(ctx, deps(vi.fn(), fakeTimers()))

    const report = commands.find((c) => c.name === "model-compare")!
    await report.execute({ sessionID: "s9", prompt: { text: "" } })
    const text = raw.session.synthetic.mock.calls[0][0].text as string
    const quality = text.slice(text.indexOf("### quality"))
    expect(quality).toContain("### quality (custom weights)")
    // Ranked under the override: zzz first, not upstream's aaa.
    expect(quality.indexOf("acme/zzz")).toBeLessThan(quality.indexOf("acme/aaa"))
    expect(quality).toContain("1. acme/zzz (0.900)") // recomputed score, not the published 0.2
    // The pin (aaa) is the actual pick even though zzz ranks first.
    expect(quality).toMatch(/2\. acme\/aaa \(0\.100\) ← current pick/)
  })

  test("the RPC's report serves the same text the command synthesizes", async () => {
    const { ctx, raw, commands, rpcHandlers } = makeCtx()
    await seedDocCache(ctx.storage)
    await seedPin(ctx.storage, DOC, "quality", { v: 1, id: "acme/alpha", since: NOW })
    await wire(ctx, deps(vi.fn(), fakeTimers()))

    expect(rpcHandlers.report).toBeDefined()
    const report = await rpcHandlers.report({})
    const text = (report as { text: string }).text
    expect(text).toContain("top 5 per priority")
    expect(text).toContain("← current pick")

    // One builder, two surfaces: the command's synthetic message is the same
    // text the TUI's instant dialog renders.
    const command = commands.find((c) => c.name === "model-compare")!
    await command.execute({ sessionID: "s10", prompt: { text: "" } })
    expect(raw.session.synthetic.mock.calls.at(-1)![0].text).toBe(text)
  })

  test("/model-compare emits the report event with structured entries", async () => {
    const { ctx, raw, commands, rpcEmit } = makeCtx()
    await seedDocCache(ctx.storage)
    await seedPin(ctx.storage, DOC, "quality", { v: 1, id: "acme/alpha", since: NOW })
    await wire(ctx, deps(vi.fn(), fakeTimers()))

    const command = commands.find((c) => c.name === "model-compare")!
    await command.execute({ sessionID: "s11", prompt: { text: "" } })

    expect(rpcEmit).toHaveBeenCalledTimes(1)
    const [name, data] = rpcEmit.mock.calls[0]
    expect(name).toBe("report")
    const payload = data as { sessionID: string; age: string | null; entries: Array<{ id: string; rank: number | null; current: boolean; quality: string; price: string }> }
    expect(payload.sessionID).toBe("s11")
    expect(payload.age).toEqual(expect.any(String))
    // The seeded quality pick appears as a current entry.
    expect(payload.entries.some((e) => e.id === "acme/alpha" && e.current === true)).toBe(true)
    // The table columns ride the payload (quality index, input/output pair).
    expect(payload.entries.every((e) => typeof e.quality === "string" && typeof e.price === "string")).toBe(true)
    // The synthetic still carries the text report (one ranking, two views).
    expect(raw.session.synthetic.mock.calls.at(-1)![0].text).toContain("top 5 per priority")
  })

  test("the RPC's report without data returns the no-data line", async () => {
    const { ctx, raw, commands, rpcHandlers, rpcEmit } = makeCtx()
    await wire(ctx, deps(vi.fn(), fakeTimers()))

    const report = await rpcHandlers.report({})
    expect((report as { text: string }).text).toBe("model-compare: no ranking data available yet")

    // The command's no-data path emits an empty-entry event: the TUI's
    // dialog degrades to a no-data toast instead of an empty list.
    const command = commands.find((c) => c.name === "model-compare")!
    await command.execute({ sessionID: "s12", prompt: { text: "" } })
    const [name, data] = rpcEmit.mock.calls[0]
    expect(name).toBe("report")
    expect((data as { sessionID: string; entries: unknown[] }).sessionID).toBe("s12")
    expect((data as { entries: unknown[] }).entries).toEqual([])
  })
})

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
import { wire, type PluginCtx, type WireDeps, type WireState } from "../../src/index"
import { ModelCompare } from "../../src/rpc"

const NOW = Date.now()
const PRIORITIES: Priority[] = ["balanced", "price", "quality"]

// One schema-valid document with a single model, so every priority's ranking
// has the same predictable winner. Validated once and shared by the fixtures.
const raw = {
  schema_version: 6,
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
      quality: 46.8,
      quality_effort: "high",
      reasoning: {
        default_effort: "high",
        supported_efforts: ["max", "high"],
        default_enabled: true,
        mandatory: false,
        supports_max_tokens: null,
        depths: [
          { effort: "max", index: 56, cost_per_task_usd: 5.46, source: "aa", as_of: "t" },
          { effort: "high", index: 46.8, cost_per_task_usd: 1.2, source: "aa", as_of: "t" },
        ],
      },
      steering: {
        model: raw.models[0].id,
        provider: {
          order: ["novita/fp8", "deepinfra/fp8"],
          ignore: ["coreweave/fp4"],
          quantizations: ["fp8"],
          allow_fallbacks: true,
        },
      },
      endpoints: [
        { provider_name: "Novita", tag: "novita/fp8", quantization: "fp8" },
        { provider_name: "DeepInfra", tag: "deepinfra/fp8", quantization: "fp8" },
        { provider_name: "OpenInference", tag: "open-inference/fp4", quantization: "fp4" },
      ],
      default_precision: "fp8",
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

type ModelRef = { providerID: string; id: string; variant?: string }

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
  // The response event's body (http.response only; absent on http.request).
  response?: unknown
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
  // The emit fake validates names against the REAL definition (NEW-2): an
  // undeclared event name must fail loudly here — the old free-form mock
  // passed anything, which is exactly the blindness that hid F1 (the plugin
  // emitted an undeclared `cannotSteer` and every test stayed green).
  const rpcEmit = vi.fn(async (name: string, _data: unknown) => {
    if (!Object.hasOwn(ModelCompare.events, name)) {
      throw new Error(`undeclared RPC event emitted: model-compare.${name}`)
    }
  })
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
      hook: vi.fn(async (
        _name: "http.request" | "http.response",
        cb: (event: HookEvent) => Promise<void>,
      ) => {
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

  test("the alias display name carries only the pick, not the catalog effort/alternative", async () => {
    const { ctx, raw } = makeCtx()
    const { editor, byKey } = makeEditor([concrete("acme/alpha")])
    raw.model.transform.mockImplementation(async (cb) => {
      cb(editor)
      return { dispose: vi.fn(async () => {}) }
    })
    await writeCachedDoc(ctx.storage, localIdentity(null), { doc: STEERED_DOC, acquiredAt: NOW })
    await seedPin(ctx.storage, STEERED_DOC, "price", { v: 1, id: "acme/alpha", since: NOW })

    await wire(ctx, deps(vi.fn(), fakeTimers()))
    await drain()

    // STEERED_DOC's entry carries qualityEffort/reasoning data, but the byline
    // must show only the pick: OpenCode renders the selected variant itself.
    expect(aliasOf(byKey, "price").name).toBe("Model Compare: price → acme/alpha")
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
      v: 2,
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
      v: 2,
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
    // Three registrations now: [0] the guard, [1] the steering injection hook
    // (spike fact 4a: a second http.request hook in the same plugin
    // coexists), and [2] the response capture hook.
    expect(hookCallbacks).toHaveLength(3)

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
  // the guard's); the response capture hook is the third ([2]). An optional
  // onState seam exposes the live WireState for record-level assertions.
  async function wired(opts: { onState?: (s: WireState) => void } = {}) {
    const harness = makeCtx()
    await writeCachedDoc(harness.ctx.storage, localIdentity(null), {
      doc: STEERED_DOC,
      acquiredAt: NOW,
    })
    await seedPin(harness.ctx.storage, STEERED_DOC, "price", { v: 1, id: "acme/alpha", since: NOW })
    await wire(harness.ctx, { ...deps(vi.fn(), fakeTimers()), onState: opts.onState })
    await drain()
    expect(harness.hookCallbacks).toHaveLength(3)
    return harness
  }

  function steeredEvent(
    opts: {
      model?: ModelRef
      kind?: string
      sessionID?: string
      body?: unknown
      headers?: Record<string, string>
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
          headers: opts.headers ?? {
            "content-type": "application/json",
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
    const event = steeredEvent({
      headers: {
        "content-type": "application/json",
        "content-length": "123",
        "content-encoding": "gzip",
      },
    })
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

  test("the alias request pins the catalog's scored reasoning effort in its body", async () => {
    const { hookCallbacks } = await wired()
    const event = steeredEvent()
    await hookCallbacks[1](event)
    const body = await bodyOf(event.request as Request)
    // Both blocks ride the same re-created Request.
    expect(body.provider).toEqual(PROVIDER)
    expect(body.reasoning).toEqual({ effort: "high" })
  })

  test("an explicit #variant selection wins over the catalog effort (the provider still steers)", async () => {
    const { hookCallbacks } = await wired()
    const event = steeredEvent({
      model: { providerID: "openrouter", id: "model-compare/price", variant: "max" },
    })
    const original = event.request as Request
    await hookCallbacks[1](event)
    const body = await bodyOf(event.request as Request)
    expect(event.request).not.toBe(original) // the provider block still applies
    expect(body.provider).toEqual(PROVIDER)
    expect(Object.hasOwn(body, "reasoning")).toBe(false)
  })

  test("a body that already sets reasoning is untouched by the effort injection", async () => {
    const { hookCallbacks } = await wired()
    const event = steeredEvent({
      body: {
        model: "acme/alpha",
        messages: [{ role: "user", content: "hi" }],
        reasoning: { effort: "max", exclude: false },
      },
    })
    await hookCallbacks[1](event)
    const body = await bodyOf(event.request as Request)
    expect(body.reasoning).toEqual({ effort: "max", exclude: false })
    expect(body.provider).toEqual(PROVIDER)
  })

  test("a pick with no scored effort injects no reasoning", async () => {
    const harness = makeCtx()
    await seedDocCache(harness.ctx.storage) // DOC's model has qualityEffort null
    await seedPin(harness.ctx.storage, DOC, "price", { v: 1, id: "acme/alpha", since: NOW })
    await wire(harness.ctx, deps(vi.fn(), fakeTimers()))
    await drain()
    const event = steeredEvent()
    await harness.hookCallbacks[1](event)
    expect(Object.hasOwn(await bodyOf(event.request as Request), "reasoning")).toBe(false)
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

  test("a body that already carries a provider key keeps it (no clobber) while the effort still lands", async () => {
    const { hookCallbacks } = await wired()
    const event = steeredEvent({
      body: {
        model: "acme/alpha",
        provider: { order: ["elsewhere/fp4"], ignore: [], allow_fallbacks: false },
      },
    })
    await hookCallbacks[1](event)
    const body = await bodyOf(event.request as Request)
    expect(body.provider).toEqual({
      order: ["elsewhere/fp4"],
      ignore: [],
      allow_fallbacks: false,
    })
    // Independent fields: the routing no-clobber does not withhold the effort.
    expect(body.reasoning).toEqual({ effort: "high" })
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

  // The Q2 fallback (Task 6): a steerable alias request with NO steering data
  // (no catalog source — state.sourced is null) proceeds untouched, but the
  // TUI is told ONCE PER SESSION so it can toast the fallback. The scenario
  // is the cold start with a runnable fallback: aliases are enabled pointing
  // at the fallback (a current pick exists), while no catalog was ever
  // acquired — so no steering block can exist.
  test("an alias request with no steering data emits the cannot-steer event once per session and leaves the body untouched", async () => {
    const harness = makeCtx()
    // Cold start with a runnable fallback: aliases enabled, sourced stays null.
    harness.raw.options = { fallback: "openrouter/zeta/fallback" }
    harness.raw.model.list.mockReturnValue({
      location: {},
      data: [{ id: "zeta/fallback", providerID: "openrouter", enabled: true }],
    })
    await wire(harness.ctx, deps(vi.fn(), fakeTimers()))
    await drain()
    expect(harness.hookCallbacks).toHaveLength(3)

    const event = steeredEvent()
    const original = event.request as Request
    await harness.hookCallbacks[1](event)

    // Exactly one event for the first request, and the body is untouched.
    expect(harness.rpcEmit).toHaveBeenCalledTimes(1)
    const [name, data] = harness.rpcEmit.mock.calls[0]!
    expect(name).toBe("cannotSteer")
    expect(data).toEqual({ sessionID: "s1" })
    expect(event.request).toBe(original)
    expect(Object.hasOwn(await bodyOf((original as Request).clone()), "provider")).toBe(false)

    // A second request for the SAME session does not re-toast.
    await harness.hookCallbacks[1](steeredEvent())
    expect(harness.rpcEmit).toHaveBeenCalledTimes(1)

    // A DIFFERENT session gets its own once-only emit.
    await harness.hookCallbacks[1](steeredEvent({ sessionID: "s2" }))
    expect(harness.rpcEmit).toHaveBeenCalledTimes(2)
    const [secondName, secondData] = harness.rpcEmit.mock.calls[1]!
    expect(secondName).toBe("cannotSteer")
    expect(secondData).toEqual({ sessionID: "s2" })
  })

  // The pre-existing `provider` exclusion binds on the Q2 path too: a body
  // that already carries a `provider` key means user-configured routing is
  // active, so the "OpenRouter default routing applies" toast would be false
  // copy. The body read is gated behind the once-flag check (only when the
  // session hasn't been toasted yet AND the trigger conditions hold) and is
  // a cheap clone-parse — the original Request is never reassigned. The
  // provider-key skip does NOT consume the once-flag: a later provider-free
  // request for the same session still toasts.
  test("a Q2-path request whose body pre-sets provider emits nothing and does not consume the once-flag", async () => {
    const harness = makeCtx()
    harness.raw.options = { fallback: "openrouter/zeta/fallback" }
    harness.raw.model.list.mockReturnValue({
      location: {},
      data: [{ id: "zeta/fallback", providerID: "openrouter", enabled: true }],
    })
    await wire(harness.ctx, deps(vi.fn(), fakeTimers()))
    await drain()
    expect(harness.hookCallbacks).toHaveLength(3)

    // The provider-preset request: no emit, and the Request is untouched.
    const presetEvent = steeredEvent({
      body: {
        model: "acme/alpha",
        messages: [{ role: "user", content: "hi" }],
        provider: { order: ["acme"] },
      },
    })
    const original = presetEvent.request as Request
    await harness.hookCallbacks[1](presetEvent)
    expect(harness.rpcEmit).toHaveBeenCalledTimes(0)
    expect(presetEvent.request).toBe(original)
    expect(Object.hasOwn(await bodyOf((original as Request).clone()), "provider")).toBe(true)

    // The once-flag was NOT consumed: a provider-free request afterward
    // for the SAME session still toasts.
    const freeEvent = steeredEvent()
    const freeOriginal = freeEvent.request as Request
    await harness.hookCallbacks[1](freeEvent)
    expect(harness.rpcEmit).toHaveBeenCalledTimes(1)
    const [name, data] = harness.rpcEmit.mock.calls[0]!
    expect(name).toBe("cannotSteer")
    expect(data).toEqual({ sessionID: "s1" })
    expect(freeEvent.request).toBe(freeOriginal)

    // ...and it consumes the flag: a third request is silent.
    await harness.hookCallbacks[1](steeredEvent())
    expect(harness.rpcEmit).toHaveBeenCalledTimes(1)
  })

  test("applied WeakMap records null order after the no-catalog early-out and captures bounded body effort on both Q2 and steady-state turns", async () => {
    const harness = makeCtx()
    let state!: WireState
    harness.raw.options = { fallback: "openrouter/zeta/fallback" }
    harness.raw.model.list.mockReturnValue({
      location: {},
      data: [{ id: "zeta/fallback", providerID: "openrouter", enabled: true }],
    })
    await wire(harness.ctx, {
      ...deps(vi.fn(), fakeTimers()),
      onState: (s) => {
        state = s
      },
    })
    await drain()
    expect(harness.hookCallbacks).toHaveLength(3)

    // Turn 1 (Q2 cannot-steer fires): single bounded read captures body effort
    // without cloning twice.
    const rawTurn1 = new Request(REQUEST_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "zeta/fallback",
        messages: [{ role: "user", content: "hi" }],
        reasoning: { effort: "low" },
      }),
    })
    const cloneSpy = vi.spyOn(rawTurn1, "clone")
    const turn1 = steeredEvent({
      sessionID: "s1",
      model: { providerID: "openrouter", id: "model-compare/price", variant: "high" },
      request: rawTurn1,
    })
    await harness.hookCallbacks[1](turn1)
    expect(harness.rpcEmit).toHaveBeenCalledTimes(1)
    expect(cloneSpy).toHaveBeenCalledTimes(1)
    expect(state.applied.get(turn1.request as Request)).toEqual({
      order: null,
      effort: "low",
    })

    // Turn 2 (steady-state after cannotSteerToasted is set): still captures body effort.
    const turn2 = steeredEvent({
      sessionID: "s1",
      model: { providerID: "openrouter", id: "model-compare/price", variant: "high" },
      body: {
        model: "zeta/fallback",
        messages: [{ role: "user", content: "turn 2" }],
        output_config: { effort: "max" },
      },
    })
    await harness.hookCallbacks[1](turn2)
    expect(harness.rpcEmit).toHaveBeenCalledTimes(1)
    expect(state.applied.get(turn2.request as Request)).toEqual({
      order: null,
      effort: "max",
    })

    // Turn 1 on s2 with oversized body (>256 KiB): Q2 read is bounded, does NOT
    // clone a second time, and falls back cleanly to #variant.
    const bigPad = "x".repeat(260 * 1024)
    const rawOversized = new Request(REQUEST_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "zeta/fallback",
        pad: bigPad,
        reasoning: { effort: "low" },
      }),
    })
    const oversizedCloneSpy = vi.spyOn(rawOversized, "clone")
    const oversizedTurn = steeredEvent({
      sessionID: "s2",
      model: { providerID: "openrouter", id: "model-compare/price", variant: "high" },
      request: rawOversized,
    })
    await harness.hookCallbacks[1](oversizedTurn)
    expect(oversizedCloneSpy).toHaveBeenCalledTimes(1)
    expect(state.applied.get(oversizedTurn.request as Request)).toEqual({
      order: null,
      effort: "high",
    })
    // Downstream fetch can still read the full 260 KiB original request body untouched.
    expect((await bodyOf(oversizedTurn.request as Request)).pad).toBe(bigPad)
  })

  test("an injecting request followed by a pre-set-provider request records independent WeakMap entries (and reasoning-only re-creation records order: null)", async () => {
    let state!: WireState
    const { hookCallbacks } = await wired({
      onState: (s) => {
        state = s
      },
    })

    // First request: full injection — WeakMap on the FINAL re-created Request holds the order + effort.
    const first = steeredEvent({ sessionID: "s1" })
    const firstOriginal = first.request as Request
    await hookCallbacks[1](first)
    expect(first.request).not.toBe(firstOriginal)
    expect(state.applied.get(first.request as Request)).toEqual({
      order: STEERING.order,
      effort: "high",
    })

    // Second request, SAME session, body pre-sets `provider`: reasoning still
    // injects and re-creates event.request, but `order` is null (never STEERING.order),
    // while `first.request` keeps its own order for concurrent correlation.
    const second = steeredEvent({
      sessionID: "s1",
      body: {
        model: "acme/alpha",
        messages: [{ role: "user", content: "hi" }],
        provider: { order: ["acme"] },
      },
    })
    await hookCallbacks[1](second)
    expect(state.applied.get(second.request as Request)).toEqual({
      order: null,
      effort: "high",
    })
    expect(state.applied.get(first.request as Request)).toEqual({
      order: STEERING.order,
      effort: "high",
    })
  })

  test("a pre-existing body.reasoning without a discrete effort (e.g. max_tokens) leaves injectReasoning a no-op and records effort: null", async () => {
    let state!: WireState
    const { hookCallbacks } = await wired({
      onState: (s) => {
        state = s
      },
    })

    const event = steeredEvent({
      body: {
        model: "acme/alpha",
        messages: [{ role: "user", content: "hi" }],
        reasoning: { max_tokens: 4096 },
      },
    })
    await hookCallbacks[1](event)
    const rebuilt = event.request as Request
    const body = await bodyOf(rebuilt)
    expect(body.reasoning).toEqual({ max_tokens: 4096 })
    expect(state.applied.get(rebuilt)).toEqual({
      order: STEERING.order,
      effort: null,
    })
  })

  test("non-alias primary requests bound body reads to 256 KiB, handle split multi-byte UTF-8 chunks, and fail open on compressed/oversized/null/primitive requests", async () => {
    let state!: WireState
    const { hookCallbacks } = await wired({
      onState: (s) => {
        state = s
      },
    })

    // Split 4-byte emoji 🌍 (F0 9F 8C 8D) across chunk boundaries before reasoning.effort.
    const fullBytes = new TextEncoder().encode(
      JSON.stringify({
        model: "claude-sonnet-4-5",
        messages: [{ role: "user", content: "hello 🌍" }],
        output_config: { effort: "max" },
      }),
    )
    const emojiStart = fullBytes.indexOf(0xf0)
    expect(emojiStart).toBeGreaterThan(0)
    const splitStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(fullBytes.subarray(0, emojiStart + 2))
        controller.enqueue(fullBytes.subarray(emojiStart + 2))
        controller.close()
      },
    })
    const splitReq = new Request("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: splitStream,
      duplex: "half",
    } as RequestInit)
    const splitEvent = steeredEvent({
      model: { providerID: "anthropic", id: "claude-sonnet-4-5", variant: "low" },
      request: splitReq,
    })
    await hookCallbacks[1](splitEvent)
    expect(splitEvent.request).toBe(splitReq)
    expect(state.applied.get(splitReq)).toEqual({ order: null, effort: "max" })
    // Original request body remains completely readable downstream.
    expect((await bodyOf(splitReq)).messages).toEqual([{ role: "user", content: "hello 🌍" }])

    // Compressed (content-encoding) skips cloning and falls back to #variant.
    const compressedReq = new Request(REQUEST_URL, {
      method: "POST",
      headers: { "content-type": "application/json", "content-encoding": "gzip" },
      body: new Uint8Array([0x1f, 0x8b, 0x08, 0x00]),
    })
    const compressedClone = vi.spyOn(compressedReq, "clone")
    await hookCallbacks[1](
      steeredEvent({
        model: { providerID: "openai", id: "gpt-5", variant: "medium" },
        request: compressedReq,
      }),
    )
    expect(compressedClone).not.toHaveBeenCalled()
    expect(state.applied.get(compressedReq)).toEqual({ order: null, effort: "medium" })

    // content-length > 256 KiB skips cloning and falls back to #variant.
    const declaredHugeReq = new Request(REQUEST_URL, {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": String(300 * 1024) },
      body: JSON.stringify({ reasoning: { effort: "low" } }),
    })
    const declaredHugeClone = vi.spyOn(declaredHugeReq, "clone")
    await hookCallbacks[1](
      steeredEvent({
        model: { providerID: "openai", id: "gpt-5", variant: "high" },
        request: declaredHugeReq,
      }),
    )
    expect(declaredHugeClone).not.toHaveBeenCalled()
    expect(state.applied.get(declaredHugeReq)).toEqual({ order: null, effort: "high" })

    // Headerless chunked stream > 256 KiB cancels the cloned reader and falls back to #variant.
    let cancelCalled = false
    const chunk = new Uint8Array(100 * 1024).fill(0x61)
    let pulls = 0
    const chunkedStream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls++
        if (pulls <= 4) controller.enqueue(chunk)
        else controller.close()
      },
      cancel() {
        cancelCalled = true
      },
    })
    // Spy on clone() so we observe reader cancellation directly on the cloned branch.
    const baseChunkedReq = new Request(REQUEST_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    })
    vi.spyOn(baseChunkedReq, "clone").mockReturnValue({
      body: chunkedStream,
    } as unknown as Request)
    await hookCallbacks[1](
      steeredEvent({
        model: { providerID: "openai", id: "gpt-5", variant: "xhigh" },
        request: baseChunkedReq,
      }),
    )
    expect(cancelCalled).toBe(true)
    expect(state.applied.get(baseChunkedReq)).toEqual({ order: null, effort: "xhigh" })

    // Unmocked multi-chunk ReadableStream-backed Request (4 × 100 KiB = 400 KiB)
    // exercises real Request.clone() / ReadableStream.tee() without deadlocking on
    // cancelPromise and keeps the original 400 KiB stream readable downstream.
    let realPulls = 0
    const realMultiChunkStream = new ReadableStream<Uint8Array>({
      pull(controller) {
        realPulls++
        if (realPulls <= 4) controller.enqueue(chunk)
        else controller.close()
      },
    })
    const realChunkedReq = new Request(REQUEST_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: realMultiChunkStream,
      duplex: "half",
    } as RequestInit)
    await hookCallbacks[1](
      steeredEvent({
        model: { providerID: "openai", id: "gpt-5", variant: "xhigh" },
        request: realChunkedReq,
      }),
    )
    expect(state.applied.get(realChunkedReq)).toEqual({ order: null, effort: "xhigh" })
    expect((await realChunkedReq.arrayBuffer()).byteLength).toBe(400 * 1024)

    // Bodyless request falls back to #variant without cloning.
    const bodylessReq = new Request(REQUEST_URL)
    const bodylessClone = vi.spyOn(bodylessReq, "clone")
    await hookCallbacks[1](
      steeredEvent({
        model: { providerID: "openai", id: "gpt-5", variant: "low" },
        request: bodylessReq,
      }),
    )
    expect(bodylessClone).not.toHaveBeenCalled()
    expect(state.applied.get(bodylessReq)).toEqual({ order: null, effort: "low" })

    // Non-alias auxiliary request (kind: "title") does not clone body.
    const titleReq = new Request(REQUEST_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reasoning: { effort: "max" } }),
    })
    const titleClone = vi.spyOn(titleReq, "clone")
    await hookCallbacks[1](
      steeredEvent({
        kind: "title",
        model: { providerID: "openai", id: "gpt-5-mini", variant: "minimal" },
        request: titleReq,
      }),
    )
    expect(titleClone).not.toHaveBeenCalled()
    expect(state.applied.get(titleReq)).toEqual({ order: null, effort: "minimal" })

    // Primitive / null event.request on an error path never throws TypeError out of catch.
    await expect(
      hookCallbacks[1](steeredEvent({ request: null as unknown })),
    ).resolves.toBeUndefined()
    await expect(
      hookCallbacks[1](steeredEvent({ request: "not-an-object" as unknown })),
    ).resolves.toBeUndefined()
  })

  test("a non-alias request with no steering data emits nothing (the gate stays alias-scoped)", async () => {
    const harness = makeCtx()
    await wire(harness.ctx, deps(vi.fn(), fakeTimers()))
    await drain()

    const event = steeredEvent({ model: { providerID: "openrouter", id: "z-ai/glm-5.3-flash" } })
    await harness.hookCallbacks[1](event)
    expect(harness.rpcEmit).not.toHaveBeenCalled()
  })

  // NEW-2 (the blindness that hid F1): every event name the plugin emits
  // must be declared in the REAL ModelCompare.events map — the host fails
  // emits of undeclared names ("Unknown RPC event"). The makeCtx emit fake
  // validates the same way; this test pins the invariant explicitly over
  // both emit sites (the Q2 cannot-steer fallback and the command's report).
  test("every event name the plugin emits is declared in ModelCompare.events", async () => {
    const harness = makeCtx()
    harness.raw.options = { fallback: "openrouter/zeta/fallback" }
    harness.raw.model.list.mockReturnValue({
      location: {},
      data: [{ id: "zeta/fallback", providerID: "openrouter", enabled: true }],
    })
    await wire(harness.ctx, deps(vi.fn(), fakeTimers()))
    await drain()

    await harness.hookCallbacks[1](steeredEvent())
    const command = harness.commands.find((c) => c.name === "model-compare")!
    await command.execute({ sessionID: "s1", prompt: { text: "" } })

    const names = harness.rpcEmit.mock.calls.map((call) => call[0] as string)
    expect(names).toContain("cannotSteer")
    expect(names).toContain("report")
    for (const name of names) {
      expect(Object.hasOwn(ModelCompare.events, name), `undeclared RPC event: ${name}`).toBe(true)
    }
  })
})

// ---- response capture hook -------------------------------------------------

describe("response capture hook", () => {
  // The SSE shape the spike observed: chunk 0 may be a COMMENT line (warmup-B
  // saw `: OPENROUTER PROCESSING`) before the first `data:` chunk — the peek
  // must tolerate leading comment/blank lines before concluding anything.
  // The data chunk carries the served `provider` (a DISPLAY name or a tagged
  // slug) and the concrete `model`, plus multi-byte content proving the
  // bytes are forwarded byte-for-byte.
  const COMMENT = ": OPENROUTER PROCESSING\n\n"
  const DATA =
    'data: {"id":"gen-1","provider":"streamlake/fp8","model":"moonshotai/kimi-k3.1-fp8","choices":[{"delta":{"content":"héllo 🌍"}}]}\n\n'
  const SSE_BODY = COMMENT + DATA
  const REQUEST_URL = "https://openrouter.ai/api/v1/chat/completions"

  // Must match src/index.ts's peek bound: the padded provider in the
  // beyond-the-window test sits past it.
  const PEEK_MAX_BYTES = 4096

  // wire() with the steered catalog seeded (the price pick resolves to the
  // steered model) and the live WireState handle from the onState seam. The
  // response capture hook is the THIRD registration ([2], after the guard's
  // [0] and the steering injection's [1]).
  async function wired() {
    const harness = makeCtx()
    let state!: WireState
    await writeCachedDoc(harness.ctx.storage, localIdentity(null), {
      doc: STEERED_DOC,
      acquiredAt: NOW,
    })
    await seedPin(harness.ctx.storage, STEERED_DOC, "price", { v: 1, id: "acme/alpha", since: NOW })
    // A gated acquire parks the background first refresh forever: its failure
    // path would otherwise log a console.error (noise for the tests below
    // that assert the hook's error swallowing), and a resolving acquire would
    // overwrite the seeded steered state. The gate is never released.
    let release!: (value: Acquired) => void
    const gate = new Promise<Acquired>((resolve) => {
      release = resolve
    })
    const acquire = vi.fn(async () => gate)
    await wire(harness.ctx, {
      ...deps(acquire, fakeTimers()),
      onState: (s) => {
        state = s
      },
    })
    await drain()
    expect(harness.hookCallbacks).toHaveLength(3)
    return { ...harness, state: () => state }
  }

  // A Response whose body streams the given text chunks, then ends.
  function streamResponse(chunks: string[]): Response {
    const encoder = new TextEncoder()
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
        controller.close()
      },
    })
    return new Response(stream, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    })
  }

  function responseEvent(opts: {
    response: Response
    sessionID?: string
    kind?: string
    model?: ModelRef
    request?: unknown
  }): HookEvent {
    return {
      sessionID: opts.sessionID ?? "s1",
      agent: "build",
      model: opts.model ?? { providerID: "openrouter", id: "model-compare/price" },
      kind: opts.kind ?? "primary",
      request: opts.request ?? new Request(REQUEST_URL),
      response: opts.response,
    }
  }

  // Fires the steering injection hook for s1 and returns the final (re-created)
  // Request object so responseEvent can pass the correlated Request into
  // http.response, matching the live OpenCode SDK contract.
  async function injectForS1(
    hookCallbacks: Array<(event: HookEvent) => Promise<void>>,
    sessionID = "s1",
  ): Promise<Request> {
    const reqEvent: HookEvent = {
      sessionID,
      agent: "build",
      model: { providerID: "openrouter", id: "model-compare/price" },
      kind: "primary",
      request: new Request(REQUEST_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "acme/alpha",
          messages: [{ role: "user", content: "hi" }],
          stream: true,
        }),
      }),
    }
    await hookCallbacks[1](reqEvent)
    return reqEvent.request as Request
  }

  test("an SSE response writes a placeholder and upgrades provider and model while forwarding bytes byte-for-byte", async () => {
    const { hookCallbacks, state } = await wired()
    const event = responseEvent({
      response: streamResponse([COMMENT, DATA]),
      model: { providerID: "openrouter", id: "model-compare/price", variant: "medium" },
    })
    const original = event.response as Response

    await hookCallbacks[2](event)

    // Before the stream is consumed, the synchronous placeholder is already present
    // (with seq: 1, never NaN, and variant fallback when the Request wasn't in WeakMap).
    expect(state().replySeq.s1).toBe(1)
    expect(state().lastReplies.s1).toEqual({
      sessionID: "s1",
      providerID: "openrouter",
      requestedModel: "model-compare/price",
      at: NOW,
      seq: 1,
      servedModel: null,
      endpoint: null,
      steering: "unknown",
      requestedEffort: "medium",
    })

    const wrapped = event.response as Response
    expect(wrapped).not.toBe(original)
    await expect(wrapped.text()).resolves.toBe(SSE_BODY)

    // Uncorrelated request → order is absent → steering stays "unknown".
    expect(state().lastReplies).toEqual({
      s1: {
        sessionID: "s1",
        providerID: "openrouter",
        requestedModel: "model-compare/price",
        at: NOW,
        seq: 1,
        servedModel: "moonshotai/kimi-k3.1-fp8",
        endpoint: "streamlake/fp8",
        steering: "unknown",
        requestedEffort: "medium",
      },
    })
  })

  test("the order on the request's own WeakMap entry drives the steering verdict (including concurrent same-session requests)", async () => {
    const { hookCallbacks, state } = await wired()
    const steeredReq = await injectForS1(hookCallbacks)

    // A concurrent non-alias request in the SAME session runs BEFORE the
    // steered response arrives; WeakMap correlation keeps steeredReq's order intact.
    const concurrentEvent: HookEvent = {
      sessionID: "s1",
      agent: "title",
      model: { providerID: "openrouter", id: "xiaomi/mimo-v2.6-flash" },
      kind: "title",
      request: new Request(REQUEST_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "xiaomi/mimo-v2.6-flash", messages: [] }),
      }),
    }
    await hookCallbacks[1](concurrentEvent)

    const event = responseEvent({ request: steeredReq, response: streamResponse([DATA]) })
    await hookCallbacks[2](event)
    await (event.response as Response).text()

    // streamlake/fp8 matches none of ["novita/fp8", "deepinfra/fp8"] → "not-in-order".
    expect(state().lastReplies.s1).toEqual({
      sessionID: "s1",
      providerID: "openrouter",
      requestedModel: "model-compare/price",
      at: NOW,
      seq: 1,
      servedModel: "moonshotai/kimi-k3.1-fp8",
      endpoint: "streamlake/fp8",
      steering: "not-in-order",
      requestedEffort: "high",
    })
  })

  test("two sessions' captures do not clobber each other (per-event sessionID)", async () => {
    const { hookCallbacks, state } = await wired()
    const e1 = responseEvent({ response: streamResponse([DATA]) })
    await hookCallbacks[2](e1)
    await (e1.response as Response).text()

    const MOONSHOT =
      'data: {"id":"gen-2","provider":"Moonshot AI","model":"moonshotai/kimi-k3.1-fp8","choices":[]}\n\n'
    const e2 = responseEvent({ response: streamResponse([MOONSHOT]), sessionID: "s2" })
    await hookCallbacks[2](e2)
    await (e2.response as Response).text()

    expect(Object.keys(state().lastReplies).sort()).toEqual(["s1", "s2"])
    expect(state().lastReplies.s1.endpoint).toBe("streamlake/fp8")
    expect(state().lastReplies.s2.endpoint).toBe("Moonshot AI")
    expect(state().lastReplies.s2.sessionID).toBe("s2")
  })

  test("a slow older stream cannot overwrite a newer reply in the same session (seq guard)", async () => {
    const { hookCallbacks, state } = await wired()

    let pushSlow!: (chunk: string) => void
    let closeSlow!: () => void
    const encoder = new TextEncoder()
    const slowStream = new ReadableStream<Uint8Array>({
      start(controller) {
        pushSlow = (chunk: string) => controller.enqueue(encoder.encode(chunk))
        closeSlow = () => controller.close()
      },
    })
    const e1 = responseEvent({
      response: new Response(slowStream, { status: 200, headers: { "content-type": "text/event-stream" } }),
    })
    await hookCallbacks[2](e1)
    expect(state().lastReplies.s1.seq).toBe(1)

    // Newer reply arrives and completes first (seq = 2).
    const DEEPINFRA =
      'data: {"id":"gen-3","provider":"DeepInfra","model":"acme/alpha","choices":[]}\n\n'
    const e2 = responseEvent({ response: streamResponse([DEEPINFRA]) })
    await hookCallbacks[2](e2)
    await (e2.response as Response).text()
    expect(state().lastReplies.s1.seq).toBe(2)
    expect(state().lastReplies.s1.endpoint).toBe("DeepInfra")

    // Older stream now emits its chunk and closes: seq 1 !== 2, so DeepInfra stands.
    const slowRead = (e1.response as Response).text()
    pushSlow(DATA)
    closeSlow()
    await slowRead
    expect(state().lastReplies.s1.seq).toBe(2)
    expect(state().lastReplies.s1.endpoint).toBe("DeepInfra")
    expect(state().lastReplies.s1.servedModel).toBe("acme/alpha")
  })

  test("a response whose body never parses overwrites any prior record with placeholder nulls (and passes through byte-for-byte)", async () => {
    const { hookCallbacks, state } = await wired()
    // Seed an older reply first so we prove the unreadable reply overwrites it rather than leaving stale data.
    const seed = responseEvent({ response: streamResponse([DATA]) })
    await hookCallbacks[2](seed)
    await (seed.response as Response).text()
    expect(state().lastReplies.s1.endpoint).toBe("streamlake/fp8")

    const GARBAGE = "\u0000\u0001not json at all\n\x7f\x00"
    const event = responseEvent({
      response: streamResponse([GARBAGE]),
      model: { providerID: "openrouter", id: "acme/direct" },
    })

    await hookCallbacks[2](event)
    await expect((event.response as Response).text()).resolves.toBe(GARBAGE)
    expect(state().lastReplies.s1).toEqual({
      sessionID: "s1",
      providerID: "openrouter",
      requestedModel: "acme/direct",
      at: NOW,
      seq: 2,
      servedModel: null,
      endpoint: null,
      steering: "unknown",
      requestedEffort: null,
    })
    expect(errorSpy).not.toHaveBeenCalled()
  })

  test("a JSON body whose provider lies beyond the 4 KB peek window keeps the placeholder (endpoint: null) and passes through untouched", async () => {
    const { hookCallbacks, state } = await wired()
    const pad = "x".repeat(PEEK_MAX_BYTES + 100)
    const BODY = `{"id":"x","pad":"${pad}","provider":"Novita","model":"moonshotai/kimi-k3.1-fp8"}`
    const event = responseEvent({ response: streamResponse([BODY]) })

    await hookCallbacks[2](event)
    await expect((event.response as Response).text()).resolves.toBe(BODY)
    expect(state().lastReplies.s1.endpoint).toBeNull()
    expect(state().lastReplies.s1.servedModel).toBeNull()
    expect(state().lastReplies.s1.steering).toBe("unknown")
    expect(errorSpy).not.toHaveBeenCalled()
  })

  test("a non-primary response or non-2xx primary error response is not wrapped and leaves the previous record intact", async () => {
    const { hookCallbacks, state } = await wired()
    const compaction = responseEvent({ response: streamResponse([DATA]), kind: "compaction" })
    const originalCompaction = compaction.response
    await hookCallbacks[2](compaction)
    expect(compaction.response).toBe(originalCompaction)
    expect(state().lastReplies).toEqual({})

    // Record a real 200 reply first.
    const okEvent = responseEvent({ response: streamResponse([DATA]) })
    await hookCallbacks[2](okEvent)
    await (okEvent.response as Response).text()
    expect(state().lastReplies.s1.endpoint).toBe("streamlake/fp8")

    // A 429 error response must NOT overwrite the real reply.
    const errResp = new Response('{"error":"rate_limited"}', { status: 429 })
    const errEvent = responseEvent({
      response: errResp,
      model: { providerID: "anthropic", id: "claude-sonnet-4-5" },
    })
    await hookCallbacks[2](errEvent)
    expect(errEvent.response).toBe(errResp)
    expect(state().lastReplies.s1.providerID).toBe("openrouter")
    expect(state().lastReplies.s1.endpoint).toBe("streamlake/fp8")
  })

  test("non-alias primary responses across OpenAI Chat (>4 KB), OpenAI Responses, Anthropic (split-chunk >4 KB), Gemini, and plain JSON upgrade servedModel and overwrite prior alias replies", async () => {
    const { hookCallbacks, rpcHandlers, state } = await wired()

    // Start with a steered OpenRouter alias reply on Novita (in-order).
    const steeredReq = await injectForS1(hookCallbacks)
    const NOVITA =
      'data: {"id":"gen-1","provider":"Novita","model":"acme/alpha","choices":[]}\n\n'
    const aliasResp = responseEvent({ request: steeredReq, response: streamResponse([NOVITA]) })
    await hookCallbacks[2](aliasResp)
    await (aliasResp.response as Response).text()
    expect(state().lastReplies.s1.steering).toBe("in-order")
    expect(state().lastReplies.s1.endpoint).toBe("Novita")

    // 1. Switch session to Anthropic direct pick with split-chunk message_start + >4 KB content deltas (no [DONE]).
    const anthropicReqEvent: HookEvent = {
      sessionID: "s1",
      agent: "build",
      model: { providerID: "anthropic", id: "claude-sonnet", variant: "low" },
      kind: "primary",
      request: new Request("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet",
          output_config: { effort: "high" },
          messages: [{ role: "user", content: "hi" }],
        }),
      }),
    }
    await hookCallbacks[1](anthropicReqEvent)
    const split1 = 'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1",'
    const split2 = '"model":"claude-sonnet-4-5-20250929"}}\n\n'
    const bigDeltas = `data: {"type":"content_block_delta","delta":{"text":"${"a".repeat(PEEK_MAX_BYTES)}"}}\n\n`
    const anthropicResp = responseEvent({
      request: anthropicReqEvent.request,
      model: { providerID: "anthropic", id: "claude-sonnet", variant: "low" },
      response: streamResponse([split1, split2, bigDeltas]),
    })
    await hookCallbacks[2](anthropicResp)
    await expect((anthropicResp.response as Response).text()).resolves.toBe(
      split1 + split2 + bigDeltas,
    )
    expect(state().lastReplies.s1).toEqual({
      sessionID: "s1",
      providerID: "anthropic",
      requestedModel: "claude-sonnet",
      at: NOW,
      seq: 2,
      servedModel: "claude-sonnet-4-5-20250929",
      endpoint: null,
      steering: "unknown",
      requestedEffort: "high",
    })
    // Report RPC clears quantization and surfaces Anthropic effort as unknown relation.
    const anthropicReport = (await rpcHandlers.report({ sessionID: "s1" })) as {
      capture: unknown
      endpointInfo: unknown
    }
    expect(anthropicReport.capture).toEqual({
      provider: "anthropic",
      endpoint: null,
      model: "claude-sonnet-4-5-20250929",
      steering: "unknown",
    })
    expect(anthropicReport.endpointInfo).toEqual({
      quantization: null,
      effort: { value: "high", relation: "unknown", default: null },
    })

    // 2. OpenAI Chat SSE >4 KB (no [DONE] within peek window, no provider).
    const oaiHead = 'data: {"id":"chatcmpl-1","model":"gpt-5-2026-08","choices":[{"delta":{"content":"hi"}}]}\n\n'
    const oaiTail = `data: {"id":"chatcmpl-1","choices":[{"delta":{"content":"${"b".repeat(PEEK_MAX_BYTES)}"}}]}\n\ndata: [DONE]\n\n`
    const oaiChat = responseEvent({
      model: { providerID: "openai", id: "gpt-5" },
      response: streamResponse([oaiHead, oaiTail]),
    })
    await hookCallbacks[2](oaiChat)
    await (oaiChat.response as Response).text()
    expect(state().lastReplies.s1.servedModel).toBe("gpt-5-2026-08")
    expect(state().lastReplies.s1.endpoint).toBeNull()

    // 3. OpenAI Responses SSE (`response.model`).
    const oaiResponses = responseEvent({
      model: { providerID: "openai", id: "gpt-5" },
      response: streamResponse([
        'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_1","model":"gpt-5.1-codex"}}\n\n',
      ]),
    })
    await hookCallbacks[2](oaiResponses)
    await (oaiResponses.response as Response).text()
    expect(state().lastReplies.s1.servedModel).toBe("gpt-5.1-codex")

    // 4. Google Gemini SSE (`modelVersion`).
    const gemini = responseEvent({
      model: { providerID: "google", id: "gemini-2.5-pro" },
      response: streamResponse([
        'data: {"candidates":[{"content":{"parts":[{"text":"pong"}]}}],"modelVersion":"gemini-2.5-pro-002"}\n\n',
      ]),
    })
    await hookCallbacks[2](gemini)
    await (gemini.response as Response).text()
    expect(state().lastReplies.s1.servedModel).toBe("gemini-2.5-pro-002")

    // 5. Plain JSON without `provider` still upgrades `servedModel` (control-only strings ignored).
    const plainJson = responseEvent({
      model: { providerID: "openai", id: "gpt-5" },
      response: new Response(JSON.stringify({ id: "resp_2", provider: "\u0000 ", model: "gpt-5-json" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    })
    await hookCallbacks[2](plainJson)
    await (plainJson.response as Response).text()
    expect(state().lastReplies.s1.servedModel).toBe("gpt-5-json")
    expect(state().lastReplies.s1.endpoint).toBeNull()
  })

  test("a 2xx response whose body getter throws or is null records the placeholder and leaves event.response untouched", async () => {
    const { hookCallbacks, state } = await wired()
    const broken = {
      ok: true,
      get body(): ReadableStream<Uint8Array> | null {
        throw new Error("boom")
      },
    } as unknown as Response
    const event = responseEvent({
      response: broken,
      model: { providerID: "openai", id: "gpt-5", variant: "low" },
    })

    await expect(hookCallbacks[2](event)).resolves.toBeUndefined()
    expect(event.response).toBe(broken)
    expect(state().lastReplies.s1.requestedModel).toBe("gpt-5")
    expect(state().lastReplies.s1.endpoint).toBeNull()
    expect(state().lastReplies.s1.requestedEffort).toBe("low")

    const empty = new Response(null, { status: 200 })
    const event2 = responseEvent({
      response: empty,
      model: { providerID: "anthropic", id: "claude-opus-4-1" },
    })
    await hookCallbacks[2](event2)
    expect(event2.response).toBe(empty)
    expect(state().lastReplies.s1.providerID).toBe("anthropic")
    expect(state().lastReplies.s1.requestedModel).toBe("claude-opus-4-1")
  })

  test("a leading data line with model and no provider preserves chunk 1's model when chunk 2 supplies only provider", async () => {
    const { hookCallbacks, state } = await wired()
    const CHUNK1 = 'data: {"id":"gen-0","model":"moonshotai/kimi-k3.1-fp8","choices":[{"delta":{}}]}\n\n'
    const CHUNK2 = 'data: {"id":"gen-0","provider":"streamlake/fp8","choices":[{"delta":{}}]}\n\n'
    const event = responseEvent({ response: streamResponse([CHUNK1, CHUNK2]) })

    await hookCallbacks[2](event)
    await expect((event.response as Response).text()).resolves.toBe(CHUNK1 + CHUNK2)
    expect(state().lastReplies.s1.endpoint).toBe("streamlake/fp8")
    expect(state().lastReplies.s1.servedModel).toBe("moonshotai/kimi-k3.1-fp8")
  })

  // ---- the capture's report-footer hand-off (F4/NEW-2) ----------------------

  test("the capture flows into the report RPC's footer fields and text for its own session", async () => {
    const { hookCallbacks, rpcHandlers, state } = await wired()
    const event = responseEvent({ response: streamResponse([DATA]) })
    await hookCallbacks[2](event)
    await (event.response as Response).text()
    expect(state().lastReplies.s1.endpoint).toBe("streamlake/fp8")

    const report = (await rpcHandlers.report({ sessionID: "s1" })) as {
      text: string
      capture: unknown
      steeringNote: string | null
    }
    expect(report.capture).toEqual({
      provider: "openrouter",
      endpoint: "streamlake/fp8",
      model: "moonshotai/kimi-k3.1-fp8",
      steering: "unknown",
    })
    expect(report.steeringNote).toBe("routing steered to fp8 endpoints (aliases only)")
    expect(report.text).toContain(
      "last response: moonshotai/kimi-k3.1-fp8 @ streamlake/fp8 (provider: openrouter)",
    )
  })

  test("reportFooter gates catalog lookup on providerID === 'openrouter', falls back to direct requestedModel, and surfaces effort when sourced === null", async () => {
    const { hookCallbacks, rpcHandlers } = await wired()

    // 1. Non-OpenRouter provider ("together") with servedModel === "acme/alpha" and endpoint === "Novita"
    // must NOT match OpenRouter's catalog entry for acme/alpha.
    const foreignEvent = responseEvent({
      model: { providerID: "together", id: "acme/alpha", variant: "max" },
      response: streamResponse([
        'data: {"id":"1","provider":"Novita","model":"acme/alpha","choices":[]}\n\n',
      ]),
    })
    await hookCallbacks[2](foreignEvent)
    await (foreignEvent.response as Response).text()
    const foreignReport = (await rpcHandlers.report({ sessionID: "s1" })) as {
      endpointInfo: unknown
    }
    expect(foreignReport.endpointInfo).toEqual({
      quantization: null,
      effort: { value: "max", relation: "unknown", default: null },
    })

    // 2. Direct OpenRouter pick (`providerID: "openrouter"`, non-alias `acme/alpha`) with
    // `servedModel: null` and `endpoint: null` resolves `acme/alpha` via requestedModel fallback!
    const directEmpty = responseEvent({
      model: { providerID: "openrouter", id: "acme/alpha", variant: "max" },
      response: new Response(null, { status: 200 }),
    })
    await hookCallbacks[2](directEmpty)
    const directReport = (await rpcHandlers.report({ sessionID: "s1" })) as {
      endpointInfo: unknown
    }
    expect(directReport.endpointInfo).toEqual({
      quantization: null,
      effort: { value: "max", relation: "above-default", default: "high" },
    })

    // 3. Offline (`state.sourced === null`): effort still surfaces in reportFooter!
    const coldHarness = makeCtx()
    await wire(coldHarness.ctx, deps(vi.fn(), fakeTimers()))
    await drain()
    await coldHarness.hookCallbacks[2](
      responseEvent({
        model: { providerID: "anthropic", id: "claude-sonnet-4-5", variant: "high" },
        response: new Response(null, { status: 200 }),
      }),
    )
    const coldReport = (await coldHarness.rpcHandlers.report({ sessionID: "s1" })) as {
      capture: unknown
      endpointInfo: unknown
    }
    expect(coldReport.capture).toEqual({
      provider: "anthropic",
      endpoint: null,
      model: "claude-sonnet-4-5",
      steering: "unknown",
    })
    expect(coldReport.endpointInfo).toEqual({
      quantization: null,
      effort: { value: "high", relation: "unknown", default: null },
    })
  })

  test("the report RPC derives the served endpoint's quantization and effort", async () => {
    const { hookCallbacks, rpcHandlers } = await wired()
    const steeredReq = await injectForS1(hookCallbacks)
    const DEEPINFRA =
      'data: {"id":"gen-3","provider":"DeepInfra","model":"acme/alpha","choices":[]}\n\n'
    const event = responseEvent({ request: steeredReq, response: streamResponse([DEEPINFRA]) })
    await hookCallbacks[2](event)
    await (event.response as Response).text()

    const report = (await rpcHandlers.report({ sessionID: "s1" })) as {
      endpointInfo: unknown
    }
    expect(report.endpointInfo).toEqual({
      quantization: { value: "fp8", relation: "default", default: "fp8" },
      effort: { value: "high", relation: "default", default: "high" },
    })
  })

  test("the report RPC marks a sub-default endpoint quantization", async () => {
    const { hookCallbacks, rpcHandlers } = await wired()
    const steeredReq = await injectForS1(hookCallbacks)
    const OPENINFERENCE =
      'data: {"id":"gen-4","provider":"OpenInference","model":"acme/alpha","choices":[]}\n\n'
    const event = responseEvent({ request: steeredReq, response: streamResponse([OPENINFERENCE]) })
    await hookCallbacks[2](event)
    await (event.response as Response).text()

    const report = (await rpcHandlers.report({ sessionID: "s1" })) as {
      endpointInfo: unknown
    }
    expect(report.endpointInfo).toEqual({
      quantization: { value: "fp4", relation: "sub-default", default: "fp8" },
      effort: { value: "high", relation: "default", default: "high" },
    })
  })

  test("the report RPC with prototype-key sessionIDs returns capture null and never throws, and prototype sessionIDs can write safely", async () => {
    const { hookCallbacks, rpcHandlers } = await wired()
    const event = responseEvent({ response: streamResponse([DATA]) })
    await hookCallbacks[2](event)
    await (event.response as Response).text()

    for (const sessionID of ["constructor", "toString", "__proto__"]) {
      const report = (await rpcHandlers.report({ sessionID })) as { capture: unknown }
      expect(report.capture, sessionID).toBeNull()
    }
    // Writing a reply under "__proto__" increments seq from 0 -> 1 cleanly (null-prototype replySeq).
    const protoEvent = responseEvent({ sessionID: "__proto__", response: streamResponse([DATA]) })
    await hookCallbacks[2](protoEvent)
    await (protoEvent.response as Response).text()
    const protoReport = (await rpcHandlers.report({ sessionID: "__proto__" })) as {
      capture: { endpoint: string | null } | null
    }
    expect(protoReport.capture?.endpoint).toBe("streamlake/fp8")

    const real = (await rpcHandlers.report({ sessionID: "s1" })) as { capture: unknown }
    expect(real.capture).not.toBeNull()
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

  test("/use-best emits the useBest event for the TUI's immediate toast", async () => {
    const { ctx, commands, rpcEmit } = makeCtx()
    await seedDocCache(ctx.storage)
    for (const p of PRIORITIES) {
      await seedPin(ctx.storage, DOC, p, { v: 1, id: "acme/alpha", since: NOW })
    }
    await wire(ctx, deps(vi.fn(), fakeTimers()))

    const useBest = commands.find((c) => c.name === "use-best")!
    await useBest.execute({ sessionID: "s2", prompt: { text: "price" } })

    expect(rpcEmit).toHaveBeenCalledWith("useBest", {
      sessionID: "s2",
      message: "model-compare: switched to openrouter/model-compare/price (currently acme/alpha)",
      ok: true,
    })
  })

  test("/use-best emits the useBest event on a disabled-alias refusal", async () => {
    const { ctx, commands, rpcEmit } = makeCtx()
    await wire(ctx, deps(vi.fn(), fakeTimers()))

    const useBest = commands.find((c) => c.name === "use-best")!
    await useBest.execute({ sessionID: "s1", prompt: { text: "" } })

    expect(rpcEmit).toHaveBeenCalledWith("useBest", {
      sessionID: "s1",
      message:
        "model-compare: openrouter/model-compare/balanced is currently disabled (no ranking data); not switching",
      ok: false,
    })
  })

  test("/use-best emits the useBest event on an unknown-priority refusal", async () => {
    const { ctx, commands, rpcEmit } = makeCtx()
    await wire(ctx, deps(vi.fn(), fakeTimers()))

    const useBest = commands.find((c) => c.name === "use-best")!
    await useBest.execute({ sessionID: "s1", prompt: { text: "fastest" } })

    expect(rpcEmit).toHaveBeenCalledWith("useBest", {
      sessionID: "s1",
      message: expect.stringContaining('unknown priority "fastest"'),
      ok: false,
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
    // The event schema has additionalProperties: false and no endpointInfo;
    // the no-data branch must not leak the reportFooter's endpointInfo.
    expect(data).not.toHaveProperty("endpointInfo")
  })
})

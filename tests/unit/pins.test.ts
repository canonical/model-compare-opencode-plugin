// tests/unit/pins.test.ts
// Pin rules and the resolution chain (design §7, §9) plus the versioned
// storage record helpers. `resolve` is pure: runnability, the stored pin, and
// the clock all arrive as inputs, so every rule is tested without I/O.
import type { ModelEntry, Weights } from "../../src/core/types"
import { fnv1aHex, pinKey, resolve, type Pin, type ResolveInput, type ResolveResult } from "../../src/core/pins"
import {
  docCacheKey,
  localIdentity,
  readRecord,
  remoteIdentity,
  writeRecord,
  type Storage,
} from "../../src/opencode/storage"

const NOW = 1_000_000_000_000
const DAY = 86_400_000
const PIN_DAYS = 7

// Published balanced weights {quality: 1, …zeros} make overallScore equal the
// model's scores.quality, so lead arithmetic in the tests stays obvious.
const QUALITY_ONLY: Partial<Weights> = { quality: 1, price: 0, context: 0, age: 0 }

function entry(id: string, quality: number): ModelEntry {
  return {
    id,
    name: id,
    pricing: { blended_per_1m: 1 },
    context: 128000,
    quality: null,
    qualityEffort: null,
    scores: {
      quality,
      price: 0.5,
      context: 0.5,
      age: 0.5,
      overall: { balanced: quality, price: quality, quality },
    },
  }
}

function catalog(models: ModelEntry[], ranking: string[], weights: Partial<Weights> = QUALITY_ONLY) {
  return {
    generatedAt: "2026-10-09T00:00:00+00:00",
    weights: { balanced: weights },
    rankings: { balanced: ranking },
    models,
  }
}

function pin(id: string, since: number): Pin {
  return { v: 1, id, since }
}

function resolveOver(overrides: Partial<ResolveInput>): ResolveResult {
  return resolve({
    catalog: null,
    p: "balanced",
    runnable: () => true,
    fallback: null,
    stored: null,
    now: NOW,
    pinDays: PIN_DAYS,
    minLead: 0.05,
    ...overrides,
  })
}

describe("resolve — fresh catalog", () => {
  test("first adoption: no stored pin adopts the best candidate with since = now", () => {
    const r = resolveOver({
      catalog: catalog([entry("a/best", 0.9), entry("a/worse", 0.4)], ["a/best", "a/worse"]),
    })
    expect(r.targetId).toBe("a/best")
    expect(r.source).toBe("pick")
    expect(r.pin).toEqual({ v: 1, id: "a/best", since: NOW })
    expect(r.notices).toEqual([])
  })

  test("walks the ranked order and adopts the first runnable candidate", () => {
    const r = resolveOver({
      catalog: catalog([entry("a/blocked", 0.9), entry("a/next", 0.4)], ["a/blocked", "a/next"]),
      runnable: (id) => id !== "a/blocked",
    })
    expect(r.targetId).toBe("a/next")
    expect(r.source).toBe("pick")
    expect(r.pin).toEqual({ v: 1, id: "a/next", since: NOW })
  })

  test("keeps the pin when the challenger leads by less than minLead", () => {
    const stored = pin("a/pin", NOW - 1000)
    const r = resolveOver({
      catalog: catalog([entry("a/pin", 0.5), entry("a/rival", 0.55)], ["a/rival", "a/pin"]),
      stored,
      minLead: 0.1, // lead is 0.05 — under the bar
    })
    expect(r.targetId).toBe("a/pin")
    expect(r.source).toBe("pin")
    expect(r.pin).toEqual(stored) // since unchanged
    expect(r.notices).toEqual([])
  })

  test("switches when the challenger leads by at least minLead, resetting since", () => {
    const stored = pin("a/pin", NOW - 1000)
    const r = resolveOver({
      catalog: catalog([entry("a/pin", 0.5), entry("a/rival", 0.65)], ["a/rival", "a/pin"]),
      stored,
      minLead: 0.1, // lead is 0.15 — at/over the bar
    })
    expect(r.targetId).toBe("a/rival")
    expect(r.source).toBe("pick")
    expect(r.pin).toEqual({ v: 1, id: "a/rival", since: NOW })
    expect(r.notices).toEqual(["pin switched: a/pin → a/rival"])
  })

  test("switches when the pin is not runnable, even though the challenger scores lower", () => {
    const stored = pin("a/pin", NOW - 1000)
    const r = resolveOver({
      catalog: catalog([entry("a/pin", 0.9), entry("a/rival", 0.4)], ["a/pin", "a/rival"]),
      stored,
      runnable: (id) => id !== "a/pin",
    })
    // The only runnable candidate scores 0.4 < 0.9, so the switch can only
    // come from the unrunnable-pin rule, not from a score lead.
    expect(r.targetId).toBe("a/rival")
    expect(r.source).toBe("pick")
    expect(r.pin).toEqual({ v: 1, id: "a/rival", since: NOW })
    expect(r.notices).toEqual(["pin switched: a/pin → a/rival"])
  })

  test("a pin exactly pinDays old is not expired and is kept", () => {
    const stored = pin("a/pin", NOW - PIN_DAYS * DAY) // boundary: not strictly older
    const r = resolveOver({
      catalog: catalog([entry("a/pin", 0.5), entry("a/rival", 0.9)], ["a/rival", "a/pin"]),
      stored,
      minLead: 0.5, // lead is 0.4 — only expiry could switch
    })
    expect(r.targetId).toBe("a/pin")
    expect(r.source).toBe("pin")
    expect(r.pin).toEqual(stored)
  })

  test("a pin older than pinDays switches to the best candidate and resets since", () => {
    const stored = pin("a/pin", NOW - PIN_DAYS * DAY - 1)
    const r = resolveOver({
      catalog: catalog([entry("a/pin", 0.5), entry("a/rival", 0.9)], ["a/rival", "a/pin"]),
      stored,
      minLead: 0.9, // lead is 0.4 — only expiry can switch
    })
    expect(r.targetId).toBe("a/rival")
    expect(r.source).toBe("pick")
    expect(r.pin).toEqual({ v: 1, id: "a/rival", since: NOW })
    expect(r.notices).toEqual(["pin switched: a/pin → a/rival"])
  })

  test("expiry re-adopts the pinned model itself and resets since (§7.6)", () => {
    // §7.6: since resets "including when the best candidate after pinDays is
    // the pinned model" — the (re)adoption resets the clock without a
    // switch notice, because the target id is unchanged.
    const stored = pin("a/pin", NOW - PIN_DAYS * DAY - 1)
    const r = resolveOver({
      catalog: catalog([entry("a/pin", 0.5), entry("a/rival", 0.4)], ["a/pin", "a/rival"]),
      stored,
      minLead: 0.9,
    })
    expect(r.targetId).toBe("a/pin")
    expect(r.source).toBe("pin")
    expect(r.pin).toEqual({ v: 1, id: "a/pin", since: NOW })
    expect(r.notices).toEqual([])
  })

  test("no runnable ranked candidate falls back to the stored pin when it is runnable (§9)", () => {
    const stored = pin("a/pin", NOW - 1000) // a/pin left the catalog but is still runnable
    const r = resolveOver({
      catalog: catalog([entry("a/rival", 0.4)], ["a/rival"]),
      stored,
      runnable: (id) => id === "a/pin",
    })
    expect(r.targetId).toBe("a/pin")
    expect(r.source).toBe("pin")
    expect(r.pin).toEqual(stored)
    expect(r.notices).toEqual([])
  })

  test("forwards effectiveWeights warnings as override-ignored notices", () => {
    const cat = catalog([entry("a/best", 0.9)], ["a/best"], { quality: 1, price: 0, context: 0 })
    const r = resolveOver({ catalog: cat, override: { age: 0.5 } })
    // The published balanced weights lack `age`, so the merge ignores the
    // override key with a warning, which resolve forwards verbatim.
    expect(r.targetId).toBe("a/best")
    expect(r.source).toBe("pick")
    expect(r.notices.length).toBe(1)
    expect(r.notices.join(" ")).toMatch(/age weight override/)
  })

  test("nothing runnable with a fresh catalog resolves to none", () => {
    const r = resolveOver({
      catalog: catalog([entry("a/best", 0.9)], ["a/best"]),
      runnable: () => false,
    })
    expect(r.targetId).toBeNull()
    expect(r.source).toBe("none")
    expect(r.pin).toBeNull()
    expect(r.notices).toEqual([])
  })
})

describe("resolve — without a catalog", () => {
  test("uses the stored pin when it is runnable", () => {
    const stored = pin("a/pin", NOW - 1000)
    const r = resolveOver({ catalog: null, stored })
    expect(r.targetId).toBe("a/pin")
    expect(r.source).toBe("pin")
    expect(r.pin).toEqual(stored)
    expect(r.notices).toEqual([])
  })

  test("skips an unrunnable pin and uses the runnable fallback, stripped to its bare id", () => {
    const stored = pin("a/pin", NOW - 1000)
    const r = resolveOver({
      catalog: null,
      stored,
      fallback: "openrouter/a/fallback",
      runnable: (id) => id === "a/fallback",
    })
    expect(r.targetId).toBe("a/fallback") // bare id, prefix stripped
    expect(r.source).toBe("fallback")
    // §7.8: the fallback is never stored as a pin; the existing record stays
    // as last-known-good.
    expect(r.pin).toEqual(stored)
    expect(r.notices).toEqual(["pin skipped: a/pin is not runnable", "fallback used: a/fallback"])
  })

  test("uses a fallback without the openrouter/ prefix as-is", () => {
    const r = resolveOver({
      catalog: null,
      fallback: "anthropic/claude-haiku-5.5",
    })
    expect(r.targetId).toBe("anthropic/claude-haiku-5.5")
    expect(r.source).toBe("fallback")
    expect(r.pin).toBeNull()
    expect(r.notices).toEqual(["fallback used: anthropic/claude-haiku-5.5"])
  })

  test("resolves to none when nothing is runnable", () => {
    const r = resolveOver({
      catalog: null,
      fallback: "openrouter/a/anything",
      runnable: () => false,
    })
    expect(r.targetId).toBeNull()
    expect(r.source).toBe("none")
    expect(r.pin).toBeNull()
    expect(r.notices).toEqual([])
  })

  test("keeps the stored record when nothing is runnable and the pin is unrunnable", () => {
    // §9 skips (not deletes) an unrunnable pin; the stored record remains the
    // pin state after resolution.
    const stored = pin("a/gone", NOW - 1000)
    const r = resolveOver({ catalog: null, stored, runnable: () => false })
    expect(r.targetId).toBeNull()
    expect(r.source).toBe("none")
    expect(r.pin).toEqual(stored)
    expect(r.notices).toEqual(["pin skipped: a/gone is not runnable"])
  })
})

describe("pinKey and fnv1aHex", () => {
  test("fnv1aHex matches the 32-bit FNV-1a test vectors", () => {
    expect(fnv1aHex("")).toBe("811c9dc5")
    expect(fnv1aHex("a")).toBe("e40c292c")
    expect(fnv1aHex("foobar")).toBe("bf9cf968")
  })

  test("pinKey hashes the serialized weights under the priority", () => {
    const w = { quality: 0.4, price: 0.4, context: 0.1, age: 0.1 }
    expect(pinKey("balanced", w)).toBe(`pin/balanced/${fnv1aHex(JSON.stringify(w))}`)
    expect(pinKey("price", w)).toBe(`pin/price/${fnv1aHex(JSON.stringify(w))}`)
    // Different weight configurations must not collide (§7.2).
    expect(pinKey("balanced", { ...w, quality: 0.5 })).not.toBe(pinKey("balanced", w))
  })
})

describe("storage records", () => {
  function memoryStorage(initial: Record<string, unknown> = {}) {
    const map = new Map(Object.entries(initial))
    const calls: Array<{ key: string; value: unknown }> = []
    const storage: Storage = {
      get: async (key) => map.get(key),
      set: async (key, value) => {
        calls.push({ key, value })
        map.set(key, value)
      },
    }
    return { storage, calls, map }
  }

  test("readRecord returns the stored record when v is 1", async () => {
    const { storage } = memoryStorage({ "pin/balanced/x": { v: 1, id: "a/pin", since: 5 } })
    expect(await readRecord(storage, "pin/balanced/x", 1)).toEqual({ v: 1, id: "a/pin", since: 5 })
  })

  test("readRecord returns null on a missing key or a non-object value", async () => {
    const { storage } = memoryStorage({ nullish: null, numeric: 42, text: "x", list: [1, 2] })
    expect(await readRecord(storage, "absent", 1)).toBeNull() // never stored
    expect(await readRecord(storage, "nullish", 1)).toBeNull()
    expect(await readRecord(storage, "numeric", 1)).toBeNull()
    expect(await readRecord(storage, "text", 1)).toBeNull()
    expect(await readRecord(storage, "list", 1)).toBeNull()
  })

  test("readRecord returns null on a record without v or with another version", async () => {
    const { storage } = memoryStorage({
      noVersion: { id: "a/pin", since: 5 },
      wrongVersion: { v: 2, id: "a/pin", since: 5 },
      stringVersion: { v: "1", id: "a/pin", since: 5 },
    })
    expect(await readRecord(storage, "noVersion", 1)).toBeNull()
    expect(await readRecord(storage, "wrongVersion", 1)).toBeNull()
    expect(await readRecord(storage, "stringVersion", 1)).toBeNull()
  })

  test("writeRecord writes the value with its version", async () => {
    const { storage, calls } = memoryStorage()
    const record = { v: 1, id: "a/pin", since: 5 }
    await writeRecord(storage, "pin/balanced/x", record)
    expect(calls).toEqual([{ key: "pin/balanced/x", value: { v: 1, id: "a/pin", since: 5 } }])
    expect(await readRecord(storage, "pin/balanced/x", 1)).toEqual(record)
  })

  test("docCacheKey is doc/cache/<fnv1a(identity)>, distinct per source identity", () => {
    const remote = remoteIdentity("https://a.example/catalog.json")
    expect(docCacheKey(remote)).toBe(`doc/cache/${fnv1aHex(remote)}`)
    expect(docCacheKey(remote)).not.toBe(docCacheKey(remoteIdentity("https://b.example/catalog.json")))
    expect(docCacheKey(localIdentity(null))).not.toBe(docCacheKey(localIdentity("/dev/model_compare.py")))
    expect(docCacheKey(localIdentity(null))).not.toBe(docCacheKey(remote))
  })
})
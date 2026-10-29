// tests/unit/storage.test.ts
// The doc-cache record reader (design §7.9): a corrupt record is a cache
// miss, never an exception and never a stale serve. Covers the non-finite
// acquiredAt shape (JSON.parse("1e999") → Infinity) that would otherwise be
// served as perpetually fresh — the same hand-edited-record vector isValidPin
// defends against (final-review BUG-04).
import { describe, expect, test } from "vitest"
import { validateCatalog } from "../../src/core/catalog"
import type { Pin } from "../../src/core/pins"
import {
  docCacheKey,
  DOC_CACHE_VERSION,
  readCachedDoc,
  readRecord,
  remoteIdentity,
  type Storage,
} from "../../src/opencode/storage"

const IDENTITY = remoteIdentity("https://models.example.com/catalog.json")
const CACHE_KEY = docCacheKey(IDENTITY)

// A minimal schema-valid document (one model, no weights or rankings) — the
// same shape the source tests build.
function doc() {
  return {
    schema_version: 6,
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
}

// The projected catalog shape, exactly what writeCachedDoc persists.
function projectedDoc() {
  const validated = validateCatalog(doc())
  if (!validated.ok) throw new Error(`test document is invalid: ${validated.reason}`)
  return validated.catalog
}

// A Storage whose get always returns the seeded record (the key is asserted
// by construction: readCachedDoc must look up docCacheKey(identity)).
function memoryStorage(record: unknown, seenKeys: string[] = []): Storage {
  return {
    get: async (key) => {
      seenKeys.push(key)
      return record
    },
    set: async () => {},
  }
}

describe("readCachedDoc record validation", () => {
  test("a well-formed record reads back as the cached Sourced under its cache key", async () => {
    const record = { v: 2, source: IDENTITY, doc: projectedDoc(), acquiredAt: 1_000_000_000_000 }
    const seenKeys: string[] = []
    const cached = await readCachedDoc(memoryStorage(record, seenKeys), IDENTITY)
    expect(seenKeys).toEqual([CACHE_KEY])
    expect(cached).toEqual({ doc: projectedDoc(), acquiredAt: 1_000_000_000_000 })
  })

  test("a record with a non-finite acquiredAt (JSON.parse 1e999) is a cache miss", async () => {
    const record = {
      v: 2,
      source: IDENTITY,
      doc: projectedDoc(),
      acquiredAt: JSON.parse("1e999") as number, // Infinity — the isValidPin vector
    }
    const cached = await readCachedDoc(memoryStorage(record), IDENTITY)
    expect(cached).toBeNull()
  })

  test("a v1-era record (the v5-era doc cache) is a cache miss", async () => {
    // Doc-cache records are versioned by CATALOG era: v1 held a schema-v5
    // catalog whose `quality` is the default-effort score; v2 holds the v6
    // best-selectable-depth score. Serving v1 after the upgrade would mix the
    // two semantics, so it must be discarded and re-fetched.
    const record = { v: 1, source: IDENTITY, doc: projectedDoc(), acquiredAt: 1_000_000_000_000 }
    const cached = await readCachedDoc(memoryStorage(record), IDENTITY)
    expect(cached).toBeNull()
  })
})

describe("readRecord version/record type linkage (post-review BUG-03)", () => {
  test("a mismatched version/record pair is a compile error and a runtime cache miss", async () => {
    // Compile-time pin: readRecord's version argument is type-linked to the
    // record's own `v` literal, so reading a Pin record with the doc-cache
    // version is a compile error (before the linkage this line compiled and
    // made typecheck fail with ts2578 — unused @ts-expect-error). The runtime
    // assertion is the second layer: even with the types loosened, the record
    // version gate must still discard the mismatched read.
    const storage = memoryStorage({ "pin/balanced/x": { v: 1, id: "a/pin", since: 5 } })
    // @ts-expect-error the doc-cache version must not read pin records
    expect(await readRecord<Pin>(storage, "pin/balanced/x", DOC_CACHE_VERSION)).toBeNull()
  })
})

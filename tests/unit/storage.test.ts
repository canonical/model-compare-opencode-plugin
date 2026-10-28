// tests/unit/storage.test.ts
// The doc-cache record reader (design §7.9): a corrupt record is a cache
// miss, never an exception and never a stale serve. Covers the non-finite
// acquiredAt shape (JSON.parse("1e999") → Infinity) that would otherwise be
// served as perpetually fresh — the same hand-edited-record vector isValidPin
// defends against (final-review BUG-04).
import { describe, expect, test } from "vitest"
import { validateCatalog } from "../../src/core/catalog"
import {
  docCacheKey,
  readCachedDoc,
  remoteIdentity,
  type Storage,
} from "../../src/opencode/storage"

const IDENTITY = remoteIdentity("https://models.example.com/catalog.json")
const CACHE_KEY = docCacheKey(IDENTITY)

// A minimal schema-valid document (one model, no weights or rankings) — the
// same shape the source tests build.
function doc() {
  return {
    schema_version: 5,
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
    const record = { v: 1, source: IDENTITY, doc: projectedDoc(), acquiredAt: 1_000_000_000_000 }
    const seenKeys: string[] = []
    const cached = await readCachedDoc(memoryStorage(record, seenKeys), IDENTITY)
    expect(seenKeys).toEqual([CACHE_KEY])
    expect(cached).toEqual({ doc: projectedDoc(), acquiredAt: 1_000_000_000_000 })
  })

  test("a record with a non-finite acquiredAt (JSON.parse 1e999) is a cache miss", async () => {
    const record = {
      v: 1,
      source: IDENTITY,
      doc: projectedDoc(),
      acquiredAt: JSON.parse("1e999") as number, // Infinity — the isValidPin vector
    }
    const cached = await readCachedDoc(memoryStorage(record), IDENTITY)
    expect(cached).toBeNull()
  })
})

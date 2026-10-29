// tests/unit/remote-source.test.ts
// The remote catalog source (design §5, §8, §9): a valid fetch is validated,
// persisted as a versioned record, and returned with fromCache: false; a
// record younger than the TTL is served without touching the network; any
// fetch or validation failure falls back to the cached record at any age and
// only rejects when no usable record exists. Every test injects a fake fetch —
// the real URL is never hit.
import { describe, expect, test } from "vitest"
import { validateCatalog } from "../../src/core/catalog"
import {
  docCacheKey,
  remoteIdentity,
  writeCachedDoc,
  type Storage,
} from "../../src/opencode/storage"
import { fetchRemote } from "../../src/sources/remote"

const REMOTE_URL = "https://models.example.com/catalog.json"
const DOC_CACHE_KEY = docCacheKey(remoteIdentity(REMOTE_URL))
const NOW = 1_000_000_000_000
const TTL = 6 * 60 * 60 * 1000

// A minimal schema-valid document (one model, no weights or rankings).
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

// A Map-backed Storage with the structural shape of ctx.storage.
function memoryStorage(initial: Record<string, unknown> = {}) {
  const map = new Map(Object.entries(initial))
  const storage: Storage = {
    get: async (key) => map.get(key),
    set: async (key, value) => {
      map.set(key, value)
    },
  }
  return { storage, map }
}

// Persist a record the way fetchRemote itself writes one: the validated
// catalog plus the acquisition time under { v: 2 } (the v6-catalog doc-cache era).
async function seedCache(storage: Storage, acquiredAt: number, raw = doc()) {
  const validated = validateCatalog(raw)
  if (!validated.ok) throw new Error(`test document is invalid: ${validated.reason}`)
  await writeCachedDoc(storage, remoteIdentity(REMOTE_URL), { doc: validated.catalog, acquiredAt })
  return validated.catalog
}

// A fake fetch serving one static response and counting its calls.
function fetchReturns(body: string, status = 200) {
  let calls = 0
  const impl: typeof fetch = async () => {
    calls++
    return new Response(body, { status })
  }
  return { fetch: impl, calls: () => calls }
}

// A fake fetch that always rejects (a network failure) and counts its calls.
function fetchFails(error: Error) {
  let calls = 0
  const impl: typeof fetch = async () => {
    calls++
    throw error
  }
  return { fetch: impl, calls: () => calls }
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

describe("fetchRemote timeouts (F-01, design §4)", () => {
  // A fetch that never settles on its own and rejects only when the signal
  // it was handed aborts — the contract of the real fetch.
  function hangingFetch() {
    let signal: AbortSignal | null | undefined
    const impl: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        signal = init?.signal
        if (signal == null) return // no signal: hangs forever, like a dead socket
        signal.addEventListener("abort", () => reject(signal!.reason))
      })
    return { fetch: impl, signal: () => signal }
  }

  test("hands fetch an AbortSignal", async () => {
    const { storage } = memoryStorage()
    const seen: Array<AbortSignal | null | undefined> = []
    const impl: typeof fetch = async (_input, init) => {
      seen.push(init?.signal)
      return new Response(JSON.stringify(doc()), { status: 200 })
    }
    await fetchRemote(REMOTE_URL, storage, { fetch: impl, now: () => NOW })
    expect(seen[0]).toBeInstanceOf(AbortSignal)
  })

  test("rejects when the fetch never settles and the timeout aborts it", async () => {
    const { storage } = memoryStorage()
    const hung = hangingFetch()
    const reason = await rejectionOf(
      fetchRemote(REMOTE_URL, storage, { fetch: hung.fetch, now: () => NOW, timeoutMs: 20 }),
    )
    expect(reason).toMatch(/remote source failed/)
    expect(reason).toMatch(/timeout|timed out|abort/i)
    expect(hung.signal()?.aborted).toBe(true)
  })

  test("a timed-out fetch still falls back to a cached record", async () => {
    const { storage } = memoryStorage()
    const staleAt = NOW - 10 * TTL
    const seeded = await seedCache(storage, staleAt)
    const hung = hangingFetch()
    const result = await fetchRemote(REMOTE_URL, storage, {
      fetch: hung.fetch,
      now: () => NOW,
      timeoutMs: 20,
    })
    expect(result).toEqual({ doc: seeded, acquiredAt: staleAt, fromCache: true })
  })
})

describe("fetchRemote document cache identity and validation (F-14, F-16)", () => {
  const OTHER_URL = "https://other.example.com/catalog.json"

  test("a fresh record cached for another URL is a miss: the fetch happens", async () => {
    const { storage } = memoryStorage()
    await seedCache(storage, NOW) // cached for REMOTE_URL, well inside the TTL
    const fresh = doc()
    fresh.generated_at = "2026-10-11T00:00:00+00:00"
    const fetcher = fetchReturns(JSON.stringify(fresh))

    const result = await fetchRemote(OTHER_URL, storage, { fetch: fetcher.fetch, now: () => NOW })

    expect(fetcher.calls()).toBe(1)
    expect(result.fromCache).toBe(false)
    expect(result.doc.generatedAt).toBe("2026-10-11T00:00:00+00:00")
  })

  test("another URL's cached record is not served on failure either", async () => {
    const { storage } = memoryStorage()
    await seedCache(storage, NOW - 10 * TTL)
    const reason = await rejectionOf(
      fetchRemote(OTHER_URL, storage, { fetch: fetchFails(new Error("down")).fetch, now: () => NOW }),
    )
    expect(reason).toMatch(/remote source failed: down/)
  })

  test("records live under per-URL keys and do not overwrite each other", async () => {
    const { storage, map } = memoryStorage()
    await seedCache(storage, NOW)
    await fetchRemote(OTHER_URL, storage, { fetch: fetchReturns(JSON.stringify(doc())).fetch, now: () => NOW })
    expect(map.has(docCacheKey(remoteIdentity(REMOTE_URL)))).toBe(true)
    expect(map.has(docCacheKey(remoteIdentity(OTHER_URL)))).toBe(true)
  })

  test("a cached document that fails validation is a miss: refetched, never thrown from", async () => {
    const { storage, map } = memoryStorage()
    await seedCache(storage, NOW)
    const record = map.get(DOC_CACHE_KEY) as { doc: { models: unknown[] } }
    record.doc.models = [{ id: "acme/broken" }] // scores/pricing/name missing
    const fetcher = fetchReturns(JSON.stringify(doc()))

    const result = await fetchRemote(REMOTE_URL, storage, { fetch: fetcher.fetch, now: () => NOW })

    expect(fetcher.calls()).toBe(1)
    expect(result.fromCache).toBe(false)
    expect(result.doc.models.map((m) => m.id)).toEqual(["acme/mini"])
  })

  test("an invalid cached document with a failing fetch rejects instead of serving garbage", async () => {
    const { storage, map } = memoryStorage()
    await seedCache(storage, NOW)
    ;(map.get(DOC_CACHE_KEY) as { doc: unknown }).doc = { models: "nope" }
    const reason = await rejectionOf(
      fetchRemote(REMOTE_URL, storage, { fetch: fetchFails(new Error("down")).fetch, now: () => NOW }),
    )
    expect(reason).toMatch(/remote source failed/)
  })

  test("a record whose source field names another identity (key collision) is a miss", async () => {
    const { storage, map } = memoryStorage()
    await seedCache(storage, NOW)
    ;(map.get(DOC_CACHE_KEY) as { source: string }).source = remoteIdentity(OTHER_URL)
    const fetcher = fetchReturns(JSON.stringify(doc()))
    await fetchRemote(REMOTE_URL, storage, { fetch: fetcher.fetch, now: () => NOW })
    expect(fetcher.calls()).toBe(1)
  })
})

describe("fetchRemote", () => {
  test("a valid fetch validates, persists the record, and returns fromCache: false", async () => {
    const { storage, map } = memoryStorage()
    const raw = doc()
    const fetcher = fetchReturns(JSON.stringify(raw))

    const result = await fetchRemote(REMOTE_URL, storage, {
      fetch: fetcher.fetch,
      now: () => NOW,
    })

    const expected = validateCatalog(raw)
    if (!expected.ok) throw new Error(`test document is invalid: ${expected.reason}`)
    expect(result).toEqual({ doc: expected.catalog, acquiredAt: NOW, fromCache: false, warnings: [] })
    expect(fetcher.calls()).toBe(1)
    // The record must be durable storage, i.e. written under doc/cache.
    expect(map.get(DOC_CACHE_KEY)).toEqual({
      v: 2,
      source: remoteIdentity(REMOTE_URL),
      doc: expected.catalog,
      acquiredAt: NOW,
    })
  })

  test("a second call within the TTL serves the record without calling fetch", async () => {
    const { storage } = memoryStorage()
    const seeded = await seedCache(storage, NOW)
    const fetcher = fetchReturns("{}", 500) // a call here would fail the test

    const result = await fetchRemote(REMOTE_URL, storage, {
      fetch: fetcher.fetch,
      now: () => NOW + TTL - 1, // one millisecond inside the TTL
    })

    expect(result).toEqual({ doc: seeded, acquiredAt: NOW, fromCache: true })
    expect(fetcher.calls()).toBe(0)
  })

  test("a record exactly TTL old is expired: refetches and repopulates the cache", async () => {
    const { storage, map } = memoryStorage()
    await seedCache(storage, NOW)
    const fresh = doc()
    fresh.generated_at = "2026-10-10T00:00:00+00:00"
    const fetcher = fetchReturns(JSON.stringify(fresh))

    const result = await fetchRemote(REMOTE_URL, storage, {
      fetch: fetcher.fetch,
      now: () => NOW + TTL, // age == ttlMs is not "< ttlMs"
    })

    const expected = validateCatalog(fresh)
    if (!expected.ok) throw new Error(`test document is invalid: ${expected.reason}`)
    expect(result).toEqual({ doc: expected.catalog, acquiredAt: NOW + TTL, fromCache: false, warnings: [] })
    expect(fetcher.calls()).toBe(1)
    expect(map.get(DOC_CACHE_KEY)).toEqual({
      v: 2,
      source: remoteIdentity(REMOTE_URL),
      doc: expected.catalog,
      acquiredAt: NOW + TTL,
    })
  })

  test("a fetch failure falls back to the cached record at any age", async () => {
    const { storage } = memoryStorage()
    const staleAt = NOW - 10 * TTL // far past the TTL: stale-tolerant fallback
    const seeded = await seedCache(storage, staleAt)
    const fetcher = fetchFails(new Error("network down"))

    const result = await fetchRemote(REMOTE_URL, storage, {
      fetch: fetcher.fetch,
      now: () => NOW,
    })

    expect(result).toEqual({ doc: seeded, acquiredAt: staleAt, fromCache: true })
    expect(fetcher.calls()).toBe(1)
  })

  test("a fetch failure with no cached record rejects with the reason", async () => {
    const { storage } = memoryStorage()
    const fetcher = fetchFails(new Error("network down"))

    const reason = await rejectionOf(
      fetchRemote(REMOTE_URL, storage, { fetch: fetcher.fetch, now: () => NOW }),
    )

    expect(reason).toContain("remote source failed")
    expect(reason).toContain("network down")
  })

  test("a malformed body falls back to the cached record", async () => {
    const { storage } = memoryStorage()
    const seeded = await seedCache(storage, NOW - 10 * TTL)
    const fetcher = fetchReturns("not json")

    const result = await fetchRemote(REMOTE_URL, storage, {
      fetch: fetcher.fetch,
      now: () => NOW,
    })

    expect(result).toEqual({ doc: seeded, acquiredAt: NOW - 10 * TTL, fromCache: true })
  })

  test("a non-OK status rejects with the status code named", async () => {
    const { storage } = memoryStorage()
    const fetcher = fetchReturns("nope", 404)

    const reason = await rejectionOf(
      fetchRemote(REMOTE_URL, storage, { fetch: fetcher.fetch, now: () => NOW }),
    )

    expect(reason).toContain("remote source failed")
    expect(reason).toContain("404")
  })

  test("a schema-invalid document rejects with the validator's reason", async () => {
    const { storage } = memoryStorage()
    const fetcher = fetchReturns(JSON.stringify({ schema_version: 3 }))

    const reason = await rejectionOf(
      fetchRemote(REMOTE_URL, storage, { fetch: fetcher.fetch, now: () => NOW }),
    )

    expect(reason).toContain("remote source failed")
    expect(reason).toContain("schema_version must be 6")
  })

  test("a record without a usable doc is treated as no cache", async () => {
    const { storage, map } = memoryStorage()
    // A current-era record (v2) whose shape is unusable: the version gate
    // passes, the source matches, acquiredAt is finite — and then
    // validateStoredCatalog(undefined) rejects the missing doc. The v1-era
    // rejection itself is covered by storage.test.ts's dedicated v1-era test;
    // this test must stay past the version gate to keep the doc-shape path
    // covered.
    map.set(DOC_CACHE_KEY, { v: 2, source: remoteIdentity(REMOTE_URL), acquiredAt: NOW }) // corrupt: no doc at all
    const fetcher = fetchFails(new Error("network down"))

    const reason = await rejectionOf(
      fetchRemote(REMOTE_URL, storage, { fetch: fetcher.fetch, now: () => NOW }),
    )

    expect(reason).toContain("remote source failed")
    expect(reason).toContain("network down")
  })

  test("with default deps a record younger than 6h is served from cache", async () => {
    const { storage } = memoryStorage()
    const acquiredAt = Date.now() - (TTL - 60_000) // 5h59m old
    const seeded = await seedCache(storage, acquiredAt)
    const fetcher = fetchReturns("{}", 500) // a call here would fail the test

    const result = await fetchRemote(REMOTE_URL, storage, { fetch: fetcher.fetch })

    expect(result).toEqual({ doc: seeded, acquiredAt, fromCache: true })
    expect(fetcher.calls()).toBe(0)
  })

  test("with default deps a record older than 6h is refetched", async () => {
    const { storage } = memoryStorage()
    const staleAt = Date.now() - (TTL + 60_000) // 6h01m old
    await seedCache(storage, staleAt)
    const fetcher = fetchReturns(JSON.stringify(doc()))

    const result = await fetchRemote(REMOTE_URL, storage, { fetch: fetcher.fetch })

    expect(result.fromCache).toBe(false)
    expect(result.acquiredAt).toBeGreaterThanOrEqual(staleAt + TTL)
    expect(fetcher.calls()).toBe(1)
  })
})

describe("fetchRemote body cap (hostile catalogURL hardening)", () => {
  const MiB = 1024 * 1024

  // A lazy body stream: chunks are generated on pull, so proving the cap
  // takes no real 16 MiB allocation — and the mid-read abort is observable.
  function bigBody(chunkCount: number, chunkBytes: number) {
    const chunk = new Uint8Array(chunkBytes)
    const state = { cancelled: false, pulled: 0 }
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (state.pulled >= chunkCount) {
          controller.close()
          return
        }
        state.pulled += 1
        controller.enqueue(chunk)
      },
      cancel() {
        state.cancelled = true
      },
    })
    return { stream, state }
  }

  test("a body past the 16 MiB cap is cancelled mid-read and fails invalid-JSON-style", async () => {
    const { storage } = memoryStorage()
    const body = bigBody(64, MiB) // 64 MiB if it were read to the end
    const impl: typeof fetch = async () => new Response(body.stream)

    const reason = await rejectionOf(fetchRemote(REMOTE_URL, storage, { fetch: impl, now: () => NOW }))

    expect(reason).toContain("remote source failed")
    expect(reason).toContain("invalid JSON in response")
    expect(reason).toMatch(/exceeds/)
    // Reading stopped at the cap: the stream was cancelled, not drained.
    expect(body.state.cancelled).toBe(true)
    expect(body.state.pulled).toBeLessThan(64)
  })

  test("a Content-Length past the cap fails before one body byte is read", async () => {
    const { storage } = memoryStorage()
    const body = bigBody(64, MiB)
    const impl: typeof fetch = async () =>
      new Response(body.stream, { headers: { "content-length": String(64 * MiB) } })

    const reason = await rejectionOf(fetchRemote(REMOTE_URL, storage, { fetch: impl, now: () => NOW }))

    expect(reason).toContain("invalid JSON in response")
    expect(reason).toMatch(/exceeds/)
    // The early check fired first: our read never started — at most the
    // Response implementation's own eager first pull happened, far below
    // the 17 chunks a read-through to the cap would need.
    expect(body.state.pulled).toBeLessThanOrEqual(1)
    expect(body.state.cancelled).toBe(true)
  })

  test("an oversized body falls back to the cached record like any other failure", async () => {
    const { storage } = memoryStorage()
    const seeded = await seedCache(storage, NOW - 10 * TTL)
    const body = bigBody(64, MiB)
    const impl: typeof fetch = async () => new Response(body.stream)

    const result = await fetchRemote(REMOTE_URL, storage, { fetch: impl, now: () => NOW })

    expect(result).toEqual({ doc: seeded, acquiredAt: NOW - 10 * TTL, fromCache: true })
  })
})

describe("fetchRemote https-only redirect guard (Ruling 9)", () => {
  // A fake fetch that answers every call with the same redirect response and
  // records each request it received: the guard must fetch with
  // redirect: "manual" and must NOT issue a second request when a redirect's
  // target leaves https — the plaintext target is never contacted.
  function redirectingFetch(status: number, location: string) {
    const requests: Array<{ url: string; redirect?: string }> = []
    const impl: typeof fetch = async (input, init) => {
      requests.push({ url: String(input), redirect: init?.redirect })
      return new Response(null, { status, headers: { location } })
    }
    return { fetch: impl, requests: () => requests }
  }

  test("a redirect to an http target is refused, and the plaintext target is never fetched", async () => {
    const { storage } = memoryStorage()
    const red = redirectingFetch(301, "http://models.example.com/catalog.json")
    const reason = await rejectionOf(
      fetchRemote(REMOTE_URL, storage, { fetch: red.fetch, now: () => NOW }),
    )
    expect(reason).toContain("remote source failed")
    expect(reason).toMatch(/https/i)
    // Fail closed BEFORE the second hop: one request total — the original
    // https URL, requested in manual-redirect mode.
    expect(red.requests()).toEqual([{ url: REMOTE_URL, redirect: "manual" }])
  })

  test("a redirect that stays on https is followed to the document", async () => {
    const { storage } = memoryStorage()
    let calls = 0
    const impl: typeof fetch = async () => {
      calls++
      if (calls === 1) {
        return new Response(null, {
          status: 301,
          headers: { location: "https://models.example.com/moved/catalog.json" },
        })
      }
      return new Response(JSON.stringify(doc()), { status: 200 })
    }
    const result = await fetchRemote(REMOTE_URL, storage, { fetch: impl, now: () => NOW })
    expect(result.fromCache).toBe(false)
    expect(result.doc.models.map((m) => m.id)).toEqual(["acme/mini"])
    expect(calls).toBe(2)
  })

  test("a redirect without a Location header is refused", async () => {
    const { storage } = memoryStorage()
    const requests: string[] = []
    const impl: typeof fetch = async (input) => {
      requests.push(String(input))
      // A 302 carrying no Location header at all.
      return new Response(null, { status: 302 })
    }
    const reason = await rejectionOf(
      fetchRemote(REMOTE_URL, storage, { fetch: impl, now: () => NOW }),
    )
    expect(reason).toContain("remote source failed")
    expect(reason).toMatch(/Location/i)
    expect(requests).toHaveLength(1)
  })

  test("a https redirect loop is cut off, not followed forever", async () => {
    const { storage } = memoryStorage()
    let calls = 0
    const impl: typeof fetch = async () => {
      calls++
      return new Response(null, {
        status: 301,
        headers: { location: `https://models.example.com/hop-${calls}` },
      })
    }
    const reason = await rejectionOf(
      fetchRemote(REMOTE_URL, storage, { fetch: impl, now: () => NOW }),
    )
    expect(reason).toContain("remote source failed")
    expect(reason).toMatch(/redirect/i)
    // Exactly 6: MAX_REDIRECT_HOPS(5) followed hops, then the self-redirect is refused.
    expect(calls).toBe(6)
  })
})

describe("pool-drop warnings (final-review BUG-02)", () => {
  test("a fresh fetch whose pool lost models at the endpoint stage warns with the count", async () => {
    // context: 275 rides along deliberately: the by-design funnel drops must
    // not trigger (or even inflate) the endpoint-stage warning.
    const raw = { ...doc(), pool: { dropped: { endpoint_fetch_failed: 2, context: 275 } } }
    const { fetch } = fetchReturns(JSON.stringify(raw))
    const result = await fetchRemote(REMOTE_URL, memoryStorage().storage, { fetch, now: () => NOW })
    expect(result.fromCache).toBe(false)
    expect(result.warnings).toEqual([
      "catalog pool shrunk: 2 model(s) dropped at the endpoint stage (endpoint_fetch_failed: 2)",
    ])
  })

  test("the healthy funnel shape (endpoint_fetch_failed: 0, normal drops nonzero) emits no warning", async () => {
    // The recorded healthy run's shape: 467 listed → 74 candidates, with 393
    // by-design funnel drops and zero endpoint failures.
    const raw = {
      ...doc(),
      pool: { dropped: { endpoint_fetch_failed: 0, context: 273, "not ZDR": 62, batch: 47, pricing: 6, "tool calling": 5 } },
    }
    const { fetch } = fetchReturns(JSON.stringify(raw))
    const result = await fetchRemote(REMOTE_URL, memoryStorage().storage, { fetch, now: () => NOW })
    expect(result.warnings).toEqual([])
  })

  test("a document without a pool emits no warning", async () => {
    const { fetch } = fetchReturns(JSON.stringify(doc()))
    const result = await fetchRemote(REMOTE_URL, memoryStorage().storage, { fetch, now: () => NOW })
    expect(result.warnings).toEqual([])
  })

  test("a TTL-fresh cache hit never re-warns (cached records carry no pool)", async () => {
    const { storage } = memoryStorage()
    await seedCache(storage, NOW)
    const { fetch, calls } = fetchReturns(
      JSON.stringify({ ...doc(), pool: { dropped: { endpoint_fetch_failed: 2 } } }),
    )
    const result = await fetchRemote(REMOTE_URL, storage, { fetch, now: () => NOW, ttlMs: TTL })
    expect(result.fromCache).toBe(true)
    expect(calls()).toBe(0)
    expect(result.warnings).toBeUndefined()
  })
})

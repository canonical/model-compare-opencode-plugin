// src/opencode/storage.ts
// Versioned records in ctx.storage (design §7.2). OpenCode's plugin storage
// is scoped to the plugin; records carry a version so corrupt or
// unknown-version state is discarded instead of crashing the plugin.

import { validateStoredCatalog } from "../core/catalog"
import { fnv1aHex } from "../core/hash"
import type { Sourced } from "../core/types"

// The slice of OpenCode's ctx.storage the plugin relies on.
export type Storage = {
  get(key: string): Promise<unknown>
  set(key: string, value: unknown): Promise<void>
}

// Reads a versioned record. Returns null — never throws — when the key is
// missing, the value is not a JSON object, or `v` is not the caller's expected
// version (§7.2: corrupt or unknown-version entries are discarded and treated
// as absent). Every caller states the version it owns: pin records are v1,
// the doc cache is DOC_CACHE_VERSION. The doc-cache layer adds its own field
// checks (readCachedDoc below).
export async function readRecord<T extends { v: number }>(
  storage: Storage,
  key: string,
  version: number,
): Promise<T | null> {
  const raw: unknown = await storage.get(key)
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null
  if ((raw as { v?: unknown }).v !== version) return null
  return raw as T
}

// Writes a versioned record. `value` already carries its `v`; the spread
// simply guarantees the written shape is { ...value, v }.
export async function writeRecord(
  storage: Storage,
  key: string,
  value: { v: number } & Record<string, unknown>,
): Promise<void> {
  await storage.set(key, { ...value, v: value.v })
}

// ---- the document cache (§7.9) ------------------------------------------------
// The last validated catalog and when the plugin acquired it:
//   { v: 2, source: <identity>, doc: Catalog, acquiredAt: number }
// stored per SOURCE IDENTITY, so a document is only ever served for the source
// that produced it: changing `catalogURL`, `scriptPath` or `source` is a cache
// miss, never a 6-hour stale answer from the previous source.
//
// The record version tracks the CATALOG era, not the storage format: v1 held a
// schema-v5 catalog, whose `quality` is the AA index at the OpenRouter default
// effort; v2 holds schema v6, where `quality` is the index at the best measured
// selectable depth. The two semantics must never mix, so a v1 record is a cache
// miss and is re-fetched (pins are unaffected: they are model-id references).
export const DOC_CACHE_VERSION = 2

export const remoteIdentity = (url: string): string => `remote:${url}`
// The vendored copy has a fixed identity: its path changes with every install
// location/version, and a plugin update must not look like a cold start.
export const localIdentity = (scriptPath: string | null): string =>
  `local:${scriptPath ?? "vendored"}`

export const docCacheKey = (identity: string): string => `doc/cache/${fnv1aHex(identity)}`

type DocCacheRecord = { v: typeof DOC_CACHE_VERSION; source: unknown; doc: unknown; acquiredAt: unknown }

// The cached document for one source identity, or null when there is none, it
// belongs to another identity (a key collision), or it fails validation — a
// corrupt record is a cache miss, never an exception mid-setup.
export async function readCachedDoc(storage: Storage, identity: string): Promise<Sourced | null> {
  const record = await readRecord<DocCacheRecord>(
    storage,
    docCacheKey(identity),
    DOC_CACHE_VERSION,
  )
  if (record === null) return null
  if (record.source !== identity) return null
  // acquiredAt must be a FINITE number, mirroring isValidPin (src/index.ts):
  // JSON.parse("1e999") parses to Infinity, and now() - Infinity < ttlMs is
  // always true — an unchecked Infinity would be served as perpetually fresh
  // and never re-fetched under this identity (final-review BUG-04).
  if (typeof record.acquiredAt !== "number" || !Number.isFinite(record.acquiredAt)) return null
  const validated = validateStoredCatalog(record.doc)
  if (!validated.ok) {
    console.warn("[model-compare]", `discarding the cached catalog: ${validated.reason}`)
    return null
  }
  return { doc: validated.catalog, acquiredAt: record.acquiredAt }
}

export async function writeCachedDoc(
  storage: Storage,
  identity: string,
  sourced: Sourced,
): Promise<void> {
  await writeRecord(storage, docCacheKey(identity), {
    v: DOC_CACHE_VERSION,
    source: identity,
    doc: sourced.doc,
    acquiredAt: sourced.acquiredAt,
  })
}

// The most recently acquired valid document among the given identities (setup
// seeds from it; under `auto` either source may have produced it).
export async function readNewestCachedDoc(
  storage: Storage,
  identities: readonly string[],
): Promise<Sourced | null> {
  let newest: Sourced | null = null
  for (const identity of identities) {
    const cached = await readCachedDoc(storage, identity)
    if (cached !== null && (newest === null || cached.acquiredAt > newest.acquiredAt)) newest = cached
  }
  return newest
}

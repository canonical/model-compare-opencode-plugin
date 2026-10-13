// src/sources/remote.ts
// The remote catalog source (design §5, §8, §9): fetch the published catalog
// document, validate it, and persist it as a versioned record so the last
// accepted document survives restarts (§9's offline path). A record younger
// than the TTL is served without a network round-trip; any fetch or validation
// failure falls back to the cached record at any age, and fetchRemote only
// rejects when there is no usable record at all.

import { validateCatalog } from "../core/catalog"
import type { Sourced } from "../core/types"
import {
  readCachedDoc,
  remoteIdentity,
  writeCachedDoc,
  type Storage,
} from "../opencode/storage"

// The cache is revalidated after six hours (design §8).
const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000

// A fetch that has not answered by then is aborted (design §4: "HTTPS fetch
// with timeout"). Without it a dead socket would hold the refresh tick's
// non-overlap guard forever.
const DEFAULT_FETCH_TIMEOUT_MS = 30_000

// The body size cap (hostile-input hardening): `catalogURL` is user-pointable
// and the body is buffered whole for JSON.parse, so a hostile server must not
// be able to exhaust memory. 16 MiB is far above any sane catalog (the
// recorded fixture is well under 1 MiB).
const MAX_BODY_BYTES = 16 * 1024 * 1024 // 16 MiB

// Body-read failures share one taxonomy, the invalid-JSON reason style.
function bodyTooLargeReason(): string {
  return `invalid JSON in response (response body exceeds the ${MAX_BODY_BYTES / (1024 * 1024)} MiB cap)`
}

// Read the body as text, enforcing MAX_BODY_BYTES while reading: the stream
// is cancelled the moment the cap is crossed, so an endless or oversized body
// is never buffered further (a lying or absent Content-Length cannot bypass
// the cap).
async function readCappedText(
  response: Response,
  maxBytes: number,
): Promise<{ ok: true; text: string } | { ok: false }> {
  const body = response.body
  if (body === null) return { ok: true, text: "" }
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value === undefined) continue
      total += value.byteLength
      if (total > maxBytes) return { ok: false }
      chunks.push(value)
    }
  } finally {
    // On the overflow path reading stops here — free the connection instead
    // of leaving the stream (and the socket behind it) half-drained.
    await reader.cancel().catch(() => {})
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return { ok: true, text: new TextDecoder().decode(bytes) }
}

// Injectable seams for tests: the network call, the plugin's clock, and the
// TTL (design §8). All default to their production behavior.
export type RemoteDeps = {
  fetch?: typeof fetch
  now?: () => number
  ttlMs?: number
  timeoutMs?: number
}

// One fetch-and-validate attempt as a result object (the fetch itself, the
// HTTP status, the body parse, and the document each get their own reason).
// Network errors surface with their own message; non-OK statuses name the
// status code.
async function fetchAndValidate(
  url: string,
  doFetch: typeof fetch,
  now: () => number,
  timeoutMs: number,
): Promise<{ ok: true; sourced: Sourced } | { ok: false; reason: string }> {
  let response: Response
  try {
    response = await doFetch(url, { signal: AbortSignal.timeout(timeoutMs) })
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
  }
  if (!response.ok) {
    return { ok: false, reason: `HTTP status ${response.status}` }
  }

  // Content-Length, when honest and present, fails before a single body byte
  // is read; readCappedText enforces the same cap for the rest.
  const declared = response.headers?.get("content-length")
  if (declared !== null && declared !== undefined && /^\d+$/.test(declared) && Number(declared) > MAX_BODY_BYTES) {
    await response.body?.cancel().catch(() => {})
    return { ok: false, reason: bodyTooLargeReason() }
  }

  let raw: unknown
  try {
    const read = await readCappedText(response, MAX_BODY_BYTES)
    if (!read.ok) return { ok: false, reason: bodyTooLargeReason() }
    raw = JSON.parse(read.text)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, reason: `invalid JSON in response (${message})` }
  }

  const validated = validateCatalog(raw)
  if (!validated.ok) {
    return { ok: false, reason: `invalid catalog document: ${validated.reason}` }
  }
  return { ok: true, sourced: { doc: validated.catalog, acquiredAt: now() } }
}

// Fetch the remote catalog with a persisted six-hour cache (design §5, §8):
// a fresh record is returned without fetching; otherwise the document is
// fetched, validated, persisted in the document cache of this URL, and returned with
// fromCache: false. A fetch or validation failure returns the cached record
// whatever its age; with no usable record the reason is rejected.
export async function fetchRemote(
  url: string,
  storage: Storage,
  deps: RemoteDeps = {},
): Promise<Sourced & { fromCache: boolean }> {
  const doFetch = deps.fetch ?? globalThis.fetch
  const now = deps.now ?? Date.now
  const ttlMs = deps.ttlMs ?? DEFAULT_TTL_MS

  const identity = remoteIdentity(url)
  const cached = await readCachedDoc(storage, identity)
  if (cached !== null && now() - cached.acquiredAt < ttlMs) {
    return { ...cached, fromCache: true }
  }

  const attempt = await fetchAndValidate(url, doFetch, now, deps.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS)
  if (attempt.ok) {
    const { doc, acquiredAt } = attempt.sourced
    await writeCachedDoc(storage, identity, { doc, acquiredAt })
    return { doc, acquiredAt, fromCache: false }
  }
  if (cached !== null) return { ...cached, fromCache: true }
  throw new Error(`remote source failed: ${attempt.reason}`)
}

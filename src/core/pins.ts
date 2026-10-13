// src/core/pins.ts
// Pin/last-known-good state and pick resolution (design §7, §9). Pure
// decision logic over a validated Catalog — no I/O, no OpenCode imports; the
// caller supplies runnability, the stored pin, and the clock.

import type { Catalog, Priority, Weights } from "./types"
import { fnv1aHex } from "./hash"
import { effectiveWeights, overallScore, rankModels } from "./rank"

// One record per priority and effective-weights hash: both the pin and the
// last-known-good pick (§7.2).
export type Pin = { v: 1; id: string; since: number }

export type ResolveInput = {
  catalog: Catalog | null
  p: Priority
  override?: Partial<Weights>
  // True when OpenCode lists `openrouter/<id>` as an enabled model (§7.1).
  // Receives bare catalog ids.
  runnable: (id: string) => boolean
  // Config value like "openrouter/<id>", or null (§3).
  fallback: string | null
  stored: Pin | null
  now: number
  pinDays: number
  minLead: number
}

export type ResolveResult = {
  targetId: string | null
  source: "pick" | "pin" | "fallback" | "none"
  // The pin state after this resolution: a freshly adopted/kept record, or
  // null only when nothing was adopted and nothing is stored (§7.8 keeps the
  // fallback out of the pin; §9 skips, never deletes, an unrunnable record).
  pin: Pin | null
  notices: string[]
}

const PROVIDER_PREFIX = "openrouter/"
const DAY_MS = 86_400_000

// Config values look like "openrouter/<id>"; catalog ids are bare. Strip
// exactly one leading prefix — a bare id may itself contain slashes
// (provider/model), so nothing beyond the prefix is touched.
function bareModelId(configValue: string): string {
  return configValue.startsWith(PROVIDER_PREFIX)
    ? configValue.slice(PROVIDER_PREFIX.length)
    : configValue
}

export { fnv1aHex }

export function pinKey(p: Priority, w: Weights): string {
  return `pin/${p}/${fnv1aHex(JSON.stringify(w))}`
}

// §9's chain when there is no runnable pick from ranking: configured fallback
// (checked by bare id) → none. `stored` rides along as the pin state: the
// fallback itself is never stored as a pin (§7.8).
function fallbackOrNone(
  fallback: string | null,
  runnable: (id: string) => boolean,
  stored: Pin | null,
  notices: string[],
): ResolveResult {
  if (fallback !== null) {
    const bare = bareModelId(fallback)
    if (runnable(bare)) {
      notices.push(`fallback used: ${bare}`)
      return { targetId: bare, source: "fallback", pin: stored, notices }
    }
  }
  return { targetId: null, source: "none", pin: stored, notices }
}

export function resolve(input: ResolveInput): ResolveResult {
  const { catalog, p, override, runnable, fallback, stored, now, pinDays, minLead } = input
  const notices: string[] = []

  // Without a fresh catalog (§9): stored pin (if runnable) → fallback (if
  // runnable) → none. No rank-related notices — there is no ranking here.
  if (catalog === null) {
    if (stored && runnable(stored.id)) {
      return { targetId: stored.id, source: "pin", pin: stored, notices }
    }
    if (stored) notices.push(`pin skipped: ${stored.id} is not runnable`)
    return fallbackOrNone(fallback, runnable, stored, notices)
  }

  // Fresh catalog (§7.4): rank under the current weights, then walk the order
  // for the first runnable candidate.
  const eff = effectiveWeights(catalog, p, override)
  // "Override ignored" notices: whatever the weight merge chose to ignore.
  notices.push(...eff.warnings)
  const ranked = rankModels(catalog, p, override).ids
  const byId = new Map(catalog.models.map((m) => [m.id, m]))
  const best = ranked.find((id) => runnable(id)) ?? null

  // §9 when the fresh rules yield no runnable candidate: same chain as the
  // no-catalog path.
  if (best === null) {
    if (stored && runnable(stored.id)) {
      return { targetId: stored.id, source: "pin", pin: stored, notices }
    }
    if (stored) notices.push(`pin skipped: ${stored.id} is not runnable`)
    return fallbackOrNone(fallback, runnable, stored, notices)
  }

  // (Re)adopt the best candidate; the target staying the stored pin id (only
  // possible on the expiry re-adoption below) still counts as "pin".
  const adopt = (id: string): ResolveResult => ({
    targetId: id,
    source: stored !== null && id === stored.id ? "pin" : "pick",
    pin: { v: 1, id, since: now },
    notices,
  })

  if (stored === null) return adopt(best)

  const pinEntry = byId.get(stored.id) ?? null

  // (a) The pinned model is not runnable, or has left the pool — §7.4 says
  // switch to the best candidate now. (A ranking entry outside the pool could
  // still name the pin id; that degenerates into a same-id re-adoption.)
  if (!runnable(stored.id) || pinEntry === null) {
    if (best !== stored.id) notices.push(`pin switched: ${stored.id} → ${best}`)
    return adopt(best)
  }

  // (b) The pin is older than pinDays: re-adopt the best candidate — which
  // may be the pinned model itself — and reset `since` (§7.4 "which may be
  // the same model"; §7.6 "since resets every time a pin is adopted or
  // re-adopted").
  if (now - stored.since > pinDays * DAY_MS) {
    if (best !== stored.id) notices.push(`pin switched: ${stored.id} → ${best}`)
    return adopt(best)
  }

  // Nothing changed: keep the pin exactly as stored, clock untouched.
  if (best === stored.id) {
    return { targetId: stored.id, source: "pin", pin: stored, notices }
  }

  // (c) Switch only when the challenger leads by ≥ minLead; both scores come
  // from the current catalog under the current effective weights (§7.4). A
  // challenger missing from the pool can't be scored, so it can't lead.
  const bestEntry = byId.get(best) ?? null
  const lead =
    bestEntry === null
      ? Number.NEGATIVE_INFINITY
      : overallScore(bestEntry, eff.weights) - overallScore(pinEntry, eff.weights)
  if (lead >= minLead) {
    notices.push(`pin switched: ${stored.id} → ${best}`)
    return adopt(best)
  }

  return { targetId: stored.id, source: "pin", pin: stored, notices }
}
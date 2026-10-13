// src/opencode/resolution.ts
// One resolution pass over all three priorities (design §7, §9), shared by
// setup and the refresh tick so the two can never disagree about the chain:
//   fresh catalog  → §7.4 rules (rank, pin hysteresis, expiry) then §9 chain
//   no catalog     → stored pin (if runnable) → fallback (if runnable) → none
// The result is a pure plan: nothing is applied or persisted here.

import type { Config } from "../config"
import { pinKey, resolve, type Pin } from "../core/pins"
import { effectiveWeights } from "../core/rank"
import type { Catalog, Priority } from "../core/types"
import type { AliasTarget } from "./aliases"

export const PRIORITIES: readonly Priority[] = ["balanced", "price", "quality"]

export type PickPlan = {
  picks: Record<Priority, AliasTarget>
  enabled: Record<Priority, boolean>
  // The pin state after this pass (a pass without a catalog never changes it).
  pins: Partial<Record<Priority, Pin>>
  // Pin records to persist: only produced when a fresh catalog is available.
  writes: Array<{ key: string; pin: Pin }>
  notices: string[]
}

export function planPicks(input: {
  config: Config
  // null = no fresh catalog (cold start, offline start, failed refresh).
  doc: Catalog | null
  runnable: ReadonlySet<string>
  pins: Partial<Record<Priority, Pin>>
  now: number
}): PickPlan {
  const { config, doc, runnable, pins, now } = input
  const plan: PickPlan = {
    picks: {} as Record<Priority, AliasTarget>,
    enabled: {} as Record<Priority, boolean>,
    pins: { ...pins },
    writes: [],
    notices: [],
  }
  for (const p of PRIORITIES) {
    const resolved = resolve({
      catalog: doc,
      p,
      override: config.weights[p],
      runnable: (id) => runnable.has(id),
      fallback: config.fallback,
      stored: pins[p] ?? null,
      now,
      pinDays: config.pinDays,
      minLead: config.minLead,
    })
    if (resolved.pin === null) delete plan.pins[p]
    else plan.pins[p] = resolved.pin
    plan.picks[p] =
      resolved.targetId === null
        ? { id: null, fromFallback: false }
        : { id: resolved.targetId, fromFallback: resolved.source === "fallback" }
    plan.enabled[p] = resolved.targetId !== null
    if (doc !== null && resolved.pin !== null) {
      // The effective-weights hash keys the record (§7.2).
      const key = pinKey(p, effectiveWeights(doc, p, config.weights[p]).weights)
      plan.writes.push({ key, pin: resolved.pin })
    }
    plan.notices.push(...resolved.notices)
  }
  return plan
}

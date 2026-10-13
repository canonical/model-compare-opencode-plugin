// src/core/rank.ts
// Weight merging, scoring, and ranking (design §5, §6). Pure functions over a
// validated Catalog — no I/O, no OpenCode imports.

import type { Catalog, ModelEntry, Priority, Weights } from "./types"
import { DEFAULT_WEIGHTS } from "./types"

const WEIGHT_KEYS = ["quality", "price", "context", "age"] as const

export type EffectiveWeights = {
  weights: Weights
  usedOverride: boolean
  // Whether at least one override key actually landed in the merged map (an
  // empty override, or one whose every key the published map's no-data signal
  // rejected, applies nothing). `applied && !zeroSum` is the honest answer to
  // "did the override take effect" — the report's "(custom weights)" label
  // keys off exactly that (src/opencode/commands.ts).
  applied: boolean
  zeroSum: boolean
  warnings: string[]
}

function sumOf(w: Weights): number {
  return w.quality + w.price + w.context + w.age
}

export function effectiveWeights(
  catalog: Catalog,
  p: Priority,
  override?: Partial<Weights>,
): EffectiveWeights {
  const warnings: string[] = []

  // `parameters.weights` missing entirely leaves `catalog.weights` empty
  // (validateCatalog): the pinned-tag defaults apply and overrides replace
  // keys of those defaults freely. Otherwise the published map for this
  // priority is the base, and a key it lacks means weight 0 — upstream
  // removes a key entirely when no candidate has that data (design §5).
  const hasParametersWeights = Object.keys(catalog.weights).length > 0
  const published = hasParametersWeights ? (catalog.weights[p] ?? {}) : undefined
  const base: Weights = published
    ? {
        quality: published.quality ?? 0,
        price: published.price ?? 0,
        context: published.context ?? 0,
        age: published.age ?? 0,
      }
    : { ...DEFAULT_WEIGHTS[p] }

  if (!override) {
    return { weights: base, usedOverride: false, applied: false, zeroSum: sumOf(base) === 0, warnings }
  }

  // Replace the keys the user set. When a published map exists for this
  // priority, a key it lacks (the no-data signal) is ignored with a
  // warning; the other keys apply. With no published map at all (no
  // `parameters.weights`), every override key applies to the DEFAULT base.
  const merged: Weights = { ...base }
  let applied = false
  for (const key of WEIGHT_KEYS) {
    const value = override[key]
    if (value === undefined) continue
    if (published && published[key] === undefined) {
      warnings.push(
        `ignoring ${key} weight override: the catalog's ${p} weights have no ${key} key (no data for it)`,
      )
      continue
    }
    merged[key] = value
    applied = true
  }

  const total = sumOf(merged)
  if (total === 0) {
    // Runtime zero-sum (design §6): the merged map is a config error the
    // schema can't catch; use the published (or DEFAULT) weights instead.
    return { weights: base, usedOverride: true, applied, zeroSum: true, warnings }
  }
  const weights = {
    quality: merged.quality / total,
    price: merged.price / total,
    context: merged.context / total,
    age: merged.age / total,
  }
  return { weights, usedOverride: true, applied, zeroSum: false, warnings }
}

export function overallScore(entry: ModelEntry, w: Weights): number {
  // Operand order matches upstream's scoring (design §6).
  return (
    w.quality * entry.scores.quality +
    w.price * entry.scores.price +
    w.context * entry.scores.context +
    w.age * entry.scores.age
  )
}

// Every plugin-side ordering sorts by (-score, -(quality ?? 0),
// pricing.blended_per_1m ascending, id ascending), mirroring upstream's
// ranking_key (design §6).
function byRankingKey(score: (m: ModelEntry) => number): (a: ModelEntry, b: ModelEntry) => number {
  return (a, b) => {
    const byScore = score(b) - score(a)
    if (byScore !== 0) return byScore
    const byQuality = (b.quality ?? 0) - (a.quality ?? 0)
    if (byQuality !== 0) return byQuality
    const byPrice = a.pricing.blended_per_1m - b.pricing.blended_per_1m
    if (byPrice !== 0) return byPrice
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  }
}

function rankBy(models: ModelEntry[], score: (m: ModelEntry) => number): string[] {
  return [...models].sort(byRankingKey(score)).map((m) => m.id)
}

export function rankModels(
  catalog: Catalog,
  p: Priority,
  override?: Partial<Weights>,
): { ids: string[]; usedFallbackWeights: boolean } {
  if (!override) {
    const published = catalog.rankings[p]
    if (published) return { ids: [...published], usedFallbackWeights: false }
    // No published ranking: sort by the published overall score (design §6).
    return { ids: rankBy(catalog.models, (m) => m.scores.overall[p]), usedFallbackWeights: false }
  }
  const eff = effectiveWeights(catalog, p, override)
  // A zero-sum merged map falls back to the published (or DEFAULT) weights,
  // which `effectiveWeights` returns in `weights` on that path.
  return { ids: rankBy(catalog.models, (m) => overallScore(m, eff.weights)), usedFallbackWeights: eff.zeroSum }
}

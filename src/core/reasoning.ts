// src/core/reasoning.ts
// Reasoning-depth helpers (catalog v6): gateway-effort validation, the
// selectable-depth rule, and the best measured alternative to the effort a
// model was scored at. Pure functions over a projected ModelEntry — no I/O,
// no OpenCode imports.
//
// The selectable rule is upstream's site rule (web/site/app.js depthRows):
// OpenRouter can select an effort only when the model's expanded
// `supported_efforts` lists it (or the model is a single-state toggle that
// exposes `#none`). An AA row for an unlisted effort is display-only and is
// never advertised as an alternative. The catalog's `reasoning` sentinel is a
// producer label for a single-state reasoning model, not a gateway value.

import type { ModelEntry, Reasoning } from "./types"

// What OpenRouter accepts as a discrete effort. Mirrors upstream's
// REASONING_GATEWAY_EFFORTS. Deliberately excludes the catalog sentinels
// "reasoning" and "default".
export const GATEWAY_EFFORTS = ["max", "xhigh", "high", "medium", "low", "minimal", "none"] as const

// Deepest-first display order, mirroring upstream's AA_EFFORT_ORDER.
const EFFORT_ORDER: readonly string[] = [...GATEWAY_EFFORTS, "reasoning"]

export function gatewayEffort(value: string | null | undefined): string | null {
  return value !== null && value !== undefined && (GATEWAY_EFFORTS as readonly string[]).includes(value)
    ? value
    : null
}

function effortOrder(effort: string): number {
  const index = EFFORT_ORDER.indexOf(effort)
  return index === -1 ? EFFORT_ORDER.length : index
}

// Upstream's v5 non-reasoning rule (the producer's is_reasoning flag is not
// published): no reasoning metadata at all, so the bare id is the only form.
function isNonReasoningBlock(reasoning: Reasoning): boolean {
  return (
    reasoning.default_effort === "none" &&
    reasoning.default_enabled !== false &&
    reasoning.mandatory !== true &&
    reasoning.supports_max_tokens !== true
  )
}

// A single-state reasoning model with reasoning off by default exposes only
// the "#none" toggle.
function isSingleStateToggle(reasoning: Reasoning): boolean {
  return reasoning.mandatory !== true && reasoning.default_enabled === false
}

export function isSelectableDepth(model: ModelEntry, effort: string): boolean {
  if (effort === "reasoning") return false
  const reasoning = model.reasoning
  if (reasoning === undefined) return false
  if (reasoning.supported_efforts.includes(effort)) return true
  if (effort !== "none" || reasoning.supported_efforts.length > 0) return false
  if (isNonReasoningBlock(reasoning)) return false
  return isSingleStateToggle(reasoning)
}

export type DepthAlternative = {
  effort: string
  index: number
  cost: number | null
}

// The best measured, selectable effort that scores strictly higher than the
// effort `quality` already represents. Unselectable rows never qualify; ties
// resolve to the deeper effort (the display order).
export function bestDepthAlternative(model: ModelEntry): DepthAlternative | null {
  const base = model.quality
  const selected = model.qualityEffort
  const reasoning = model.reasoning
  if (base == null || selected == null || reasoning === undefined) return null

  const depths = [...reasoning.depths].sort((a, b) => effortOrder(a.effort) - effortOrder(b.effort))
  let best: DepthAlternative | null = null
  for (const depth of depths) {
    if (depth.index === null || depth.effort === selected) continue
    if (!isSelectableDepth(model, depth.effort)) continue
    if (depth.index <= base) continue
    if (best === null || depth.index > best.index) {
      best = { effort: depth.effort, index: depth.index, cost: depth.cost_per_task_usd }
    }
  }
  return best
}

// The report's compact alternative label: "<effort> <index>" ("max 56.0"),
// the same shape upstream's site shows under QUAL. Empty when there is none.
export function formatDepthAlternative(model: ModelEntry | undefined): string {
  if (model === undefined) return ""
  const best = bestDepthAlternative(model)
  return best === null ? "" : `${best.effort} ${best.index.toFixed(1)}`
}

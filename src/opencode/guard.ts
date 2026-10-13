// src/opencode/guard.ts
// The primary-kind guard (design §9). Pure decision logic: given the request
// kind, the requesting agent's configured model ref, and whether each alias is
// enabled, decide whether the request must abort. It never touches OpenCode —
// the hook (Task 12) supplies the inputs and acts on the decision.
//
// Known trade-off (§9, §15): in headless runs the guard can fire even though
// the root-governed effective model is healthy, because it keys on the agent's
// configured ref. This is accepted, not a bug.

import type { Priority } from "../core/types"

// A model reference as configured on an agent (`agent.model`).
export type ModelRef = { providerID: string; id: string }

const ALIAS_PREFIX = "model-compare/"

const PRIORITIES: readonly Priority[] = ["balanced", "price", "quality"]

// The priority an alias ref points at, or null when the ref is not one of our
// aliases. Matches ONLY openrouter + `model-compare/<p>` where the remainder
// after the prefix IS a priority name — ids may carry more slashes in
// OpenRouter's vendor/model style, so anything after the priority disqualifies.
export function parseAliasRef(ref: ModelRef | undefined): Priority | null {
  if (ref === undefined || ref.providerID !== "openrouter") return null
  if (!ref.id.startsWith(ALIAS_PREFIX)) return null
  const remainder = ref.id.slice(ALIAS_PREFIX.length)
  return PRIORITIES.includes(remainder as Priority) ? (remainder as Priority) : null
}

// Abort only a primary request whose agent is configured with a DISABLED
// alias. Everything else — non-primary kinds, enabled aliases, real model
// refs, missing refs — passes with no error.
export function guardDecision(
  kind: string,
  agentModel: ModelRef | undefined,
  isEnabled: (p: Priority) => boolean,
): { error?: string } {
  const p = parseAliasRef(agentModel)
  if (kind !== "primary" || p === null || isEnabled(p)) return {}
  return {
    error: `model-compare: no ranking data for openrouter/model-compare/${p}; set options.fallback or check the data source`,
  }
}
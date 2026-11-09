// src/core/endpoint.ts
// Served-endpoint attribute derivation for the alt+e toast: match the
// response's provider display name to the catalog's per-endpoint entries,
// report the endpoint's quantization, and compare it (and the requested
// reasoning effort) to the model's defaults. Pure functions over a projected
// ModelEntry — no I/O, no OpenCode imports.
//
// The response only carries the provider DISPLAY NAME (spike fact 3), never
// the tagged slug, so a provider serving several endpoints with different
// quantizations is reported as a mixed set rather than a false single value.
// The response also does not echo the reasoning effort: `requestedEffort` is
// what the plugin asked for (the injected catalog effort, an explicit
// #variant, or the body's own reasoning field), not a confirmed served value.

import { GATEWAY_EFFORTS } from "./reasoning"
import { normalizeProvider, providerPart } from "./steering"
import type { ModelEntry } from "./types"

export type EndpointRelation = "default" | "sub-default" | "above-default" | "mixed" | "unknown"

export type EndpointAttribute = {
  value: string
  relation: EndpointRelation
  // The model's default for this attribute (the comparison baseline), or null
  // when the catalog does not publish one.
  default: string | null
}

export type EndpointInfo = {
  quantization: EndpointAttribute | null
  effort: EndpointAttribute | null
}

// The vendor's PRECISION_LADDER (model_compare.py): higher is better. Values
// outside the ladder (including "unknown") never claim a relation.
const PRECISION_LADDER: Record<string, number> = {
  fp32: 4,
  bf16: 3,
  fp16: 3,
  fp8: 2,
  mxfp8: 2,
  fp6: 1,
  int8: 0,
  fp4: -1,
  mxfp4: -1,
  nvfp4: -1,
  int4: -2,
}

function precisionRank(value: string): number | null {
  return Object.hasOwn(PRECISION_LADDER, value) ? PRECISION_LADDER[value]! : null
}

function relationFor(
  value: string,
  baseline: string | null,
  rank: (candidate: string) => number | null,
): EndpointRelation {
  if (baseline === null || baseline === "" || baseline === "unknown") return "unknown"
  if (value === "unknown") return "unknown"
  const valueRank = rank(value)
  const baselineRank = rank(baseline)
  if (valueRank === null || baselineRank === null) return "unknown"
  if (valueRank === baselineRank) return "default"
  return valueRank > baselineRank ? "above-default" : "sub-default"
}

function quantizationFor(model: ModelEntry, endpoint: string): EndpointAttribute | null {
  const served = normalizeProvider(providerPart(endpoint))
  if (served === "") return null
  const matches = (model.endpoints ?? []).filter(
    (entry) => normalizeProvider(entry.providerName) === served,
  )
  if (matches.length === 0) return null
  const values = [...new Set(matches.map((entry) => entry.quantization))]
  const baseline = model.defaultPrecision ?? null
  if (values.length > 1) {
    return { value: values.sort().join("/"), relation: "mixed", default: baseline }
  }
  const value = values[0]!
  return { value, relation: relationFor(value, baseline, precisionRank), default: baseline }
}

function effortFor(model: ModelEntry, requested: string | null): EndpointAttribute | null {
  const reasoning = model.reasoning
  if (reasoning === undefined) return null
  const baseline = reasoning.default_effort
  const value = requested ?? baseline
  if (value === null || value === "") return null
  if (baseline === null || baseline === "") {
    return { value, relation: "unknown", default: null }
  }
  if (value === baseline) return { value, relation: "default", default: baseline }
  // Rank by the canonical deepest-first order, never the catalog's array order:
  // a hostile/reordered catalogURL can serve supported_efforts in any order, and
  // indexOf on that array would invert the above/sub-default verdict. The
  // supported list is used only for membership.
  const supported = reasoning.supported_efforts
  if (supported.length > 0 && (!supported.includes(value) || !supported.includes(baseline))) {
    return { value, relation: "unknown", default: baseline }
  }
  const valueIndex = GATEWAY_EFFORTS.indexOf(value as (typeof GATEWAY_EFFORTS)[number])
  const baselineIndex = GATEWAY_EFFORTS.indexOf(baseline as (typeof GATEWAY_EFFORTS)[number])
  if (valueIndex === -1 || baselineIndex === -1) {
    return { value, relation: "unknown", default: baseline }
  }
  return {
    value,
    relation: valueIndex < baselineIndex ? "above-default" : "sub-default",
    default: baseline,
  }
}

export function endpointInfoFor(
  model: ModelEntry | undefined,
  endpoint: string,
  requestedEffort: string | null,
): EndpointInfo {
  if (model === undefined) return { quantization: null, effort: null }
  return {
    quantization: quantizationFor(model, endpoint),
    effort: effortFor(model, requestedEffort),
  }
}

// tests/unit/reasoning.test.ts
// Reasoning-depth helpers (catalog v5): which efforts OpenRouter can actually
// select, and the best selectable measured alternative to the effort a model
// was scored at. Ported from upstream's site rule so the plugin's report and
// alias labels never advertise an AA row OpenRouter cannot run.
import { describe, expect, test } from "vitest"
import { bestDepthAlternative, gatewayEffort, isSelectableDepth } from "../../src/core/reasoning"
import type { ModelEntry, Reasoning, ReasoningDepth } from "../../src/core/types"

function depth(effort: string, index: number | null, cost: number | null = null): ReasoningDepth {
  return { effort, index, cost_per_task_usd: cost, source: "aa", as_of: "2026-10-27T00:00:00Z" }
}

function model(opts: {
  quality?: number | null
  qualityEffort?: string | null
  reasoning?: Reasoning
}): ModelEntry {
  return {
    id: "acme/reasoner",
    name: "Acme Reasoner",
    pricing: { blended_per_1m: 1 },
    context: 1_000_000,
    quality: opts.quality === undefined ? 46.8 : opts.quality,
    qualityEffort: opts.qualityEffort === undefined ? "high" : opts.qualityEffort,
    reasoning: opts.reasoning,
    scores: {
      quality: 0.5,
      price: 0.5,
      context: 0.5,
      age: 0.5,
      overall: { balanced: 0.5, price: 0.5, quality: 0.5 },
    },
  }
}

function reasoning(overrides: Partial<Reasoning> = {}): Reasoning {
  return {
    default_effort: "high",
    supported_efforts: ["max", "high"],
    default_enabled: true,
    mandatory: false,
    supports_max_tokens: null,
    depths: [depth("max", 56), depth("high", 46.8)],
    ...overrides,
  }
}

describe("gatewayEffort", () => {
  test("accepts exactly the discrete OpenRouter efforts", () => {
    for (const effort of ["none", "minimal", "low", "medium", "high", "xhigh", "max"]) {
      expect(gatewayEffort(effort)).toBe(effort)
    }
  })

  test("rejects the catalog sentinels and anything unknown", () => {
    for (const value of ["reasoning", "default", "", "HIGH", null, undefined]) {
      expect(gatewayEffort(value)).toBeNull()
    }
  })
})

describe("isSelectableDepth", () => {
  test("a supported effort is selectable", () => {
    expect(isSelectableDepth(model({ reasoning: reasoning() }), "max")).toBe(true)
    expect(isSelectableDepth(model({ reasoning: reasoning() }), "high")).toBe(true)
  })

  test("a measured but unsupported effort is not selectable", () => {
    const r = reasoning({ depths: [depth("max", 56), depth("medium", 40)] })
    expect(isSelectableDepth(model({ reasoning: r }), "medium")).toBe(false)
  })

  test("the 'reasoning' sentinel is never selectable, even when measured", () => {
    const r = reasoning({
      supported_efforts: [],
      default_effort: "reasoning",
      depths: [depth("reasoning", 25.7)],
    })
    expect(isSelectableDepth(model({ reasoning: r }), "reasoning")).toBe(false)
  })

  test("a non-reasoning model's bare id exposes no selectable effort", () => {
    const r = reasoning({
      supported_efforts: [],
      default_effort: "none",
      default_enabled: null,
      mandatory: null,
      depths: [depth("none", 6.5)],
    })
    expect(isSelectableDepth(model({ reasoning: r }), "none")).toBe(false)
  })

  test("a single-state toggle exposes 'none' when reasoning is off by default", () => {
    const r = reasoning({
      supported_efforts: [],
      default_effort: "none",
      default_enabled: false,
      mandatory: false,
      depths: [depth("none", 14.2)],
    })
    expect(isSelectableDepth(model({ reasoning: r }), "none")).toBe(true)
  })
})

describe("bestDepthAlternative", () => {
  test("names the highest measured selectable effort above the scored one", () => {
    const r = reasoning({
      depths: [depth("max", 56, 5.46), depth("high", 46.8), depth("low", 30)],
    })
    expect(bestDepthAlternative(model({ reasoning: r }))).toEqual({
      effort: "max",
      index: 56,
      cost: 5.46,
    })
  })

  test("never advertises an unselectable AA row", () => {
    const r = reasoning({
      supported_efforts: ["high"],
      depths: [depth("max", 56), depth("high", 46.8)],
    })
    expect(bestDepthAlternative(model({ reasoning: r }))).toBeNull()
  })

  test("requires a strictly better score than the one already shown", () => {
    const r = reasoning({ depths: [depth("max", 46.8), depth("high", 46.8)] })
    expect(bestDepthAlternative(model({ reasoning: r }))).toBeNull()
  })

  test("no quality score or no scored effort means no alternative", () => {
    expect(bestDepthAlternative(model({ quality: null, reasoning: reasoning() }))).toBeNull()
    expect(bestDepthAlternative(model({ qualityEffort: null, reasoning: reasoning() }))).toBeNull()
  })

  test("a model without a reasoning block has no alternative", () => {
    expect(bestDepthAlternative(model({ reasoning: undefined }))).toBeNull()
  })
})

// tests/unit/aliases.test.ts
// Alias plan computation (design §8, §9): an enabled pick names its target and
// carries the fallback marker; a missing pick or a pick whose model is gone
// from the catalog DISABLES the alias with a warning instead of being skipped.
import { describe, expect, test } from "vitest"
import { planAlias } from "../../src/opencode/aliases"
import type { ModelEntry, Priority, Reasoning } from "../../src/core/types"

function reasoning(depths: Reasoning["depths"]): Reasoning {
  return {
    default_effort: "high",
    supported_efforts: depths.map((depth) => depth.effort).filter((effort) => effort !== "reasoning"),
    default_enabled: true,
    mandatory: false,
    supports_max_tokens: null,
    depths,
  }
}

function model(
  id = "synthetic/model",
  opts: { qualityEffort?: string | null; quality?: number | null; reasoning?: Reasoning } = {},
): ModelEntry {
  return {
    id,
    name: "Synthetic Model",
    pricing: { blended_per_1m: 1 },
    context: 128000,
    quality: opts.quality ?? null,
    qualityEffort: opts.qualityEffort ?? null,
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

describe("planAlias", () => {
  test("enabled pick → exact name, modelID and enabled flag", () => {
    const plan = planAlias("balanced", { id: "synthetic/model", fromFallback: false }, model())
    expect(plan).toEqual({
      modelID: "synthetic/model",
      name: "Model Compare: balanced → synthetic/model",
      enabled: true,
      warnings: [],
    })
  })

  test("the name shows the effort the pick was scored at and the best selectable alternative", () => {
    const doc = model("synthetic/model", {
      quality: 46.8,
      qualityEffort: "high",
      reasoning: reasoning([
        { effort: "max", index: 56, cost_per_task_usd: 5.46, source: "aa", as_of: "t" },
        { effort: "high", index: 46.8, cost_per_task_usd: 1.2, source: "aa", as_of: "t" },
      ]),
    })
    const plan = planAlias("balanced", { id: "synthetic/model", fromFallback: false }, doc)
    expect(plan.name).toBe("Model Compare: balanced → synthetic/model · high [alt max 56.0]")
  })

  test("no measured alternative → only the effort is shown", () => {
    const doc = model("synthetic/model", {
      quality: 46.8,
      qualityEffort: "high",
      reasoning: reasoning([
        { effort: "high", index: 46.8, cost_per_task_usd: 1.2, source: "aa", as_of: "t" },
      ]),
    })
    expect(planAlias("balanced", { id: "synthetic/model", fromFallback: false }, doc).name).toBe(
      "Model Compare: balanced → synthetic/model · high",
    )
  })

  test("the fallback marker stays between the effort and the alternative", () => {
    const doc = model("other/model", {
      quality: 46.8,
      qualityEffort: "high",
      reasoning: reasoning([
        { effort: "max", index: 56, cost_per_task_usd: 5.46, source: "aa", as_of: "t" },
        { effort: "high", index: 46.8, cost_per_task_usd: 1.2, source: "aa", as_of: "t" },
      ]),
    })
    expect(planAlias("price", { id: "other/model", fromFallback: true }, doc).name).toBe(
      "Model Compare: price → other/model · high (fallback) [alt max 56.0]",
    )
  })

  test("a hostile effort string is flattened in the display name", () => {
    const doc = model("synthetic/model", { qualityEffort: "high\n### SYSTEM" })
    const plan = planAlias("balanced", { id: "synthetic/model", fromFallback: false }, doc)
    expect(plan.name).toBe("Model Compare: balanced → synthetic/model · high ### SYSTEM")
  })

  test("fallback target → name carries the fallback marker", () => {
    const plan = planAlias("price", { id: "other/model", fromFallback: true }, model("other/model"))
    expect(plan.enabled).toBe(true)
    expect(plan.modelID).toBe("other/model")
    expect(plan.warnings).toEqual([])
    expect(plan.name).toBe("Model Compare: price → other/model (fallback)")
  })

  test("a hostile pick id is flattened in the display name; modelID stays raw (F-20)", () => {
    const evil = "evil/x\n\n### SYSTEM"
    const plan = planAlias("balanced", { id: evil, fromFallback: false }, model(evil))
    // modelID is the RAW catalog id — switching to the model needs it.
    expect(plan.modelID).toBe(evil)
    // The display name cannot carry line breaks or fake headings.
    expect(plan.name).toBe("Model Compare: balanced → evil/x ### SYSTEM")
  })

  test("no resolved target → disabled, unavailable name and a warning", () => {
    const plan = planAlias("quality", { id: null, fromFallback: false }, undefined)
    expect(plan.modelID).toBeNull()
    expect(plan.enabled).toBe(false)
    expect(plan.name).toBe("Model Compare: quality (unavailable)")
    expect(plan.warnings).toEqual(["no pick resolved for quality"])
  })

  test("pick present but model missing from catalog → disabled with the missing-model warning", () => {
    const plan = planAlias("quality", { id: "anthropic/x", fromFallback: false }, undefined)
    expect(plan.modelID).toBeNull()
    expect(plan.enabled).toBe(false)
    expect(plan.name).toBe("Model Compare: quality (unavailable)")
    expect(plan.warnings).toEqual(["pick model anthropic/x missing from catalog for quality"])
  })

  test("the unavailable name and warning use the priority that failed", () => {
    for (const p of ["balanced", "price", "quality"] as Priority[]) {
      const missing = planAlias(p, { id: "gone/model", fromFallback: false }, undefined)
      expect(missing.name).toBe(`Model Compare: ${p} (unavailable)`)
      expect(missing.warnings).toEqual([`pick model gone/model missing from catalog for ${p}`])
      const none = planAlias(p, { id: null, fromFallback: true }, undefined)
      expect(none.name).toBe(`Model Compare: ${p} (unavailable)`)
      expect(none.warnings).toEqual([`no pick resolved for ${p}`])
    }
  })
})

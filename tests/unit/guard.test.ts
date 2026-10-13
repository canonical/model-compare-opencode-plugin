// tests/unit/guard.test.ts
// The primary-kind guard (design §9): a request on the primary agent aborts
// with an exact error when the agent is configured with a DISABLED alias;
// enabled aliases, real model refs, undefined refs and non-primary kinds
// (title, compaction, generate) never fire.
import { describe, expect, test } from "vitest"
import { guardDecision, parseAliasRef } from "../../src/opencode/guard"
import type { Priority } from "../../src/core/types"

describe("parseAliasRef", () => {
  test("openrouter/model-compare/<p> → p for each priority", () => {
    for (const p of ["balanced", "price", "quality"] as Priority[]) {
      expect(parseAliasRef({ providerID: "openrouter", id: `model-compare/${p}` })).toBe(p)
    }
  })

  test("real model ref on openrouter → null", () => {
    expect(parseAliasRef({ providerID: "openrouter", id: "anthropic/x" })).toBeNull()
  })

  test("alias id on another provider → null", () => {
    expect(parseAliasRef({ providerID: "anthropic", id: "model-compare/quality" })).toBeNull()
  })

  test("undefined ref → null", () => {
    expect(parseAliasRef(undefined)).toBeNull()
  })

  test("unknown priority remainder → null", () => {
    expect(parseAliasRef({ providerID: "openrouter", id: "model-compare/coding" })).toBeNull()
  })

  test("extra segment after the priority → null", () => {
    expect(parseAliasRef({ providerID: "openrouter", id: "model-compare/quality/extra" })).toBeNull()
  })

  test("empty remainder → null", () => {
    expect(parseAliasRef({ providerID: "openrouter", id: "model-compare/" })).toBeNull()
  })
})

describe("guardDecision", () => {
  test("primary + alias-configured agent + disabled alias → exact error", () => {
    for (const p of ["balanced", "price", "quality"] as Priority[]) {
      const decision = guardDecision(
        "primary",
        { providerID: "openrouter", id: `model-compare/${p}` },
        () => false,
      )
      expect(decision).toEqual({
        error: `model-compare: no ranking data for openrouter/model-compare/${p}; set options.fallback or check the data source`,
      })
    }
  })

  test("primary + alias-configured agent + enabled alias → no error", () => {
    const decision = guardDecision(
      "primary",
      { providerID: "openrouter", id: "model-compare/price" },
      (enabled) => enabled === "price",
    )
    expect(decision).toEqual({})
  })

  test("primary + disabled for a different priority than the agent's → no error", () => {
    const decision = guardDecision(
      "primary",
      { providerID: "openrouter", id: "model-compare/quality" },
      (enabled) => enabled !== "price",
    )
    expect(decision).toEqual({})
  })

  test("title/compaction/generate kinds → no error even when disabled", () => {
    for (const kind of ["title", "compaction", "generate"]) {
      const decision = guardDecision(
        kind,
        { providerID: "openrouter", id: "model-compare/quality" },
        () => false,
      )
      expect(decision).toEqual({})
    }
  })

  test("primary + agent with a real model ref → no error even when disabled", () => {
    const decision = guardDecision(
      "primary",
      { providerID: "openrouter", id: "anthropic/x" },
      () => false,
    )
    expect(decision).toEqual({})
  })

  test("primary + undefined agent model → no error even when disabled", () => {
    const decision = guardDecision("primary", undefined, () => false)
    expect(decision).toEqual({})
  })
})
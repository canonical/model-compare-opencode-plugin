// tests/unit/usebest.test.ts
// The shared /use-best decision and registry-view helpers (src/opencode/usebest.ts):
// both the server command and the TUI entry consume these, so the messages and
// the enabled/refusal semantics are pinned once, here.

import { describe, expect, it } from "vitest"

import {
  ALIAS_PROVIDER,
  alignedPriority,
  aliasId,
  aliasRef,
  pickFromName,
  pickOf,
  readAliasViews,
  statusLine,
  useBestDecision,
  useBestNotice,
  useBestRefusal,
} from "../../src/opencode/usebest"

describe("useBestDecision", () => {
  const alwaysEnabled = () => true

  it("empty argument resolves to the default priority", () => {
    expect(
      useBestDecision({ argument: "  ", defaultPriority: "quality", enabled: alwaysEnabled }),
    ).toEqual({ ok: true, priority: "quality" })
  })

  it("a priority name wins case-insensitively", () => {
    expect(
      useBestDecision({ argument: " PRICE ", defaultPriority: "balanced", enabled: alwaysEnabled }),
    ).toEqual({ ok: true, priority: "price" })
  })

  it("an unknown priority is refused with the valid names", () => {
    const decision = useBestDecision({
      argument: "cheapest",
      defaultPriority: "balanced",
      enabled: alwaysEnabled,
    })
    expect(decision.ok).toBe(false)
    if (!decision.ok) {
      expect(decision.message).toContain("unknown priority")
      expect(decision.message).toContain("balanced, price, quality")
    }
  })

  it("a disabled alias is refused with the exact refusal text", () => {
    const decision = useBestDecision({
      argument: "quality",
      defaultPriority: "balanced",
      enabled: (p) => p !== "quality",
    })
    expect(decision).toEqual({
      ok: false,
      message: "model-compare: openrouter/model-compare/quality is currently disabled (no ranking data); not switching",
    })
  })
})

describe("messages", () => {
  it("the refusal names the alias ref", () => {
    expect(useBestRefusal("price")).toBe(
      "model-compare: openrouter/model-compare/price is currently disabled (no ranking data); not switching",
    )
  })

  it("the notice carries the current pick, sanitized", () => {
    expect(useBestNotice("balanced", "xiaomi/mimo-v2.6-flash")).toBe(
      "model-compare: switched to openrouter/model-compare/balanced (currently xiaomi/mimo-v2.6-flash)",
    )
    expect(useBestNotice("price", "id\nwith\u0000junk")).not.toMatch(/[\n\u0000]/)
    expect(useBestNotice("quality", null)).toBe(
      "model-compare: switched to openrouter/model-compare/quality (currently unavailable)",
    )
  })

  it("the alias ids/ref use the openrouter provider", () => {
    expect(ALIAS_PROVIDER).toBe("openrouter")
    expect(aliasId("balanced")).toBe("model-compare/balanced")
    expect(aliasRef("price")).toBe("openrouter/model-compare/price")
  })
})

describe("readAliasViews", () => {
  it("keeps only model-compare/<priority> entries, in priority order", () => {
    const views = readAliasViews([
      { id: "openai/gpt-6-luna", name: "GPT" },
      { id: "model-compare/price", name: "Model Compare: price → a/b", enabled: true },
      { id: "model-compare/quality", name: "Model Compare: quality → c/d", enabled: false, modelID: "c/d" },
      { id: "model-compare/balanced", name: "Model Compare: balanced → x/y", enabled: true, modelID: "x/y" },
      { id: "model-compare/nonsense", name: "junk" },
      { id: 42, name: "not a string id" },
    ])
    expect(views.map((v) => v.priority)).toEqual(["balanced", "price", "quality"])
    expect(views[2]).toEqual({
      priority: "quality",
      name: "Model Compare: quality → c/d",
      enabled: false,
      modelID: "c/d",
    })
  })

  it("treats a missing enabled flag as enabled", () => {
    const views = readAliasViews([{ id: "model-compare/balanced", name: "n" }])
    expect(views[0].enabled).toBe(true)
  })
})

describe("alignedPriority", () => {
  it("pads every priority to 'balanced' so the arrows share one column", () => {
    // price gains three spaces, quality one — all arrows land after the
    // eighth column, i.e. the picks line up vertically in the dialog.
    expect(alignedPriority("balanced")).toBe("balanced")
    expect(alignedPriority("price")).toBe("price   ")
    expect(alignedPriority("quality")).toBe("quality ")
  })
})

describe("statusLine", () => {
  it("renders the balanced pick only, with spaced arrows", () => {
    const views = readAliasViews([
      { id: "model-compare/balanced", name: "Model Compare: balanced → xiaomi/mimo-v2.6-flash (fallback)", modelID: "xiaomi/mimo-v2.6-flash" },
      // price: absent from the registry -> disabled (not shown in the line)
      { id: "model-compare/quality", name: "Model Compare: quality (unavailable)", enabled: false },
    ])
    expect(statusLine(views)).toBe("MC: balanced → xiaomi/mimo-v2.6-flash (fallback)")
  })

  it("falls back to the name-derived pick when modelID is absent", () => {
    const views = readAliasViews([
      { id: "model-compare/balanced", name: "Model Compare: balanced → x/y" },
    ])
    expect(statusLine(views)).toBe("MC: balanced → x/y")
  })

  it("reads a missing or disabled balanced alias as disabled", () => {
    expect(statusLine([])).toBe("MC: balanced → disabled")
    expect(
      statusLine(readAliasViews([{ id: "model-compare/balanced", name: "n", enabled: false }])),
    ).toBe("MC: balanced → disabled")
  })

  it("reads a present, enabled alias with no observable pick as unavailable", () => {
    const views = readAliasViews([{ id: "model-compare/balanced", name: "Model Compare: balanced (unavailable)" }])
    expect(statusLine(views)).toBe("MC: balanced → unavailable")
  })
})

describe("pickFromName", () => {
  it("extracts the pick suffix, null without an arrow", () => {
    expect(pickFromName("Model Compare: price → a/b (fallback)")).toBe("a/b (fallback)")
    expect(pickFromName("Model Compare: quality (unavailable)")).toBeNull()
  })
})

describe("pickOf", () => {
  it("flattens catalog-derived picks on the display surface (defense in depth)", () => {
    const [view] = readAliasViews([
      { id: "model-compare/balanced", name: "Model Compare: balanced → x/y\n### pwn", modelID: "x/y\n### pwn" },
    ])
    expect(pickOf(view)).toBe("x/y ### pwn")
  })

  it("keeps the (fallback) marker and the placeholders", () => {
    const [fallback] = readAliasViews([
      { id: "model-compare/price", name: "Model Compare: price → a/b (fallback)", modelID: "a/b" },
    ])
    expect(pickOf(fallback)).toBe("a/b (fallback)")
    const [unavailable] = readAliasViews([
      { id: "model-compare/quality", name: "Model Compare: quality (unavailable)" },
    ])
    expect(pickOf(unavailable)).toBe("unavailable")
    expect(pickOf({ priority: "balanced", name: "", enabled: true, modelID: null })).toBeNull()
  })
})

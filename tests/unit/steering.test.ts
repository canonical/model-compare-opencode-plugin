// tests/unit/steering.test.ts
// The steering decision core (design §Steering injection + served-endpoint
// visibility): alias-scoped steering selection, provider-object injection,
// and the served-endpoint membership verdict — pure functions over the data
// the wiring hooks supply.
import { readFileSync } from "node:fs"
import { describe, expect, test } from "vitest"
import { validateCatalog } from "../../src/core/catalog"
import { gatewayEffort } from "../../src/core/reasoning"
import {
  captureEndpoint,
  injectReasoning,
  injectSteering,
  reasoningEffortFor,
  steeringFor,
} from "../../src/core/steering"
import type { AliasTarget, ModelRef, Steering } from "../../src/core/steering"
import type { ModelEntry, Priority, Reasoning } from "../../src/core/types"

const PICK_ID = "z-ai/glm-5.3-flash"
const ALIAS_REF: ModelRef = { providerID: "openrouter", id: "model-compare/price" }
const DIRECT_REF: ModelRef = { providerID: "openrouter", id: PICK_ID }

const BLOCK: Steering = {
  order: ["streamlake/fp8", "gmicloud/fp8", "novita/fp8"],
  ignore: ["coreweave/nvfp4", "crusoe/fp4"],
  quantizations: ["fp8"],
  allow_fallbacks: true,
}

function entry(opts?: {
  id?: string
  steering?: ModelEntry["steering"]
  qualityEffort?: string | null
  reasoning?: Reasoning
}): ModelEntry {
  return {
    id: opts?.id ?? PICK_ID,
    name: "Synthetic Model",
    pricing: { blended_per_1m: 1 },
    context: 128000,
    quality: null,
    qualityEffort: opts?.qualityEffort ?? null,
    reasoning: opts?.reasoning,
    scores: {
      quality: 0.5,
      price: 0.5,
      context: 0.5,
      age: 0.5,
      overall: { balanced: 0.5, price: 0.5, quality: 0.5 },
    },
    steering: opts?.steering,
  }
}

function catalogOf(...entries: ModelEntry[]): Map<string, ModelEntry> {
  return new Map(entries.map((e) => [e.id, e]))
}

function picksFor(id: string | null, p: Priority = "price"): Partial<Record<Priority, AliasTarget>> {
  return { [p]: { id, fromFallback: false } }
}

describe("steeringFor", () => {
  test("an alias-bound event ref whose pick has steering → the pick's steering block", () => {
    const steering = steeringFor(
      ALIAS_REF,
      PICK_ID,
      picksFor(PICK_ID),
      catalogOf(entry({ steering: BLOCK })),
    )
    expect(steering).toEqual(BLOCK)
  })

  test("no body model supplied → the alias signal alone steers", () => {
    const steering = steeringFor(
      ALIAS_REF,
      undefined,
      picksFor(PICK_ID),
      catalogOf(entry({ steering: BLOCK })),
    )
    expect(steering).toEqual(BLOCK)
  })

  test("a DIRECTLY-PICKED concrete ref whose id equals the pick's id → null (the anti-goal)", () => {
    const steering = steeringFor(
      DIRECT_REF,
      PICK_ID,
      picksFor(PICK_ID),
      catalogOf(entry({ steering: BLOCK })),
    )
    expect(steering).toBeNull()
  })

  test("a supplied body model that differs from the pick's id → null", () => {
    const steering = steeringFor(
      ALIAS_REF,
      "other/model",
      picksFor(PICK_ID),
      catalogOf(entry({ steering: BLOCK })),
    )
    expect(steering).toBeNull()
  })

  test("a pick whose model carries no steering block → null", () => {
    const steering = steeringFor(
      ALIAS_REF,
      PICK_ID,
      picksFor(PICK_ID),
      catalogOf(entry({ steering: undefined })),
    )
    expect(steering).toBeNull()
  })

  test("a disabled alias (no resolved pick id) → null", () => {
    const steering = steeringFor(
      ALIAS_REF,
      PICK_ID,
      picksFor(null),
      catalogOf(entry({ steering: BLOCK })),
    )
    expect(steering).toBeNull()
  })

  test("no pick for the ref's priority → null", () => {
    const steering = steeringFor(
      ALIAS_REF,
      PICK_ID,
      { quality: { id: PICK_ID, fromFallback: false } },
      catalogOf(entry({ steering: BLOCK })),
    )
    expect(steering).toBeNull()
  })

  test("the pick's model missing from the catalog map → null", () => {
    const steering = steeringFor(
      ALIAS_REF,
      PICK_ID,
      picksFor(PICK_ID),
      catalogOf(entry({ id: "other/model", steering: BLOCK })),
    )
    expect(steering).toBeNull()
  })

  test("the alias ref is variant-blind (spike fact 1: --model carries variant 'default')", () => {
    // A variable, not a literal at the call site: the extra `variant` key the
    // real event carries must be ignored by identification, not rejected.
    const withVariant = { ...ALIAS_REF, variant: "default" }
    const steering = steeringFor(
      withVariant,
      PICK_ID,
      picksFor(PICK_ID),
      catalogOf(entry({ steering: BLOCK })),
    )
    expect(steering).toEqual(BLOCK)
  })

  test("an alias-shaped id on another provider → null even with data present", () => {
    const steering = steeringFor(
      { providerID: "anthropic", id: "model-compare/price" },
      PICK_ID,
      picksFor(PICK_ID),
      catalogOf(entry({ steering: BLOCK })),
    )
    expect(steering).toBeNull()
  })

  test("an alias id whose remainder is not a priority → null", () => {
    const steering = steeringFor(
      { providerID: "openrouter", id: "model-compare/coding" },
      PICK_ID,
      picksFor(PICK_ID),
      catalogOf(entry({ steering: BLOCK })),
    )
    expect(steering).toBeNull()
  })

  test("an alias id with an extra segment → null", () => {
    const steering = steeringFor(
      { providerID: "openrouter", id: "model-compare/price/extra" },
      PICK_ID,
      picksFor(PICK_ID),
      catalogOf(entry({ steering: BLOCK })),
    )
    expect(steering).toBeNull()
  })
})

describe("injectSteering", () => {
  test("injects the provider sub-object and preserves the rest of the body", () => {
    const body = { model: PICK_ID, messages: [{ role: "user", content: "hi" }], stream: true }
    const result = injectSteering(body, BLOCK) as Record<string, unknown>
    expect(result).not.toBe(body)
    expect(result.model).toBe(PICK_ID)
    expect(result.stream).toBe(true)
    expect(result.messages).toEqual([{ role: "user", content: "hi" }])
    expect(result.provider).toEqual({
      order: BLOCK.order,
      ignore: BLOCK.ignore,
      quantizations: BLOCK.quantizations,
      allow_fallbacks: true,
    })
    // Purity: the input body is not mutated — the wiring re-creates the
    // Request from the returned object.
    expect(Object.hasOwn(body, "provider")).toBe(false)
  })

  test("a body that already carries provider → untouched (same reference, routing kept)", () => {
    const existing = { order: ["elsewhere/fp4"], ignore: [], allow_fallbacks: false }
    const body = { model: PICK_ID, provider: existing }
    const result = injectSteering(body, BLOCK)
    expect(result).toBe(body)
    expect((result as typeof body).provider).toBe(existing)
  })

  test("the block's top-level model field never leaks into the body", () => {
    // The RAW upstream block shape ({ model, provider }) as a caller might
    // pass it before Task 2's projection: the injection builds the provider
    // object field-by-field, so the extra key cannot ride along.
    const raw = { model: PICK_ID, ...BLOCK } as unknown as Steering
    const result = injectSteering({ model: "ignored" }, raw) as Record<string, unknown>
    const provider = result.provider as Record<string, unknown>
    expect(provider).toEqual({
      order: BLOCK.order,
      ignore: BLOCK.ignore,
      quantizations: BLOCK.quantizations,
      allow_fallbacks: true,
    })
    expect(Object.hasOwn(provider, "model")).toBe(false)
  })

  test("a steering block without quantizations injects a provider object without the key", () => {
    const bare: Steering = { order: ["novita/fp8"], ignore: [], allow_fallbacks: true }
    const result = injectSteering({ model: "m" }, bare) as Record<string, unknown>
    const provider = result.provider as Record<string, unknown>
    expect(provider).toEqual({ order: ["novita/fp8"], ignore: [], allow_fallbacks: true })
    expect(Object.hasOwn(provider, "quantizations")).toBe(false)
  })

  test("a body that is not a JSON object is returned untouched", () => {
    expect(injectSteering(null, BLOCK)).toBeNull()
    expect(injectSteering("body", BLOCK)).toBe("body")
    expect(injectSteering([1, 2], BLOCK)).toEqual([1, 2])
  })
})

describe("reasoningEffortFor", () => {
  test("an alias request whose pick was scored at a gateway effort → that effort", () => {
    expect(
      reasoningEffortFor(
        ALIAS_REF,
        undefined,
        PICK_ID,
        picksFor(PICK_ID),
        catalogOf(entry({ qualityEffort: "high" })),
      ),
    ).toBe("high")
  })

  test("the no-variant sentinel 'default' still injects the catalog effort", () => {
    expect(
      reasoningEffortFor(
        ALIAS_REF,
        "default",
        PICK_ID,
        picksFor(PICK_ID),
        catalogOf(entry({ qualityEffort: "max" })),
      ),
    ).toBe("max")
  })

  test("an explicit #variant selection wins: no effort is injected", () => {
    for (const variant of ["max", "high", "fast"]) {
      expect(
        reasoningEffortFor(
          ALIAS_REF,
          variant,
          PICK_ID,
          picksFor(PICK_ID),
          catalogOf(entry({ qualityEffort: "medium" })),
        ),
      ).toBeNull()
    }
  })

  test("the catalog sentinel 'reasoning' is never sent to the gateway", () => {
    expect(
      reasoningEffortFor(
        ALIAS_REF,
        undefined,
        PICK_ID,
        picksFor(PICK_ID),
        catalogOf(entry({ qualityEffort: "reasoning" })),
      ),
    ).toBeNull()
  })

  test("a v6 catalog pins the pick at its best-selectable-depth effort, not its OpenRouter default", () => {
    // The recorded v0.7.0 contract fixture contains models whose quality was
    // measured at a depth other than their OpenRouter default (upstream 0.7.0
    // scores the best measured selectable depth). The alias body must pin that
    // scored depth — the whole point of reading `quality_effort`.
    const raw = JSON.parse(readFileSync("fixtures/catalog-v0.7.0.json", "utf8"))
    const validated = validateCatalog(raw)
    if (!validated.ok) throw new Error(validated.reason)
    const deep = validated.catalog.models.find(
      (m) =>
        m.qualityEffort !== null &&
        m.reasoning !== undefined &&
        m.reasoning.default_effort !== null &&
        m.qualityEffort !== m.reasoning.default_effort,
    )
    expect(deep, "the v6 fixture carries a model scored off its default depth").toBeDefined()
    if (deep === undefined) return
    const catalog = new Map(validated.catalog.models.map((m) => [m.id, m]))
    expect(
      reasoningEffortFor(ALIAS_REF, undefined, deep.id, picksFor(deep.id), catalog),
    ).toBe(gatewayEffort(deep.qualityEffort))
    expect(gatewayEffort(deep.qualityEffort)).not.toBeNull()
  })

  test("no scored effort → no injection", () => {
    expect(
      reasoningEffortFor(
        ALIAS_REF,
        undefined,
        PICK_ID,
        picksFor(PICK_ID),
        catalogOf(entry({ qualityEffort: null })),
      ),
    ).toBeNull()
  })

  test("non-alias, disabled, mismatched-body and missing-model requests never inject", () => {
    const catalog = catalogOf(entry({ qualityEffort: "high" }))
    expect(reasoningEffortFor(DIRECT_REF, undefined, PICK_ID, picksFor(PICK_ID), catalog)).toBeNull()
    expect(reasoningEffortFor(ALIAS_REF, undefined, PICK_ID, picksFor(null), catalog)).toBeNull()
    expect(
      reasoningEffortFor(ALIAS_REF, undefined, "other/model", picksFor(PICK_ID), catalog),
    ).toBeNull()
    expect(
      reasoningEffortFor(
        ALIAS_REF,
        undefined,
        PICK_ID,
        picksFor(PICK_ID),
        catalogOf(entry({ id: "other/model", qualityEffort: "high" })),
      ),
    ).toBeNull()
  })
})

describe("injectReasoning", () => {
  test("adds a reasoning.effort object and preserves the rest of the body", () => {
    const body = { model: PICK_ID, messages: [{ role: "user", content: "hi" }], stream: true }
    const result = injectReasoning(body, "high") as Record<string, unknown>
    expect(result).not.toBe(body)
    expect(result.model).toBe(PICK_ID)
    expect(result.stream).toBe(true)
    expect(result.reasoning).toEqual({ effort: "high" })
    expect(Object.hasOwn(body, "reasoning")).toBe(false)
  })

  test("a body that already sets reasoning → untouched (user/variant wins)", () => {
    const existing = { effort: "max", exclude: false }
    const body = { model: PICK_ID, reasoning: existing }
    const result = injectReasoning(body, "high")
    expect(result).toBe(body)
    expect((result as typeof body).reasoning).toBe(existing)
  })

  test("a body that already sets the legacy reasoning_effort field → untouched", () => {
    const body = { model: PICK_ID, reasoning_effort: "max" }
    expect(injectReasoning(body, "high")).toBe(body)
  })

  test("a body that is not a JSON object is returned untouched", () => {
    expect(injectReasoning(null, "high")).toBeNull()
    expect(injectReasoning("body", "high")).toBe("body")
    expect(injectReasoning([1, 2], "high")).toEqual([1, 2])
  })
})

describe("captureEndpoint", () => {
  test("a served display name matching an order entry → endpoint recorded, no downgrade", () => {
    expect(captureEndpoint("Novita", ["streamlake/fp8", "novita/fp8", "deepinfra/fp8"])).toEqual({
      endpoint: "Novita",
      downgrade: false,
    })
  })

  test("a served provider matching no order entry → downgrade flagged", () => {
    expect(captureEndpoint("CoreWeave", ["novita/fp8", "deepinfra/fp8"])).toEqual({
      endpoint: "CoreWeave",
      downgrade: true,
    })
  })

  test("a tag-carrying served string matches its identical order entry → no flag", () => {
    expect(captureEndpoint("streamlake/fp8", ["streamlake/fp8", "novita/fp8"])).toEqual({
      endpoint: "streamlake/fp8",
      downgrade: false,
    })
  })

  test("a tag-carrying served string from a different provider → downgrade", () => {
    expect(captureEndpoint("streamlake/fp8", ["novita/fp8"])).toEqual({
      endpoint: "streamlake/fp8",
      downgrade: true,
    })
  })

  test("normalization is case- and punctuation-insensitive (fact 3's worked examples)", () => {
    expect(captureEndpoint("Moonshot AI", ["moonshotai/kimi-k3.1-fp8"]).downgrade).toBe(false)
    expect(captureEndpoint("Atlas Cloud", ["atlas-cloud/fp8"]).downgrade).toBe(false)
    expect(captureEndpoint("DeepInfra", ["deepinfra/fp8/flex"]).downgrade).toBe(false)
    expect(captureEndpoint("Z.AI", ["z-ai/fp8"]).downgrade).toBe(false)
  })

  test("an empty order → the endpoint is recorded, no downgrade", () => {
    expect(captureEndpoint("Novita", [])).toEqual({ endpoint: "Novita", downgrade: false })
  })

  test("a null order (no steering data) → the endpoint is recorded, no downgrade", () => {
    expect(captureEndpoint("Novita", null)).toEqual({ endpoint: "Novita", downgrade: false })
  })

  test("an absent provider → no verdict (nothing recorded, no downgrade)", () => {
    expect(captureEndpoint(null, ["novita/fp8"])).toEqual({ endpoint: null, downgrade: false })
    expect(captureEndpoint(null, null)).toEqual({ endpoint: null, downgrade: false })
  })

  test("an unparseable provider string → no verdict", () => {
    expect(captureEndpoint("", ["novita/fp8"])).toEqual({ endpoint: null, downgrade: false })
    expect(captureEndpoint("   ", ["novita/fp8"])).toEqual({ endpoint: null, downgrade: false })
  })
})

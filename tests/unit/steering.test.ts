// tests/unit/steering.test.ts
// The steering decision core (design §Steering injection + served-endpoint
// visibility): alias-scoped steering selection, provider-object injection,
// and the served-endpoint membership verdict — pure functions over the data
// the wiring hooks supply.
import { describe, expect, test } from "vitest"
import { captureEndpoint, injectSteering, steeringFor } from "../../src/core/steering"
import type { AliasTarget, ModelRef, Steering } from "../../src/core/steering"
import type { ModelEntry, Priority } from "../../src/core/types"

const PICK_ID = "z-ai/glm-5.3-flash"
const ALIAS_REF: ModelRef = { providerID: "openrouter", id: "model-compare/price" }
const DIRECT_REF: ModelRef = { providerID: "openrouter", id: PICK_ID }

const BLOCK: Steering = {
  order: ["streamlake/fp8", "gmicloud/fp8", "novita/fp8"],
  ignore: ["coreweave/nvfp4", "crusoe/fp4"],
  quantizations: ["fp8"],
  allow_fallbacks: true,
}

function entry(opts?: { id?: string; steering?: ModelEntry["steering"] }): ModelEntry {
  return {
    id: opts?.id ?? PICK_ID,
    name: "Synthetic Model",
    pricing: { blended_per_1m: 1 },
    context: 128000,
    quality: null,
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

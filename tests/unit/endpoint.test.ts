// tests/unit/endpoint.test.ts
// The served-endpoint attribute derivation behind the alt+e toast: matching
// the response's provider display name to the catalog's per-endpoint entries,
// comparing the endpoint's quantization to the model's default precision, and
// comparing the requested reasoning effort to the model's default effort.
import { describe, expect, test } from "vitest"
import { endpointInfoFor } from "../../src/core/endpoint"
import { requestedEffortOf } from "../../src/core/steering"
import type { ModelEntry } from "../../src/core/types"

function model(overrides: Partial<ModelEntry> = {}): ModelEntry {
  return {
    id: "acme/alpha",
    name: "Acme Alpha",
    pricing: { blended_per_1m: 0.5 },
    context: 128000,
    quality: 50,
    scores: {
      quality: 0.5,
      price: 0.5,
      context: 0.5,
      age: 0.5,
      overall: { balanced: 0.5, price: 0.5, quality: 0.5 },
    },
    ...overrides,
  }
}

const ENDPOINTS = [
  { providerName: "Novita", tag: "novita/fp8", quantization: "fp8" },
  { providerName: "OpenInference", tag: "open-inference/fp4", quantization: "fp4" },
  { providerName: "HighPrecision", tag: "high-precision/bf16", quantization: "bf16" },
]

describe("endpointInfoFor (the served endpoint's attributes)", () => {
  test("a matching endpoint's quantization is default when it equals the model default", () => {
    const info = endpointInfoFor(
      model({ endpoints: ENDPOINTS, defaultPrecision: "fp8" }),
      "Novita",
      null,
    )
    expect(info.quantization).toEqual({ value: "fp8", relation: "default", default: "fp8" })
  })

  test("a lower quantization is sub-default and names the model default", () => {
    const info = endpointInfoFor(
      model({ endpoints: ENDPOINTS, defaultPrecision: "fp8" }),
      "OpenInference",
      null,
    )
    expect(info.quantization).toEqual({ value: "fp4", relation: "sub-default", default: "fp8" })
  })

  test("a higher quantization is above-default", () => {
    const info = endpointInfoFor(
      model({ endpoints: ENDPOINTS, defaultPrecision: "fp8" }),
      "HighPrecision",
      null,
    )
    expect(info.quantization).toEqual({ value: "bf16", relation: "above-default", default: "fp8" })
  })

  test("a provider with mixed quantizations reports the set as mixed", () => {
    const info = endpointInfoFor(
      model({
        endpoints: [
          { providerName: "Mixed", tag: "mixed/fp8", quantization: "fp8" },
          { providerName: "Mixed", tag: "mixed/fp4", quantization: "fp4" },
        ],
        defaultPrecision: "fp8",
      }),
      "Mixed",
      null,
    )
    expect(info.quantization).toEqual({ value: "fp4/fp8", relation: "mixed", default: "fp8" })
  })

  test("an unknown quantization never claims a relation", () => {
    const info = endpointInfoFor(
      model({
        endpoints: [{ providerName: "Mystery", tag: "mystery", quantization: "unknown" }],
        defaultPrecision: "fp8",
      }),
      "Mystery",
      null,
    )
    expect(info.quantization).toEqual({ value: "unknown", relation: "unknown", default: "fp8" })
  })

  test("a provider absent from the catalog has no quantization", () => {
    const info = endpointInfoFor(
      model({ endpoints: ENDPOINTS, defaultPrecision: "fp8" }),
      "Streamlake",
      null,
    )
    expect(info.quantization).toBeNull()
  })

  test("a tagged-slug served string matches by its provider part", () => {
    const info = endpointInfoFor(
      model({ endpoints: ENDPOINTS, defaultPrecision: "fp8" }),
      "novita/fp8",
      null,
    )
    expect(info.quantization).toEqual({ value: "fp8", relation: "default", default: "fp8" })
  })

  test("a model without a default precision reports unknown", () => {
    const info = endpointInfoFor(
      model({ endpoints: ENDPOINTS, defaultPrecision: null }),
      "Novita",
      null,
    )
    expect(info.quantization).toEqual({ value: "fp8", relation: "unknown", default: null })
  })

  test("the requested effort is compared to the model's default", () => {
    const reasoning = {
      default_effort: "high",
      supported_efforts: ["max", "high", "low"],
      default_enabled: true,
      mandatory: false,
      supports_max_tokens: null,
      depths: [],
    }
    expect(endpointInfoFor(model({ reasoning }), "Novita", "max").effort).toEqual({
      value: "max",
      relation: "above-default",
      default: "high",
    })
    expect(endpointInfoFor(model({ reasoning }), "Novita", "low").effort).toEqual({
      value: "low",
      relation: "sub-default",
      default: "high",
    })
    expect(endpointInfoFor(model({ reasoning }), "Novita", "high").effort).toEqual({
      value: "high",
      relation: "default",
      default: "high",
    })
  })

  test("the verdict follows the canonical order, not the catalog's array order", () => {
    // A hostile/reordered catalogURL can serve supported_efforts shallowest-
    // first. Ranking by that array would call "max" sub-default; the canonical
    // deepest-first order must still say above-default.
    const reasoning = {
      default_effort: "high",
      supported_efforts: ["low", "high", "max"],
      default_enabled: true,
      mandatory: false,
      supports_max_tokens: null,
      depths: [],
    }
    expect(endpointInfoFor(model({ reasoning }), "Novita", "max").effort).toEqual({
      value: "max",
      relation: "above-default",
      default: "high",
    })
    expect(endpointInfoFor(model({ reasoning }), "Novita", "low").effort).toEqual({
      value: "low",
      relation: "sub-default",
      default: "high",
    })
  })

  test("an effort outside a non-empty supported list is unknown", () => {
    const reasoning = {
      default_effort: "high",
      supported_efforts: ["max", "high"],
      default_enabled: true,
      mandatory: false,
      supports_max_tokens: null,
      depths: [],
    }
    expect(endpointInfoFor(model({ reasoning }), "Novita", "low").effort).toEqual({
      value: "low",
      relation: "unknown",
      default: "high",
    })
  })

  test("a missing requested effort reports the model default", () => {
    const reasoning = {
      default_effort: "high",
      supported_efforts: ["max", "high"],
      default_enabled: true,
      mandatory: false,
      supports_max_tokens: null,
      depths: [],
    }
    expect(endpointInfoFor(model({ reasoning }), "Novita", null).effort).toEqual({
      value: "high",
      relation: "default",
      default: "high",
    })
  })

  test("an effort outside the supported list is unknown", () => {
    const reasoning = {
      default_effort: "high",
      supported_efforts: ["max", "high"],
      default_enabled: true,
      mandatory: false,
      supports_max_tokens: null,
      depths: [],
    }
    expect(endpointInfoFor(model({ reasoning }), "Novita", "xhigh").effort).toEqual({
      value: "xhigh",
      relation: "unknown",
      default: "high",
    })
  })

  test("a model without reasoning has no effort", () => {
    expect(endpointInfoFor(model(), "Novita", "max").effort).toBeNull()
  })

  test("an unknown model has no attributes", () => {
    expect(endpointInfoFor(undefined, "Novita", "max")).toEqual({
      quantization: null,
      effort: null,
    })
  })
})

describe("requestedEffortOf (the capture's effort)", () => {
  test("the body's reasoning.effort wins", () => {
    expect(requestedEffortOf({ reasoning: { effort: "max" } }, "low", "high")).toBe("max")
  })

  test("the legacy reasoning_effort wins", () => {
    expect(requestedEffortOf({ reasoning_effort: "low" }, "max", "high")).toBe("low")
  })

  test("the injected effort is used when the body has none", () => {
    expect(requestedEffortOf({}, undefined, "high")).toBe("high")
  })

  test("an explicit variant is used when nothing was injected", () => {
    expect(requestedEffortOf({}, "max", null)).toBe("max")
  })

  test("the 'default' variant is not an effort", () => {
    expect(requestedEffortOf({}, "default", null)).toBeNull()
  })

  test("nothing known reads as null", () => {
    expect(requestedEffortOf(undefined, undefined, null)).toBeNull()
  })
})

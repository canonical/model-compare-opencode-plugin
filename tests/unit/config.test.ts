// tests/unit/config.test.ts
// Option parsing (design §3): every violation warns and applies the default
// (or drops the offending piece); valid values pass through untouched and
// parseConfig never throws, whatever shape arrives.
import { parseConfig, type Config } from "../../src/config"

const DEFAULT_CATALOG_URL = "https://canonical.github.io/model-compare/catalog.json"

function defaults(): Config {
  return {
    source: "auto",
    defaultPriority: "balanced",
    fallback: null,
    weights: {},
    pinDays: 14,
    minLead: 0.03,
    catalogURL: DEFAULT_CATALOG_URL,
    scriptPath: null,
  }
}

const VALID: Config = {
  source: "local",
  defaultPriority: "quality",
  fallback: "openrouter/anthropic/claude-sonnet-4.5",
  weights: { balanced: { quality: 0.5, price: 0.3 }, price: { price: 1 } },
  pinDays: 7.5, // fractional days are fine
  minLead: 0.05,
  catalogURL: "https://example.com/catalog.json",
  scriptPath: "/tmp/model_compare.py",
}

describe("parseConfig — valid input", () => {
  test("raw undefined yields all defaults and no warnings", () => {
    const { config, warnings } = parseConfig(undefined)
    expect(config).toEqual(defaults())
    expect(warnings).toEqual([])
  })

  test("a full valid config passes through unchanged with no warnings", () => {
    const { config, warnings } = parseConfig(VALID)
    expect(config).toEqual(VALID)
    expect(warnings).toEqual([])
  })
})

describe("parseConfig — per-option validation", () => {
  test("unknown or non-string source falls back to auto with a warning naming source", () => {
    for (const bad of ["pigeon", 42]) {
      const { config, warnings } = parseConfig({ source: bad })
      expect(config).toEqual(defaults())
      expect(warnings.length).toBe(1)
      expect(warnings.join(" ")).toMatch(/source/)
    }
  })

  test("unknown or non-string defaultPriority falls back to balanced with a warning", () => {
    for (const bad of ["cheapest", 3]) {
      const { config, warnings } = parseConfig({ defaultPriority: bad })
      expect(config).toEqual(defaults())
      expect(warnings.length).toBe(1)
      expect(warnings.join(" ")).toMatch(/defaultPriority/)
    }
  })

  test("a fallback without the openrouter/ prefix is treated as unset with a warning", () => {
    const { config, warnings } = parseConfig({ fallback: "anthropic/claude-sonnet-4.5" })
    expect(config).toEqual(defaults())
    expect(warnings.length).toBe(1)
    expect(warnings.join(" ")).toMatch(/fallback/)
  })

  test("a fallback with an empty id, a '#', or a non-string value is treated as unset", () => {
    for (const bad of ["openrouter/", "openrouter/a#b", 42]) {
      const { config, warnings } = parseConfig({ fallback: bad })
      expect(config).toEqual(defaults())
      expect(warnings.length).toBe(1)
      expect(warnings.join(" ")).toMatch(/fallback/)
    }
  })

  test("explicit null fallback and scriptPath are accepted silently", () => {
    const { config, warnings } = parseConfig({ fallback: null, scriptPath: null })
    expect(config.fallback).toBeNull()
    expect(config.scriptPath).toBeNull()
    expect(warnings).toEqual([])
  })

  test("unknown priority names in weights are dropped, one warning each", () => {
    const { config, warnings } = parseConfig({
      weights: { cheap: { quality: 1 }, balanced: { quality: 0.5 } },
    })
    expect(config.weights).toEqual({ balanced: { quality: 0.5 } })
    expect(warnings.length).toBe(1)
    expect(warnings.join(" ")).toMatch(/cheap/)
  })

  test("unknown weight keys are dropped, one warning each, valid keys kept", () => {
    const { config, warnings } = parseConfig({
      weights: { balanced: { quality: 0.5, speed: 1, taste: 2 } },
    })
    expect(config.weights).toEqual({ balanced: { quality: 0.5 } })
    expect(warnings.length).toBe(2)
    expect(warnings.join(" ")).toMatch(/speed/)
    expect(warnings.join(" ")).toMatch(/taste/)
  })

  test("negative, non-numeric, and non-finite weight values are dropped", () => {
    const { config, warnings } = parseConfig({
      weights: {
        balanced: {
          quality: "high",
          price: -1,
          context: Number.NaN,
          age: Number.POSITIVE_INFINITY,
        },
      },
    })
    expect(config.weights).toEqual({})
    expect(warnings.length).toBe(4)
    expect(warnings.join(" ")).toMatch(/quality/)
    expect(warnings.join(" ")).toMatch(/price/)
    expect(warnings.join(" ")).toMatch(/context/)
    expect(warnings.join(" ")).toMatch(/age/)
  })

  test("a non-object weights value collapses to {} with a warning", () => {
    for (const bad of ["nope", 7, null, [1, 2]]) {
      const { config, warnings } = parseConfig({ weights: bad })
      expect(config.weights).toEqual({})
      expect(warnings.length).toBe(1)
      expect(warnings.join(" ")).toMatch(/weights/)
    }
  })

  test("a non-object override for a known priority is dropped with a warning", () => {
    const { config, warnings } = parseConfig({ weights: { balanced: 5 } })
    expect(config.weights).toEqual({})
    expect(warnings.length).toBe(1)
    expect(warnings.join(" ")).toMatch(/balanced/)
  })

  test("an override whose keys are all dropped leaves no empty entry behind", () => {
    const { config, warnings } = parseConfig({ weights: { balanced: { speed: 1 } } })
    expect(config.weights).toEqual({})
    expect(warnings.length).toBe(1)
  })

  test("non-positive or non-numeric pinDays falls back to 14 with a warning", () => {
    for (const bad of [0, -1, "14", Number.NaN]) {
      const { config, warnings } = parseConfig({ pinDays: bad })
      expect(config).toEqual(defaults())
      expect(warnings.length).toBe(1)
      expect(warnings.join(" ")).toMatch(/pinDays/)
    }
  })

  test("out-of-range or non-numeric minLead falls back to 0.03 with a warning", () => {
    for (const bad of [-0.1, 1.5, "0.5", Number.NaN]) {
      const { config, warnings } = parseConfig({ minLead: bad })
      expect(config).toEqual(defaults())
      expect(warnings.length).toBe(1)
      expect(warnings.join(" ")).toMatch(/minLead/)
    }
  })

  test("minLead at the boundaries 0 and 1 is kept", () => {
    expect(parseConfig({ minLead: 0 }).config.minLead).toBe(0)
    expect(parseConfig({ minLead: 1 }).config.minLead).toBe(1)
    expect(parseConfig({ minLead: 0 }).warnings).toEqual([])
    expect(parseConfig({ minLead: 1 }).warnings).toEqual([])
  })

  test("a non-https catalogURL falls back to the published catalog with a warning", () => {
    for (const bad of ["http://example.com/catalog.json", "ftp://example.com/cat.json", 42]) {
      const { config, warnings } = parseConfig({ catalogURL: bad })
      expect(config).toEqual(defaults())
      expect(warnings.length).toBe(1)
      expect(warnings.join(" ")).toMatch(/catalogURL/)
    }
  })

  test("a non-string scriptPath falls back to null with a warning", () => {
    const { config, warnings } = parseConfig({ scriptPath: 42 })
    expect(config).toEqual(defaults())
    expect(warnings.length).toBe(1)
    expect(warnings.join(" ")).toMatch(/scriptPath/)
  })

  test("an empty-string scriptPath falls back to null with a warning", () => {
    const { config, warnings } = parseConfig({ scriptPath: "" })
    expect(config.scriptPath).toBeNull()
    expect(warnings.length).toBe(1)
    expect(warnings.join(" ")).toMatch(/scriptPath/)
  })

  test("unknown top-level option keys are ignored silently", () => {
    const { config, warnings } = parseConfig({ futureOption: { nested: true }, another: 1 })
    expect(config).toEqual(defaults())
    expect(warnings).toEqual([])
  })
})

describe("parseConfig — never throws", () => {
  test("garbage inputs collapse to defaults without warnings", () => {
    for (const garbage of [null, 0, "nope", true, [], {}, new Date()]) {
      const { config, warnings } = parseConfig(garbage)
      expect(config).toEqual(defaults())
      expect(warnings).toEqual([])
    }
  })

  test("every field violated at once warns per option and still returns full defaults", () => {
    const { config, warnings } = parseConfig({
      source: 0,
      defaultPriority: 0,
      fallback: 0,
      weights: { balanced: 0, cheap: 0 },
      pinDays: {},
      minLead: [],
      catalogURL: {},
      scriptPath: {},
    })
    expect(config).toEqual(defaults())
    // source, defaultPriority, fallback, weights (balanced + cheap), pinDays,
    // minLead, catalogURL, scriptPath — one warning each.
    expect(warnings.length).toBe(9)
    const all = warnings.join(" ")
    expect(all).toMatch(/source/)
    expect(all).toMatch(/defaultPriority/)
    expect(all).toMatch(/fallback/)
    expect(all).toMatch(/weights/)
    expect(all).toMatch(/pinDays/)
    expect(all).toMatch(/minLead/)
    expect(all).toMatch(/catalogURL/)
    expect(all).toMatch(/scriptPath/)
  })

  test("circular structures do not throw, even inside violated options", () => {
    const circular: { self?: unknown } = {}
    circular.self = circular
    const { config, warnings } = parseConfig({
      weights: { balanced: { quality: circular } },
      catalogURL: circular,
    })
    expect(config).toEqual(defaults())
    expect(warnings.length).toBe(2)
  })
})
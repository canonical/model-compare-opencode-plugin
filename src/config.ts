// src/config.ts
// Plugin option parsing (design §3): warn-and-default validation over the
// raw `options` object OpenCode hands the plugin. Any violation logs a
// warning naming the option and applies the default (or drops the offending
// piece); absent options apply their default silently. Never throws —
// whatever shape arrives collapses to a usable Config.
//
// Absent-vs-invalid: an option OpenCode didn't set (`undefined`) simply takes
// its default without a warning — nothing was misconfigured, and a bare
// `plugins` entry without `options` must stay quiet. A value that IS present
// but invalid warns. `fallback` and `scriptPath` additionally accept explicit
// `null` as a valid "unset" (their §3 rows list `null` as legal).

import type { Priority, Weights } from "./core/types"

export type Config = {
  source: "auto" | "local" | "remote"
  defaultPriority: Priority
  // "openrouter/<id>" (§3) or null.
  fallback: string | null
  weights: Partial<Record<Priority, Partial<Weights>>>
  pinDays: number // default 14
  minLead: number // default 0.03
  catalogURL: string // default "https://model-compare.dev/catalog.json"
  scriptPath: string | null // null → vendored copy
}

const SOURCES = ["auto", "local", "remote"] as const
const PRIORITIES = ["balanced", "price", "quality"] as const
const WEIGHT_KEYS = ["quality", "price", "context", "age"] as const

// The published catalog's direct https URL — no redirect involved (the old
// canonical.github.io home redirected to a plaintext http target, which
// fetchRemote now refuses; see Ruling 9).
const DEFAULT_CATALOG_URL = "https://model-compare.dev/catalog.json"
const FALLBACK_PREFIX = "openrouter/"

// True for plain config objects. Arrays are excluded: their index keys are
// never meaningful option names, so they warn like any other garbage.
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

// A safe rendering of an offending value for warning messages. Deliberately
// avoids JSON.stringify, which throws on circular structures.
function shown(v: unknown): string {
  if (typeof v === "string") return `"${v}"`
  if (typeof v === "object" && v !== null) return Array.isArray(v) ? "an array" : "an object"
  if (typeof v === "function") return "a function"
  return String(v)
}

function isEnumValue(v: unknown, names: readonly string[]): v is string {
  return typeof v === "string" && (names as readonly string[]).includes(v)
}

export function parseConfig(raw: unknown): { config: Config; warnings: string[] } {
  const warnings: string[] = []
  const o: Record<string, unknown> = isPlainObject(raw) ? raw : {}

  // source — one of the three names (§3).
  let source: Config["source"] = "auto"
  if (o.source !== undefined) {
    if (isEnumValue(o.source, SOURCES)) {
      source = o.source as Config["source"]
    } else {
      warnings.push(
        `invalid source: ${shown(o.source)} is not one of "auto", "local", "remote"; using "auto"`,
      )
    }
  }

  // defaultPriority — one of the three Priority names.
  let defaultPriority: Priority = "balanced"
  if (o.defaultPriority !== undefined) {
    if (isEnumValue(o.defaultPriority, PRIORITIES)) {
      defaultPriority = o.defaultPriority as Priority
    } else {
      warnings.push(
        `invalid defaultPriority: ${shown(o.defaultPriority)} is not one of` +
          ` "balanced", "price", "quality"; using "balanced"`,
      )
    }
  }

  // fallback — "openrouter/<id>" with a non-empty, "#"-free remainder (§3),
  // or unset. Explicit null counts as unset.
  let fallback: string | null = null
  const rawFallback = o.fallback
  if (rawFallback !== undefined && rawFallback !== null) {
    if (
      typeof rawFallback === "string" &&
      rawFallback.startsWith(FALLBACK_PREFIX) &&
      rawFallback.length > FALLBACK_PREFIX.length &&
      !rawFallback.includes("#")
    ) {
      fallback = rawFallback
    } else {
      warnings.push(
        `invalid fallback: ${shown(rawFallback)} is not "openrouter/<model-id>"; treating it as unset`,
      )
    }
  }

  // weights — partial overrides per named priority. Unknown priority names,
  // unknown weight keys, and values that aren't finite numbers ≥ 0 are
  // dropped individually; the valid remainder is kept. An override whose
  // keys all drop leaves no entry behind: an empty override would change
  // downstream ranking semantics (§6) despite overriding nothing.
  const weights: Config["weights"] = {}
  const rawWeights = o.weights
  if (rawWeights !== undefined) {
    if (!isPlainObject(rawWeights)) {
      warnings.push(
        `invalid weights: ${shown(rawWeights)} is not an object; ignoring all weight overrides`,
      )
    } else {
      for (const [priority, override] of Object.entries(rawWeights)) {
        if (!isEnumValue(priority, PRIORITIES)) {
          warnings.push(`invalid weights: unknown priority "${priority}"; dropping its override`)
          continue
        }
        if (!isPlainObject(override)) {
          warnings.push(
            `invalid weights.${priority}: ${shown(override)} is not an object; dropping the override`,
          )
          continue
        }
        const kept: Partial<Weights> = {}
        for (const [key, value] of Object.entries(override)) {
          if (!isEnumValue(key, WEIGHT_KEYS)) {
            warnings.push(`invalid weights.${priority}: unknown weight key "${key}"; dropping it`)
            continue
          }
          if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
            warnings.push(
              `invalid weights.${priority}.${key}: ${shown(value)} is not a number ≥ 0; dropping it`,
            )
            continue
          }
          kept[key as keyof Weights] = value
        }
        if (Object.keys(kept).length > 0) weights[priority as Priority] = kept
      }
    }
  }

  // pinDays — a finite number > 0; fractional days are fine.
  let pinDays = 14
  if (o.pinDays !== undefined) {
    const v = o.pinDays
    if (typeof v === "number" && Number.isFinite(v) && v > 0) {
      pinDays = v
    } else {
      warnings.push(`invalid pinDays: ${shown(v)} is not a positive number; using 14`)
    }
  }

  // minLead — a finite number in [0, 1].
  let minLead = 0.03
  if (o.minLead !== undefined) {
    const v = o.minLead
    if (typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1) {
      minLead = v
    } else {
      warnings.push(`invalid minLead: ${shown(v)} is not a number between 0 and 1; using 0.03`)
    }
  }

  // catalogURL — an "https://" URL; anything else gets the published catalog.
  let catalogURL = DEFAULT_CATALOG_URL
  if (o.catalogURL !== undefined) {
    const v = o.catalogURL
    if (typeof v === "string" && v.startsWith("https://")) {
      catalogURL = v
    } else {
      warnings.push(
        `invalid catalogURL: ${shown(v)} is not an "https://" URL; using the published catalog`,
      )
    }
  }

  // scriptPath — a non-empty string, or unset/null for the vendored copy.
  let scriptPath: string | null = null
  const rawScriptPath = o.scriptPath
  if (rawScriptPath !== undefined && rawScriptPath !== null) {
    if (typeof rawScriptPath === "string" && rawScriptPath.length > 0) {
      scriptPath = rawScriptPath
    } else {
      warnings.push(
        `invalid scriptPath: ${shown(rawScriptPath)} is not a non-empty string; using the vendored copy`,
      )
    }
  }

  return {
    config: { source, defaultPriority, fallback, weights, pinDays, minLead, catalogURL, scriptPath },
    warnings,
  }
}
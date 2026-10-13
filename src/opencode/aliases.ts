// src/opencode/aliases.ts
// Alias plan computation (design §8, §9). The plan is pure data: what alias to
// point at, what to call it, and whether it can be enabled at all. Copying the
// concrete model's capabilities/limit/cost/variants/time/status onto the alias
// is the applier's job (it reads them through editor.get), so this module never
// touches model internals.

import type { ModelEntry, Priority } from "../core/types"
import { sanitizeCatalogText } from "./commands"

// The resolved pick for a priority: the winning model's id, or null when
// resolution found nothing (§9). `fromFallback` marks a pick that came from a
// curated ranking rather than the scored ordering.
export type AliasTarget = { id: string | null; fromFallback: boolean }

// What the applier needs to know about one alias.
export type AliasPlan = {
  modelID: string | null
  name: string
  enabled: boolean
  warnings: string[]
}

// §8 rule: a missing pick model DISABLES the alias with a warning — it is never
// silently skipped. `model` is undefined when the pick's model was removed by
// another plugin, or when there is no catalog to look it up in.
export function planAlias(
  p: Priority,
  target: AliasTarget,
  model: ModelEntry | undefined,
): AliasPlan {
  if (target.id === null) {
    return {
      modelID: null,
      name: `Model Compare: ${p} (unavailable)`,
      enabled: false,
      warnings: [`no pick resolved for ${p}`],
    }
  }
  if (model === undefined) {
    return {
      modelID: null,
      name: `Model Compare: ${p} (unavailable)`,
      enabled: false,
      warnings: [`pick model ${target.id} missing from catalog for ${p}`],
    }
  }
  return {
    modelID: target.id,
    // The pick in the display name is flattened (F-20): `target.id` is
    // catalog-derived and the name surfaces in the model picker, the TUI
    // status line and dialogs. `modelID` stays RAW — switching needs the
    // real id.
    name: `Model Compare: ${p} → ${sanitizeCatalogText(target.id)}${target.fromFallback ? " (fallback)" : ""}`,
    enabled: true,
    warnings: [],
  }
}

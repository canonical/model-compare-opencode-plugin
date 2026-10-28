// src/opencode/aliases.ts
// Alias plan computation (design §8, §9). The plan is pure data: what alias to
// point at, what to call it, and whether it can be enabled at all. Copying the
// concrete model's capabilities/limit/cost/variants/time/status onto the alias
// is the applier's job (it reads them through editor.get), so this module never
// touches model internals.

import { formatDepthAlternative } from "../core/reasoning"
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
//
// `displayModel` is the CATALOG entry for the same pick: the applier's
// presence proof is the editor's concrete model (which carries no ranking
// metadata), so the effort/alternative label reads the catalog entry instead.
// Absent (a fallback pick with no catalog, or a caller that has only the
// editor model) falls back to `model`.
export function planAlias(
  p: Priority,
  target: AliasTarget,
  model: ModelEntry | undefined,
  displayModel?: ModelEntry,
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
  // The effort the pick's score represents, followed by the best measured
  // selectable alternative (catalog v5). Both are catalog-derived and
  // flattened (F-20) for the model picker, the TUI status line and dialogs;
  // `modelID` stays RAW — switching needs the real id.
  const shown = displayModel ?? model
  const effort =
    shown.qualityEffort == null ? "" : ` · ${sanitizeCatalogText(shown.qualityEffort)}`
  const alternative = formatDepthAlternative(shown)
  return {
    modelID: target.id,
    name: `Model Compare: ${p} → ${sanitizeCatalogText(target.id)}${effort}${
      target.fromFallback ? " (fallback)" : ""
    }${alternative === "" ? "" : ` [alt ${sanitizeCatalogText(alternative)}]`}`,
    enabled: true,
    warnings: [],
  }
}

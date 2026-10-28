// src/opencode/usebest.ts
// Shared /use-best decision + alias-view helpers (design §10). Pure module:
// no OpenCode imports, no I/O. Both the server command (src/index.ts) and the
// TUI entry (src/tui.tsx) consume it, so their decisions and messages can
// never drift apart.

import { parseUseBest, sanitizeCatalogText } from "./commands"
import type { Priority } from "../core/types"

export const PRIORITIES: readonly Priority[] = ["balanced", "price", "quality"]
export const ALIAS_PROVIDER = "openrouter"
export const aliasId = (p: Priority): string => `model-compare/${p}`
export const aliasRef = (p: Priority): string => `${ALIAS_PROVIDER}/${aliasId(p)}`

// The headless refusal text (§10; pinned by the integration suite's
// REFUSAL_TEXT).
export function useBestRefusal(p: Priority): string {
  return `model-compare: ${aliasRef(p)} is currently disabled (no ranking data); not switching`
}

// The switch notice: the pick shown is the one the alias serves right now (a
// pin can differ from rank 1 — minLead hysteresis), sanitized (F-20); "null"
// means the caller could not observe a pick and says "unavailable".
export function useBestNotice(p: Priority, currentPickId: string | null): string {
  const pick = currentPickId === null ? "unavailable" : sanitizeCatalogText(currentPickId)
  return `model-compare: switched to ${aliasRef(p)} (currently ${pick})`
}

// The full decision for a /use-best invocation: argument parsing plus the
// enabled gate. `enabled` is the caller's registry view of each priority —
// the server command reads state.enabled, the TUI entry reads the model
// registry (which omits disabled aliases in some states and reports
// `enabled: false` in others; absence is read as disabled by the caller).
export function useBestDecision(input: {
  argument: string
  defaultPriority: Priority
  enabled: (p: Priority) => boolean
}): { ok: true; priority: Priority } | { ok: false; message: string } {
  const parsed = parseUseBest(input.argument, input.defaultPriority)
  if (!parsed.ok) return parsed
  if (!input.enabled(parsed.priority)) {
    return { ok: false, message: useBestRefusal(parsed.priority) }
  }
  return parsed
}

// ---- registry views (the TUI side's data source) ---------------------------

// One model-compare alias as observed in the model registry.
export type AliasView = {
  priority: Priority
  name: string
  enabled: boolean
  modelID: string | null
}

// Extract the plugin's alias entries from a model-list response. Only entries
// present in the list are returned; a disabled alias is either omitted
// entirely or reported with enabled: false — callers must treat a missing
// view as disabled (probe-verified: list() omits disabled aliases).
export function readAliasViews(
  entries: ReadonlyArray<{ id?: unknown; name?: unknown; enabled?: unknown; modelID?: unknown }>,
): AliasView[] {
  const prefix = "model-compare/"
  const views: AliasView[] = []
  for (const entry of entries) {
    if (typeof entry.id !== "string" || !entry.id.startsWith(prefix)) continue
    const priority = entry.id.slice(prefix.length)
    if (!PRIORITIES.includes(priority as Priority)) continue
    views.push({
      priority: priority as Priority,
      name: typeof entry.name === "string" ? entry.name : "",
      enabled: entry.enabled !== false,
      modelID: typeof entry.modelID === "string" ? entry.modelID : null,
    })
  }
  return views.sort(
    (x, y) => PRIORITIES.indexOf(x.priority) - PRIORITIES.indexOf(y.priority),
  )
}

// The pick shown in an alias's display name:
// "Model Compare: <p> → <pick>[ (fallback)]" → "<pick>[ (fallback)]", or null
// for the "(unavailable)" placeholder names. Older v5 names appended the
// scored effort and the best alternative (" · high [alt max 56.0]") after the
// pick; those annotations are no longer written, but remain stripped so a
// registry entry left by an older plugin still names the served model.
export function pickFromName(name: string): string | null {
  const arrow = name.indexOf("→")
  if (arrow === -1) return null
  const rest = name.slice(arrow + 1).replace(/ \[alt .*\]$/, "")
  // Legacy v5 names (no longer written — see above) separated the pick from
  // its annotations with " · "; OpenRouter ids contain no spaces, so the
  // first segment is the pick. The fallback marker lives in the annotation
  // segment (or already after a pick with no annotations), so carry it over
  // exactly once.
  const [pick, ...annotations] = rest.split(" · ")
  const fallback = annotations.join(" ").includes("(fallback)") ? " (fallback)" : ""
  return `${pick.trim()}${fallback}`
}

// The pick an ENABLED alias view serves, or null when nothing observable is
// served: the display name is the truth (it mirrors the picker, including
// the "(fallback)" marker); modelID is the fallback when the name has no
// arrow; an empty name is also "nothing observable". Exported for the TUI
// half's picks dialog (statusLine's rules, one priority at a time). The
// result is a DISPLAY string only (footer, dialog, toasts) and is flattened
// here (F-20) as defense in depth: the name is normally built sanitized by
// planAlias, but modelID is registry-sourced and can carry raw catalog text.
export function pickOf(view: AliasView): string | null {
  const pick = pickFromName(view.name) ?? view.modelID ?? (view.name === "" ? null : "unavailable")
  return pick === null ? null : sanitizeCatalogText(pick)
}

// The priority column width for aligned pick rows: the longest priority
// name ("balanced"), so every arrow — and the pick after it — starts at the
// same column in the picks dialog: `price` gains three spaces before its
// arrow, `quality` one.
export function alignedPriority(priority: Priority): string {
  return priority.padEnd(Math.max(...PRIORITIES.map((p) => p.length)))
}

// The compact footer line — the balanced pick only, e.g.
// `MC: balanced → xiaomi/mimo-v2.6-flash`. The full three-priority view
// lives behind the picks dialog (a select over the alias views);
// registry-absent and disabled aliases read "disabled", a present-but-
// unresolvable one reads "unavailable" — the line never vanishes.
export function statusLine(views: AliasView[]): string {
  const view = views.find((item) => item.priority === "balanced")
  if (view === undefined || view.enabled === false) return "MC: balanced → disabled"
  return `MC: balanced → ${pickOf(view) ?? "unavailable"}`
}

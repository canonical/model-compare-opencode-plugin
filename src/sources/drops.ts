// src/sources/drops.ts
// Acquisition diagnostics (final-review BUG-02): since upstream 0.4.0 the
// vendored script can drop models at its endpoint-pricing stage when their
// endpoint fetch fails (retries exhausted), reporting it in the raw
// document's `pool.dropped` map under `endpoint_fetch_failed`. The catalog
// projection discards that field, so without this check a cold-cache run on
// a degraded network silently serves a smaller pool — and the smaller pool
// can change which model a pin switches to. The warning travels in
// Acquired.warnings, which the refresh tick logs.
//
// Scope (orchestrator ruling on the fix-wave-2 brief): `pool.dropped` also
// carries the by-design funnel drops (a healthy 468-listed run reports
// ~397 models dropped for context/pricing/batch/ZDR/... to reach its 71
// candidates). Only `endpoint_fetch_failed` signals a degraded-network
// shrink; warning on the funnel would fire on every healthy run. Limitation
// (README, Troubleshooting): under `opencode serve` plugin console output
// reaches no log — this is diagnostics for contexts that see plugin output,
// not a user-visible alarm.

// Reads the raw upstream document's `pool.dropped` map and returns one
// warning string when models were dropped at the endpoint stage. Defensive
// at every step: a document without a well-formed pool.dropped emits nothing
// (the warning is best-effort diagnostics, never a validation gate).
export function dropWarningsFromRaw(raw: unknown): string[] {
  if (typeof raw !== "object" || raw === null) return []
  const pool = (raw as { pool?: unknown }).pool
  if (typeof pool !== "object" || pool === null) return []
  const dropped = (pool as { dropped?: unknown }).dropped
  if (typeof dropped !== "object" || dropped === null) return []
  const endpointFailed = (dropped as Record<string, unknown>).endpoint_fetch_failed
  if (typeof endpointFailed !== "number" || !Number.isFinite(endpointFailed) || endpointFailed <= 0) {
    return []
  }
  return [
    `catalog pool shrunk: ${endpointFailed} model(s) dropped at the endpoint stage (endpoint_fetch_failed: ${endpointFailed})`,
  ]
}

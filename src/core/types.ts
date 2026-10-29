// src/core/types.ts
// Shared vocabulary for the plugin's core (design §4): pure types plus the
// pinned-tag weight defaults. No OpenCode imports, no I/O.

export type Priority = "balanced" | "price" | "quality"

export type Weights = { quality: number; price: number; context: number; age: number }

// One measured reasoning effort (catalog v6): the AA intelligence index at
// that effort, AA's reference-price benchmark cost per task (display-only,
// never scored), and the record's provenance. `null` marks a missing value;
// the record itself survives so the effort can still be offered as a variant.
export type ReasoningDepth = {
  effort: string
  index: number | null
  cost_per_task_usd: number | null
  source: string | null
  as_of: string | null
}

// The v6 per-model reasoning block. `supported_efforts` is what OpenRouter
// accepts as a discrete effort (expanded upstream, never null); `depths` is
// what some source measured (empty when nothing did). The raw flags are kept
// for provenance and for the single-state/non-reasoning display rules.
export type Reasoning = {
  default_effort: string | null
  supported_efforts: string[]
  default_enabled: boolean | null
  mandatory: boolean | null
  supports_max_tokens: boolean | null
  depths: ReasoningDepth[]
}

export type ModelEntry = {
  id: string
  name: string
  // The raw catalog carries the effective-tier input/output split alongside
  // the blended value; validation copies the split through only when it is a
  // finite number (anything else is dropped to undefined), so the split
  // survives at runtime (optional for older/narrow documents).
  pricing: {
    input_per_1m?: number
    output_per_1m?: number
    blended_per_1m: number
  }
  context: number
  quality: number | null
  // The effort `quality` was measured at (catalog v6 `quality_effort`) — the
  // best measured selectable depth, which may differ from `default_effort`. The
  // alias request pins exactly this effort; the sentinel "reasoning" is a
  // catalog label, never a gateway value. Optional only for hand-built /
  // legacy projected entries: validateCatalog always writes it (null or a
  // string), and validateStoredCatalog requires it on cached records.
  qualityEffort?: string | null
  // Present when the raw block projects cleanly (absent stays absent).
  reasoning?: Reasoning
  // The steering block (F-11/F-12): upstream records the provider's
  // endpoint-routing hints as { model, provider: { order, ignore,
  // quantizations?, allow_fallbacks } }; the projection unwraps the provider
  // sub-object into this shape and never projects the top-level `model`.
  // Present only when the raw block projects cleanly (absent stays absent).
  steering?: {
    order: string[]
    ignore: string[]
    quantizations?: string[]
    allow_fallbacks: boolean
  }
  scores: {
    quality: number
    price: number
    context: number
    age: number
    overall: Record<Priority, number>
  }
}

export type Catalog = {
  generatedAt: string
  weights: Partial<Record<Priority, Partial<Weights>>>
  rankings: Partial<Record<Priority, string[]>>
  models: ModelEntry[]
}

// Upstream's PRIORITY_WEIGHTS at the pinned tag (v0.7.0; unchanged since v0.3.0). Used when a
// document carries no `parameters.weights` at all (design §5); individual
// missing keys fall back to weight 0 instead.
export const DEFAULT_WEIGHTS: Record<Priority, Weights> = {
  balanced: { quality: 0.4, price: 0.4, context: 0.1, age: 0.1 },
  price: { quality: 0.2, price: 0.6, context: 0.1, age: 0.1 },
  quality: { quality: 0.6, price: 0.2, context: 0.1, age: 0.1 },
}

// A validated catalog plus when the plugin itself accepted it. The plugin's
// own clock, not `generated_at`, is the data age (design §5, §9).
export type Sourced = { doc: Catalog; acquiredAt: number }

// The served-endpoint capture record (design §Steering visibility): what the
// http.response hook wrote for one session's most recent primary response.
// `endpoint` is the served `provider` string verbatim (a display name like
// "Novita" or a tagged slug like "novita/fp8" — spike fact 3); `model` is the
// response's concrete model id, captured alongside it (the spike confirmed
// OpenRouter responses carry both). `downgrade` is captureEndpoint's verdict
// — true ONLY when a non-empty steering order was actually applied to the
// request and the served provider matches none of it.
export type EndpointCapture = {
  sessionID: string
  endpoint: string
  model: string
  downgrade: boolean
  at: number
}

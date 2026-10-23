// src/core/types.ts
// Shared vocabulary for the plugin's core (design §4): pure types plus the
// pinned-tag weight defaults. No OpenCode imports, no I/O.

export type Priority = "balanced" | "price" | "quality"

export type Weights = { quality: number; price: number; context: number; age: number }

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

// Upstream.s PRIORITY_WEIGHTS at the pinned tag (v0.4.0; unchanged since v0.3.0). Used when a
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

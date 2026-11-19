// scripts/canary-check.mjs — nightly canary over the vendored script's output
// (plan Task 15, Step 2).
//
// Reads the catalog JSON that `python3 vendor/model_compare.py --catalog`
// emits against live upstream data and asserts the contract the plugin
// depends on (design §5):
//   - schema_version is exactly 6 (upstream's contract since v0.7.0, where
//     `quality` means the AA index at the model's best measured selectable
//     depth; the plugin's validateCatalog accepts nothing else, and a release
//     only happens when the live remote serves v6)
//   - models is a non-empty array
//   - every model has a non-empty string id and a scores object with finite
//     numeric quality/price/context/age and finite numeric
//     overall.balanced/overall.price/overall.quality (the plugin's three
//     priorities, src/core/types.ts)
//
// The check itself is the pure function `checkCanary(doc)`; the CLI below is a
// thin wrapper (tests/unit/canary.test.mjs exercises the function).
//
// Usage: node scripts/canary-check.mjs <catalog.json>   (or pipe JSON on stdin)
// Exit 0 prints a one-line summary; exit 1 prints the first reason found.

import { readFileSync } from "node:fs"
import { pathToFileURL } from "node:url"

export const EXPECTED_SCHEMA_VERSION = 6

const COMPONENTS = ["quality", "price", "context", "age"]
const PRIORITIES = ["balanced", "price", "quality"]

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

// -> { ok: true, models: n } | { ok: false, reason }
export function checkCanary(catalog) {
  if (!isPlainObject(catalog) || catalog.schema_version !== EXPECTED_SCHEMA_VERSION) {
    return {
      ok: false,
      reason: `schema_version is ${JSON.stringify(catalog?.schema_version ?? null)}, expected ${EXPECTED_SCHEMA_VERSION}`,
    }
  }
  if (typeof catalog.generated_at !== "string" || catalog.generated_at === "") {
    return { ok: false, reason: "generated_at is missing or not a non-empty string" }
  }
  if (catalog.parameters !== undefined && isPlainObject(catalog.parameters) && catalog.parameters.weights !== undefined) {
    if (!isPlainObject(catalog.parameters.weights)) {
      return { ok: false, reason: "parameters.weights must be an object" }
    }
    for (const p of PRIORITIES) {
      const entry = catalog.parameters.weights[p]
      if (entry !== undefined && !isPlainObject(entry)) {
        return { ok: false, reason: `parameters.weights.${p} must be an object` }
      }
    }
  }
  if (!Array.isArray(catalog.models) || catalog.models.length === 0) {
    return { ok: false, reason: "models is missing, empty, or not an array" }
  }
  for (const [i, model] of catalog.models.entries()) {
    const where = `model ${i}${typeof model?.id === "string" && model.id ? ` (${model.id})` : ""}`
    if (!isPlainObject(model)) {
      return { ok: false, reason: `${where}: model entry is not an object` }
    }
    if (typeof model.id !== "string" || model.id === "") {
      return { ok: false, reason: `${where}: id is not a non-empty string` }
    }
    if (typeof model.name !== "string" || model.name === "") {
      return { ok: false, reason: `${where}: name is not a non-empty string` }
    }
    if (!isPlainObject(model.pricing)) {
      return { ok: false, reason: `${where}: pricing is missing or not an object` }
    }
    if (!Number.isFinite(model.pricing.blended_per_1m)) {
      return { ok: false, reason: `${where}: pricing.blended_per_1m is not a finite number` }
    }
    if (!Number.isFinite(model.context)) {
      return { ok: false, reason: `${where}: context is not a finite number` }
    }
    if (model.quality !== null && !Number.isFinite(model.quality)) {
      return { ok: false, reason: `${where}: quality must be a finite number or null` }
    }
    if (!isPlainObject(model.scores)) {
      return { ok: false, reason: `${where}: scores is missing or not an object` }
    }
    for (const key of COMPONENTS) {
      if (!Number.isFinite(model.scores[key])) {
        return { ok: false, reason: `${where}: scores.${key} is not a finite number` }
      }
    }
    if (!isPlainObject(model.scores.overall)) {
      return { ok: false, reason: `${where}: scores.overall is missing or not an object` }
    }
    for (const p of PRIORITIES) {
      if (!Number.isFinite(model.scores.overall[p])) {
        return { ok: false, reason: `${where}: scores.overall.${p} is not a finite number` }
      }
    }
    // The depth contract: quality_effort names the effort behind a scored
    // quality, and every entry carries a reasoning block whose depths the
    // plugin reads for display. A scored model without an effort would make
    // the alias run at OpenRouter's default, not the depth its score means.
    if (!Object.hasOwn(model, "quality_effort")) {
      return { ok: false, reason: `${where}: quality_effort is missing` }
    }
    if (
      model.quality_effort !== null &&
      (typeof model.quality_effort !== "string" || model.quality_effort === "")
    ) {
      return { ok: false, reason: `${where}: quality_effort must be a non-empty string or null` }
    }
    if (model.quality !== null && model.quality_effort === null) {
      return { ok: false, reason: `${where}: quality is scored but quality_effort is null` }
    }
    if (!isPlainObject(model.reasoning)) {
      return { ok: false, reason: `${where}: reasoning is missing or not an object` }
    }
    if (
      !Array.isArray(model.reasoning.supported_efforts) ||
      model.reasoning.supported_efforts.some((effort) => typeof effort !== "string")
    ) {
      return { ok: false, reason: `${where}: reasoning.supported_efforts is not an array of strings` }
    }
    if (!Array.isArray(model.reasoning.depths)) {
      return { ok: false, reason: `${where}: reasoning.depths is not an array` }
    }
    for (const [index, depth] of model.reasoning.depths.entries()) {
      if (!isPlainObject(depth) || typeof depth.effort !== "string" || depth.effort === "") {
        return { ok: false, reason: `${where}: reasoning.depths[${index}] has no effort` }
      }
    }
  }
  if (catalog.rankings !== undefined) {
    if (!isPlainObject(catalog.rankings)) {
      return { ok: false, reason: "rankings must be an object" }
    }
    for (const p of PRIORITIES) {
      const list = catalog.rankings[p]
      if (list !== undefined && (!Array.isArray(list) || list.some((id) => typeof id !== "string"))) {
        return { ok: false, reason: `rankings.${p} must be an array of strings` }
      }
    }
  }
  return { ok: true, models: catalog.models.length }
}

function main() {
  const fail = (reason) => {
    console.error(`canary failed: ${reason}`)
    process.exit(1)
  }

  let text
  if (process.argv[2]) {
    try {
      text = readFileSync(process.argv[2], "utf8")
    } catch (err) {
      fail(`cannot read ${process.argv[2]}: ${err.message}`)
    }
  } else {
    try {
      text = readFileSync(0, "utf8")
    } catch (err) {
      fail(`cannot read stdin: ${err.message}`)
    }
  }

  let catalog
  try {
    catalog = JSON.parse(text)
  } catch (err) {
    fail(`input is not valid JSON: ${err.message}`)
  }

  const result = checkCanary(catalog)
  if (!result.ok) fail(result.reason)
  console.log(
    `canary ok: schema_version=${EXPECTED_SCHEMA_VERSION}, ${result.models} models, all required fields present`,
  )
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()

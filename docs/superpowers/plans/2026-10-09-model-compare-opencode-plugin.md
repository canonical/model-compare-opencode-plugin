# model-compare-opencode-plugin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** OpenCode v2 plugin that resolves `openrouter/model-compare/{balanced,price,quality}` aliases to model-compare's current pick, with commands, pinning, fallback, and a vendored/remote data pipeline.

**Architecture:** Pure TypeScript core (catalog validation, ranking, pin rules, resolution) fed by two sources (vendored `model_compare.py` via subprocess, or the published catalog.json) and wired into OpenCode through a thin adapter (model transform aliases, `http.request` guard, commands, refresh loop). The core never imports OpenCode; the adapter never contains ranking math.

**Tech Stack:** TypeScript (ESM), `@opencode/plugin` 2.0.16, vitest (unit + conformance), Python 3.10+ (vendored script, subprocess), Bash-scripted integration harness against `opencode serve`.

**Spec:** `docs/superpowers/specs/2026-10-08-model-compare-opencode-plugin-design.md` (read both; the plan argues from it)

## Global Constraints

- OpenCode V2 only. `@opencode/plugin` `2.0.16` as a regular `dependency` (spec §12).
- Vendored script: `canonical/model-compare` tag `v0.2.5`, byte-identical; sha256 recorded in `vendor/UPSTREAM.json` (§11). Import allowlist: `argparse, gzip, json, math, os, re, sys, time, urllib.error, urllib.request, datetime` (§11).
- License GPL-3.0 at repo root. Plugin id `model-compare`. npm name `model-compare-opencode-plugin` (§2).
- Aliases are model IDs inside the `openrouter` provider: `model-compare/balanced|price|quality`; `modelID` = the pick id (§8).
- Catalog: `schema_version` must be `1`; unknown fields ignored; a missing `quality` weight key means 0; `parameters.weights` missing entirely → `DEFAULT_WEIGHTS` (§5). Required fields: `schema_version`, `generated_at`, `models` (each with `id` and `scores`) (§5).
- Scoring operand order: quality, price, context, age (§6). Tie-break: `(-score, -(quality ?? 0), pricing.blended_per_1m asc, id asc)` (§6).
- Defaults: cache TTL 6 h; refresh tick 30 min; `pinDays` 14; `minLead` 0.03; local subprocess timeout 60 s (§3, §8, §11).
- Config violations: log a warning, use the default, never throw from `setup` (§3).
- Guard: `kind === "primary"` only; error message exactly `model-compare: no ranking data for openrouter/model-compare/<p>; set options.fallback or check the data source` (§9).
- Storage: pins keyed `pin/<priority>/<fnv1aHex(JSON.stringify(weights))>`, record `{ v: 1, id, since }`; corrupt/unknown-version records discarded with a warning; last-writer-wins across processes (§7).
- Sources never block `setup`; `acquiredAt` is the plugin's own clock (§5, §8). No OpenCode V1 adapter (§2).

## Review Focus

- Catalog with no quality data (`quality` weight key absent) → must not reject the document; rank with quality weight 0 (Tasks 2, 3).
- `python3` missing or < 3.10 under `source: "auto"` → warn and use remote; aliases keep working (Task 8; Task 14 integration).
- Offline start with only a stored pin → aliases resolve from storage without blocking `setup` (Task 12; Task 14 integration).
- Corrupt or unknown-version stored state (pin record, cached catalog) → discarded with a warning; `setup` never crashes (Tasks 4, 12).
- Alias disabled mid-session → primary run fails with the fixed guard error; root-default and `/use-best` sessions fall back silently with a log line (Tasks 10, 12; Task 13 integration).

---

### Task 1: Scaffold + vendor pin

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `LICENSE` (GPL-3.0 text), `vendor/model_compare.py`, `vendor/UPSTREAM.json`, `scripts/sync-vendor.mjs`
- Test: `tests/conformance/vendor.test.ts`

**Interfaces:**
- Produces: vendored script at `vendor/model_compare.py`; `vendor/UPSTREAM.json` `{ "repo": "canonical/model-compare", "tag": "v0.2.5", "commit": "<tag commit sha>", "sha256": "<file sha256>" }`; `scripts/sync-vendor.mjs <tag> [--check]` (fetch raw file from tag, verify + record sha/commit, print CHANGELOG section; `--check` exits 1 when the file drifts from the recorded sha). These are consumed by Tasks 6 and 15.

- [ ] **Step 1: Write the failing test**

```ts
// tests/conformance/vendor.test.ts
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
test("vendored script matches the pinned tag", () => {
  const meta = JSON.parse(readFileSync("vendor/UPSTREAM.json", "utf8"))
  expect(meta.tag).toBe("v0.2.5")
  const sha = createHash("sha256").update(readFileSync("vendor/model_compare.py")).digest("hex")
  expect(sha).toBe(meta.sha256)
})
test("imports stay on the allowlist", () => {
  const src = readFileSync("vendor/model_compare.py", "utf8")
  const imports = [...src.matchAll(/^import (\S+)/gm)].map((m) => m[1])
  const allow = new Set(["argparse", "gzip", "json", "math", "os", "re", "sys", "time", "urllib.error", "urllib.request", "datetime"])
  for (const i of imports) expect(allow.has(i), `unexpected import: ${i}`).toBe(true)
})
```

- [ ] **Step 2: Run test to verify it fails.** Run: `npx vitest run tests/conformance/vendor.test.ts` — Expected: FAIL (file missing).
- [ ] **Step 3: Vendor the pin.** Download `https://raw.githubusercontent.com/canonical/model-compare/v0.2.5/model_compare.py` to `vendor/model_compare.py`; write `vendor/UPSTREAM.json` with the tag's commit sha and the file's sha256; add `scripts/sync-vendor.mjs` per the interface above. Add `package.json` (`"type": "module"`, `"exports": { ".": "./src/index.ts" }`, dep `@opencode/plugin@2.0.16`, devDeps `vitest`), `tsconfig.json` (ESM, strict), `vitest.config.ts`, `LICENSE` (GPL-3.0 full text).
- [ ] **Step 4: Run tests to verify they pass.** Run: `npx vitest run tests/conformance/vendor.test.ts` — Expected: PASS. Also `python3 vendor/model_compare.py --version` prints `model-compare 0.2.5`.
- [ ] **Step 5: Commit.** `git add -A && git commit -m "chore: scaffold package, vendor model_compare.py at v0.2.5"`

### Task 2: Catalog validation

**Files:**
- Create: `src/core/types.ts`, `src/core/catalog.ts`, `fixtures/catalog-v0.2.5.json` (recorded real catalog from the published URL at execution time), `fixtures/catalog-no-quality.json` (copy with `parameters.weights.*.quality` keys removed and `quality: null` on all models)
- Test: `tests/unit/catalog.test.ts`

**Interfaces:**
- Produces (all later tasks import from `src/core/types.ts`):
```ts
type Priority = "balanced" | "price" | "quality"
type Weights = { quality: number; price: number; context: number; age: number }
type ModelEntry = { id: string; name: string; pricing: { blended_per_1m: number }; context: number; quality: number | null;
  scores: { quality: number; price: number; context: number; age: number; overall: Record<Priority, number> } }
type Catalog = { generatedAt: string; weights: Partial<Record<Priority, Partial<Weights>>>;
  rankings: Partial<Record<Priority, string[]>>; models: ModelEntry[] }
const DEFAULT_WEIGHTS: Record<Priority, Weights>  // v0.2.5 values: balanced .40/.40/.10/.10, price .20/.60/.10/.10, quality .60/.20/.10/.10
validateCatalog(raw: unknown): { ok: true; catalog: Catalog } | { ok: false; reason: string }
type Sourced = { doc: Catalog; acquiredAt: number }   // acquiredAt = the plugin's own clock at acceptance (§5)
```

- [ ] **Step 1: Write the failing tests** (`tests/unit/catalog.test.ts`): accepts the recorded fixture (assert `catalog.models.length > 0`); accepts the no-quality fixture (assert `weights.balanced.quality === undefined`); rejects `{}` (reason mentions `schema_version`); rejects `schema_version: 2`; rejects a model without `scores`; ignores unknown top-level fields (extra key survives as ignored, no rejection).
- [ ] **Step 2: Run** `npx vitest run tests/unit/catalog.test.ts` — Expected: FAIL (module missing).
- [ ] **Step 3: Implement** `validateCatalog` per the interface; keep raw `weights`/`rankings` as published (possibly partial); do not synthesize keys here.
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -am "feat(core): catalog document validation (schema v1)"`

### Task 3: Ranking and weights

**Files:**
- Create: `src/core/rank.ts`
- Test: `tests/unit/rank.test.ts`

**Interfaces:**
- Consumes: `Catalog`, `Priority`, `Weights`, `DEFAULT_WEIGHTS` (Task 2).
- Produces:
```ts
effectiveWeights(catalog: Catalog, p: Priority, override?: Partial<Weights>): { weights: Weights; usedOverride: boolean; zeroSum: boolean }
overallScore(entry: ModelEntry, w: Weights): number          // operand order: quality, price, context, age (§6)
rankModels(catalog: Catalog, p: Priority, override?: Partial<Weights>): { ids: string[]; usedFallbackWeights: boolean }
```
Semantics (§5, §6): `effectiveWeights` starts from `catalog.weights[p]` when `parameters.weights` exists — any key missing from it means weight 0 — or from `DEFAULT_WEIGHTS[p]` when `parameters.weights` is missing entirely; override keys are then replaced and the merged map is normalized to sum 1 (rescale all; worked example in §6). Overrides for keys that are missing from `catalog.weights[p]` (the no-quality-data signal) are ignored with a warning — the key stays missing (weight 0); the other keys apply. `zeroSum` is true when the merged map sums to 0. `rankModels` with no override uses `catalog.rankings[p]` verbatim when present, else sorts by `scores.overall[p]` with the tie-break; with an override it recomputes `overallScore` per model and sorts by the tie-break `(-score, -(quality ?? 0), pricing.blended_per_1m asc, id asc)`; `usedFallbackWeights` is true when the runtime zero-sum path forced the published (or DEFAULT) weights.

- [ ] **Step 1: Write the failing tests**: worked example — balanced + `{quality: 0.5}` → weights `{0.4545454, 0.3636364, 0.0909091, 0.0909091}` (toBeCloseTo 1e-6); missing `parameters.weights` entirely → `DEFAULT_WEIGHTS`; on the no-quality fixture, an override `{quality: 1}` is ignored (quality stays 0) with a warning, and the other override keys apply; a synthetic all-zero weights map → `zeroSum` true and `rankModels` returns the published order with `usedFallbackWeights: true`; tie-break: two synthetic models with equal overall, different `blended_per_1m` → cheaper first; equal everything → id asc; no-override path returns `rankings[priority]` verbatim.
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement** per the interface.
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -am "feat(core): weight merging, scoring, ranking with upstream tie-breaks"`

### Task 4: Pin state, resolution chain, storage helpers

**Files:**
- Create: `src/core/pins.ts`, `src/opencode/storage.ts`
- Test: `tests/unit/pins.test.ts`

**Interfaces:**
- Consumes: `rankModels`, `overallScore` (Task 3).
- Produces:
```ts
type Pin = { v: 1; id: string; since: number }
type Storage = { get(key: string): Promise<unknown>; set(key: string, value: unknown): Promise<void> }
readRecord<T extends { v: number }>(storage: Storage, key: string): Promise<T | null>   // null on missing/corrupt/wrong v
writeRecord(storage: Storage, key: string, value: { v: number } & Record<string, unknown>): Promise<void>
pinKey(p: Priority, w: Weights): string                                  // `pin/${p}/${fnv1aHex(JSON.stringify(w))}`
DOC_CACHE_KEY = "doc/cache"                                             // stored: { v: 1, doc: Catalog, acquiredAt: number }
resolve(input: {
  catalog: Catalog | null; p: Priority; override?: Partial<Weights>;
  runnable: (id: string) => boolean; fallback: string | null;           // config value "openrouter/<id>"
  stored: Pin | null; now: number; pinDays: number; minLead: number;
}): { targetId: string | null; source: "pick" | "pin" | "fallback" | "none"; pin: Pin | null; notices: string[] }
```
Resolution semantics (§7, §9): with a fresh catalog — best runnable candidate; switch from pin only when pin is unrunnable, pin older than `pinDays`, or challenger leads by ≥ `minLead` (pin's score computed from the current catalog under current weights); `since` resets on every (re)adoption. Without a catalog — stored pin if runnable → `fallback` if runnable → `none`. Notices: pin switched, pin skipped (unrunnable), fallback used, override ignored (missing data).

- [ ] **Step 1: Write the failing tests**: first adoption (no pin → best runnable, `since = now`); pin kept when challenger leads by < `minLead`; switch when lead ≥ `minLead` (new `since`); switch when pin unrunnable; expiry at `pinDays` switches and resets `since`; no catalog + runnable pin → `source: "pin"`; no catalog + unrunnable pin + runnable fallback → `source: "fallback"`; nothing runnable → `source: "none"`; `readRecord` returns null on `{}` (no `v`) and on invalid JSON shapes.
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement** per the interface (include a local `fnv1aHex` helper in `pins.ts`).
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -am "feat(core): pin rules, resolution chain, versioned storage records"`

### Task 5: Config parsing and validation

**Files:**
- Create: `src/config.ts`
- Test: `tests/unit/config.test.ts`

**Interfaces:**
- Consumes: `Priority`, `Weights` (Task 2).
- Produces:
```ts
type Config = {
  source: "auto" | "local" | "remote";
  defaultPriority: Priority;
  fallback: string | null;                              // must be "openrouter/<id>" (§3) or null
  weights: Partial<Record<Priority, Partial<Weights>>>;
  pinDays: number;                                      // default 14
  minLead: number;                                      // default 0.03
  catalogURL: string;                                   // default "https://canonical.github.io/model-compare/catalog.json"
  scriptPath: string | null;                            // null → vendored copy
}
parseConfig(raw: unknown): { config: Config; warnings: string[] }
```
Validation table (§3): unknown/missing `source` → `auto` + warn; unknown `defaultPriority` → `balanced` + warn; `fallback` set and not `openrouter/<id>` (or contains `#`) → null + warn; `weights` unknown priority or unknown weight key → key dropped + warn; non-numeric or negative weight values → dropped + warn; non-positive/non-numeric `pinDays` → 14 + warn; `minLead` < 0 or > 1 or non-numeric → 0.03 + warn; non-HTTPS `catalogURL` → default + warn; non-string `scriptPath` → null + warn. Never throws.

- [ ] **Step 1: Write the failing tests**: one per table row (assert `config` default applied and `warnings` non-empty with a message naming the option); full valid config passes through unchanged with no warnings.
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement** per the table.
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -am "feat(config): option parsing with warn-and-default validation"`

### Task 6: Local source runner

**Files:**
- Create: `src/sources/local.ts`, `tests/fixtures/stub-model-compare.py` (prints a fixed fixture JSON to stdout; `--version` prints `model-compare 9.9.9`)
- Test: `tests/unit/local-source.test.ts`

**Interfaces:**
- Consumes: `validateCatalog` (Task 2), `Sourced` type; the vendored script (Task 1); `scriptPath` config (Task 5).
- Produces:
```ts
probePython(): Promise<{ ok: true } | { ok: false; reason: string }>   // python3 present AND >= 3.10
scriptEnv(): NodeJS.ProcessEnv   // { HOME, PATH } + when set: XDG_CACHE_HOME, AA_API_KEY, HTTP(S)_PROXY, http(s)_proxy, NO_PROXY/no_proxy, SSL_CERT_FILE, SSL_CERT_DIR
runLocalScript(scriptPath: string, timeoutMs = 60_000): Promise<Sourced>  // execFile("python3", [scriptPath, "--catalog"], { env: scriptEnv(), timeoutMs }); rejects on non-zero exit, timeout, invalid JSON, rejected document
```

- [ ] **Step 1: Write the failing tests**: stub script via `runLocalScript("tests/fixtures/stub-model-compare.py")` resolves with the fixture's models and `acquiredAt ≈ Date.now()`; a stub exiting 1 rejects with the stderr tail in the reason; a stub printing invalid JSON rejects; a stub sleeping > timeout rejects mentioning timeout; `probePython` on the real interpreter resolves (CI has python3).
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement** per the interface (`node:child_process` `execFile`, no shell; exit code only refines the message — §9).
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -am "feat(sources): local runner for the vendored script"`

### Task 7: Remote source fetcher

**Files:**
- Create: `src/sources/remote.ts`
- Test: `tests/unit/remote-source.test.ts` (inject a fake `fetch`)

**Interfaces:**
- Consumes: `validateCatalog`, `Sourced`, `Storage`, `DOC_CACHE_KEY`, `readRecord`/`writeRecord` (Tasks 2, 4).
- Produces:
```ts
fetchRemote(url: string, storage: Storage, deps?: { fetch?: typeof fetch; now?: () => number; ttlMs?: number }):
  Promise<Sourced & { fromCache: boolean }>   // ttlMs default 6h (§8)
```
Semantics: fresh fetch + validate → persist `{ v: 1, doc, acquiredAt }` under `doc/cache` → return `fromCache: false`; fetch failure or rejected document → cached record if present (`fromCache: true`) → else reject with the reason. `acquiredAt` is the plugin's own clock at acquisition (§5), both for fresh and cached reads (a cached read keeps its stored `acquiredAt`).

- [ ] **Step 1: Write the failing tests**: valid fetch persists to storage and returns `fromCache: false`; second call within TTL returns the cached doc (`fromCache: true`, fetch NOT called); expired record (old `acquiredAt`) refetches; fetch failure with a cached record → cached + `fromCache: true`; fetch failure with empty storage → rejects; malformed body with cached record → cached.
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement** per the interface.
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -am "feat(sources): remote catalog fetch with persisted 6h cache"`

### Task 8: Source selection (auto) and acquisition

**Files:**
- Create: `src/sources/index.ts`
- Test: `tests/unit/acquire.test.ts`

**Interfaces:**
- Consumes: `Config` (Task 5), `probePython`/`runLocalScript` (Task 6), `fetchRemote` (Task 7), `Storage`.
- Produces:
```ts
acquire(cfg: Config, deps: { storage: Storage; probePython?; runLocal?; fetchRemote?; now? }):
  Promise<{ sourced: Sourced; source: "local" | "remote"; fromCache: boolean; warnings: string[] }>
```
Semantics: `local` → runLocalScript(cfg.scriptPath ?? vendored path), failure rejects with the reason; `remote` → fetchRemote; `auto` → `probePython()` ok → local, else remote + warning; auto + local failure → remote + warning naming the local reason (§3, §9).

- [ ] **Step 1: Write the failing tests**: `local` success returns source local; `local` failure rejects with the reason; `auto` with probe failing → remote + warning mentioning python; `auto` with local rejecting → remote + warning with the local reason; `remote` ignores python entirely.
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement** per the interface (vendored default path: `vendor/model_compare.py` relative to the package root — resolve via `import.meta.url`).
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -am "feat(sources): auto source selection with remote fallback"`

### Task 9: Alias computation

**Files:**
- Create: `src/opencode/aliases.ts`
- Test: `tests/unit/aliases.test.ts`

**Interfaces:**
- Consumes: `ModelEntry` (Task 2).
- Produces:
```ts
planAlias(p: Priority, target: { id: string | null; fromFallback: boolean }, model: ModelEntry | undefined):
  { modelID: string | null; name: string; enabled: boolean; warnings: string[] }
```
Semantics: `target.id === null` or `model === undefined` → `{ modelID: null, enabled: false, name: "Model Compare: <p> (unavailable)" }` + warning (missing pick model is the §8 rule — never silently skipped). Enabled → `modelID = target.id`, `name = "Model Compare: <p> → <id>"` + `" (fallback)"` when `fromFallback`. The applier (Task 12) copies `capabilities`, `limit`, `cost`, `variants`, `time`, `status` from the concrete model via `editor.get` (§8).

- [ ] **Step 1: Write the failing tests**: enabled pick → exact name/modelID/enabled; fallback target → name carries ` (fallback)`; no target → disabled + unavailable name + warning; pick present but `model === undefined` → disabled + warning (missing-model rule).
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -am "feat(adapter): alias plan computation"`

### Task 10: The guard

**Files:**
- Create: `src/opencode/guard.ts`
- Test: `tests/unit/guard.test.ts`

**Interfaces:**
- Produces:
```ts
parseAliasRef(ref: { providerID: string; id: string } | undefined): Priority | null
// openrouter + "model-compare/<p>" → p; anything else → null
guardDecision(kind: string, agentModel: { providerID: string; id: string } | undefined,
  isEnabled: (p: Priority) => boolean): { error?: string }
```
Semantics (§9): fires only for `kind === "primary"`; key = the agent's configured `model` (a `{providerID, id}` ref, from `ctx.agent.get` — Task 12 supplies it); error message exactly per Global Constraints; non-primary kinds and non-alias agents → no error, even when the alias is disabled. The headless false-positive (guard fires though the root-governed effective model is healthy) is a recorded trade-off, not a bug (§9, §15).

- [ ] **Step 1: Write the failing tests**: primary + alias-configured agent + disabled alias → error text exact; same with enabled alias → no error; `kind: "title"/"compaction"/"generate"` → no error even when disabled; agent with real model ref → no error; `agentModel` undefined → no error; ref parsing: `openrouter/model-compare/quality` → "quality", `openrouter/anthropic/x` → null, `anthropic/model-compare/quality` → null, undefined → null.
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -am "feat(adapter): primary-kind guard for disabled aliases"`

### Task 11: Commands

**Files:**
- Create: `src/opencode/commands.ts`
- Test: `tests/unit/commands.test.ts`

**Interfaces:**
- Consumes: `Priority` (Task 2), `Sourced` (Task 2 types).
- Produces:
```ts
parseUseBest(text: string, defaultPriority: Priority): { ok: true; priority: Priority } | { ok: false; message: string }
formatReport(sourced: Sourced, ranks: Record<Priority, string[]>): string
```
Semantics (§10): `parseUseBest` trims `text`; empty → `defaultPriority`; valid priority name (case-insensitive) → that priority; anything else → `{ ok: false, message }` listing the valid names. `formatReport` renders markdown: one section per priority with the top 5 ids and their `scores.overall[p]` values, plus a data-age line computed from `sourced.acquiredAt` (the plugin's acquisition time, §5); empty models → explicit "no data" line.

- [ ] **Step 1: Write the failing tests**: `parseUseBest("", "balanced")` → balanced; `"PRICE"` → price; `"cheap"` → ok false with valid names in the message; `formatReport` contains all three priority headers, five ids each (from a synthetic catalog), an age line mentioning "data age"; no-data input renders the no-data line.
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -am "feat(adapter): /use-best and /model-compare command logic"`

### Task 12: Plugin entrypoint wiring and refresh loop

**Files:**
- Create: `src/index.ts`
- Test: `tests/unit/wiring.test.ts` (mock ctx + injected deps)

**Interfaces:**
- Consumes: everything above. `@opencode/plugin` (Task 1).
- Produces (this is the shipped package entrypoint):
```ts
export default Plugin.define({ id: "model-compare", setup(ctx) { return wire(ctx, {}) } })
export async function wire(ctx: PluginCtx, deps: {
  acquire?: typeof acquire; setInterval?: (fn: () => void, ms: number) => () => void; now?: () => number;
}): Promise<() => void>   // returns the cleanup function
```
Setup order (§8, never blocking on data): parse config (`ctx.options`, §3 warnings logged); register the model transform — aliases are computed inside the transform from captured state `{ picks: Partial<Record<Priority, { id: string; fromFallback: boolean }>>, enabled: Record<Priority, boolean> }`; read the stored pin (`ctx.storage`) and register initial aliases (enabled only if the pin model is runnable per `ctx.model.list()`); register the guard hook (`ctx.session.hook("http.request", …)` — on `guardDecision().error`, throw; on a disabled alias reached via root/`/use-best` (agent not alias-configured), log one warning per refresh); register commands (`/use-best`: parse args → refuse with an error message when the target alias is disabled, else `ctx.session.switchModel({ sessionID, model: { providerID: "openrouter", id: `model-compare/<p>` } })` (§10); `/model-compare`: `formatReport` over the persisted doc, delivered as a synthetic message); schedule the refresh tick (30 min) via `deps.setInterval`. Refresh tick (non-overlapping via a flag): `acquire` → `resolve` per priority (runnable set from `ctx.model.list()`) → if any alias plan changed: replay the transform then `ctx.provider.reload()` → `ctx.model.reload()` → `ctx.agent.reload()`, in that order (§8); write pin records (`pin/<p>/<hash>`) and the doc cache (`doc/cache`); log `notices`/warnings (console.warn/error — §15 item 5). Cleanup: clear the timer.

- [ ] **Step 1: Write the failing tests** (mock ctx: record transform callbacks, hook registrations, storage calls; inject a controllable `setInterval` and a stub `acquire`): `wire` resolves without calling `acquire` (assert the stub acquire is NOT awaited during setup — tick it manually); setup with a stored pin enables the alias from storage; setup with no storage → aliases disabled; corrupt pin record → warning + disabled, no throw; refresh tick with changed pick → reloads called in provider→model→agent order and pin/doc written; refresh tick with unchanged pick → no reloads; refresh while one is running → skipped (non-overlap); disabled alias + alias-configured agent → guard hook throws with the exact message; disabled alias + non-alias agent → warning logged, no throw; `/use-best` handler refuses when the alias is disabled and calls `switchModel` with the alias ref when enabled.
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement.** Keep `wire` thin: state capture + registration; all decisions already live in core/adapter modules.
- [ ] **Step 4: Run** `npx vitest run` (whole suite) — Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -am "feat(adapter): plugin wiring, refresh loop, guard and commands"`

### Task 13: Integration harness + core cases

**Files:**
- Create: `tests/integration/harness.mjs` (spawns `opencode serve --hostname 127.0.0.1 --port 14721` in a scratch project `tests/integration/project/` with `OPENCODE_SERVER_PASSWORD=integration-only`; the project's `opencode.jsonc` loads the plugin via `{ "package": "<abs repo root>" }` and a probe plugin `tests/integration/probe/` that appends every `http.request` `{ sessionID, agent, kind, eventModel, wire }` to `tests/integration/wire.jsonl`; helper `run(cliArgs)` shells `opencode run --server …`; helper `waitSetup()` sleeps until the probe logged a `setup` line)
- Test: `tests/integration/core-cases.test.mjs` (vitest, long timeouts, sequential; skips with a clear message if `opencode` or `python3` is unavailable)

**Interfaces:**
- Consumes: the built plugin (Task 12), `agent mc-*` files in the scratch project (an alias-configured `mode: subagent` agent, a real-model parent, an agent with an unusual id — e.g. `zzz-unseen` — configured with the alias).
- Covers (spec §13): agent dispatch to the pick; root default dispatch; pick change → next run uses the new pick (agent and root); stale-dispatch regression — after EVERY state change the next run's wire model is asserted (never assume); disabled alias → direct primary run fails with the guard error text; never-seen agent (`zzz-unseen`) → guard fires (agent-agnostic proof).

- [ ] **Step 1: Write the harness and the case file with the first two cases** (agent dispatch; root dispatch) — Expected: FAIL (plugin not built/wired in the project yet or assertions not met).
- [ ] **Step 2: Wire the scratch project and fix failures until the first two cases pass.**
- [ ] **Step 3: Add the remaining cases** (pick change; stale-dispatch assertion after each change; guard error; never-seen agent) — Expected: PASS; any failure is investigated against the probe log before touching the plugin (this is the §15 item 2 regression net).
- [ ] **Step 4: Run** `npx vitest run tests/integration/core-cases.test.mjs` — Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -am "test(integration): harness with core dispatch, refresh and guard cases"`

### Task 14: Integration remaining cases

**Files:**
- Modify: `tests/integration/core-cases.test.mjs` (or sibling file `tests/integration/ops-cases.test.mjs` if the file grows past ~400 lines)

**Interfaces:**
- Consumes: the harness (Task 13). New scratch-project variants: a project with a broken `scriptPath` + `source: "auto"`; a project without an OpenRouter connection; `state.json` removed for a cold offline start.

- [ ] **Step 1: Add cases** (spec §13): `/use-best` via the command API (`POST /api/session/{id}/command` with `{ "name": "use-best", "text": "price" }`) — follow-up run dispatches to the price pick; refusal when the alias is disabled; subagent with a disabled alias → launch fails with `Model unavailable` before any HTTP request (probe log has no line for that child); non-primary kinds run untouched with a disabled alias (title/generate requests appear in the probe log without a guard error); startup offline — no python (PATH stripped in the serve env), no cached doc, only a stored pin → first run dispatches to the pin; missing OpenRouter provider → no alias lines in the probe log + a warning in the server log; `auto` + broken `scriptPath` → remote fallback serves picks (probe wire models valid).
- [ ] **Step 2: Run** the full integration suite — Expected: PASS; failures investigated via `wire.jsonl` and the server log before code changes.
- [ ] **Step 3: Commit.** `git commit -am "test(integration): commands, failure and degradation cases"`

### Task 15: CI workflows

**Files:**
- Create: `.github/workflows/test.yml`, `.github/workflows/nightly-canary.yml`, `.github/workflows/weekly-drift.yml`, `.github/workflows/upgrade-pr.yml`

**Interfaces:**
- Consumes: `scripts/sync-vendor.mjs` (Task 1), the vendored script, vitest suite.

- [ ] **Step 1: Write `test.yml`**: on PR/push — setup-python 3.10 + Node 20, `npm ci` (or `npm install`), `npx vitest run tests/unit tests/conformance` (integration stays manual/optional via a flag).
- [ ] **Step 2: Write `nightly-canary.yml`**: cron — run `python3 vendor/model_compare.py --catalog` live; assert non-empty `models`, `schema_version == 1`, required fields present (a small node script, `scripts/canary-check.mjs`).
- [ ] **Step 3: Write `weekly-drift.yml`**: cron — fetch the published `catalog.json`, compare our top 5 per priority (computed by `rankModels` with no override) against its `rankings`; write a drift report artifact and fail on sustained disagreement (a small node script, `scripts/drift-check.mjs`; near-tie divergence tolerated per §6 — compare id sets up to ties, report-only exit 0 with a warning count, exit 1 only when ≥ 3 positions differ).
- [ ] **Step 4: Write `upgrade-pr.yml`**: cron — if the upstream latest tag differs from `vendor/UPSTREAM.json`'s, run `node scripts/sync-vendor.mjs <tag>` on a branch and open a draft PR titled `vendor: model_compare.py <tag>` (never auto-merge).
- [ ] **Step 5: Verify locally.** Run: `node scripts/sync-vendor.mjs --check` (exit 0), `node scripts/canary-check.mjs <(python3 vendor/model_compare.py --catalog)` — Expected: clean.
- [ ] **Step 6: Commit.** `git commit -am "ci: test, canary, drift and upgrade-PR workflows"`

### Task 16: Packaging and README

**Files:**
- Modify: `package.json` (`files`: `["src", "vendor/model_compare.py", "vendor/UPSTREAM.json", "LICENSE", "README.md"]` — fixtures, sync script and tests stay out, §12)
- Create: `README.md`

- [ ] **Step 1: Update `package.json` `files` and verify.** Run: `npm pack --dry-run` — Expected: the tarball lists exactly `src/**`, the two vendor files, `LICENSE`, `README.md`.
- [ ] **Step 2: Write `README.md`** (from the spec): install (`plugins` entry with `package: "model-compare-opencode-plugin"` + options table copied from §3 including the validation behavior); the aliases and where `model:` binds (subagents everywhere; primary agents only via TUI selection — cite the verified paths, §2/§9); root default + `/use-best` + `/model-compare` (incl. the extra model turn per call and the guard-interplay note, §10); pinning and fallback behavior (§7, §9); upgrade procedure for the vendored script (§11); troubleshooting: the exact guard error, silent-fallback root-default warning, data-age semantics (§5), missing OpenRouter provider.
- [ ] **Step 3: Verify.** Run: `npx vitest run tests/unit tests/conformance` — Expected: PASS (nothing broke).
- [ ] **Step 4: Commit.** `git commit -am "docs: README, packaging scope"`

---

## Self-Review

Ran after writing; findings fixed inline during drafting:

1. **Spec coverage:** §3 → Task 5 (+16 packaging); §5 → Task 2; §6 → Task 3; §7 → Task 4; §8 → Tasks 9, 12; §9 → Tasks 6, 10, 12; §10 → Task 11, 12; §11 → Tasks 1, 15; §12 → Tasks 1, 16; §13 → Tasks 13–14; §15 outcomes → Tasks 10, 12, 13. Roadmap items are out of scope by design (§16).
2. **Step scan:** every step writes exactly one thing (a named test with assertions, a signature, or a run/commit command); no "handle edge cases" lines; bodies only where the algorithm isn't determined by signature + tests (fnv1aHex, execFile invocation).
3. **Type consistency:** `Sourced`, `Pin`, `Storage`, `Priority`/`Weights`/`Catalog` defined once (Tasks 2, 4) and consumed by name everywhere; `planAlias` return shape matches Task 12's transform; `guardDecision` signature matches the hook call in Task 12.
4. **Review Focus:** all five lines pinned — no-quality (Tasks 2, 3), python-missing auto (Task 8, Task 14), offline stored pin (Task 12, Task 14), corrupt storage (Tasks 4, 12), disabled-alias mid-session (Tasks 10, 12, 13).
5. **Proportion:** the plan pins decisions (names, signatures, exact values, tie-breaks, message text) and leaves bodies to the implementer; integration cases are scenario lists, not scripts.




# Design

Architecture, runtime contracts, and maintainer workflows for `model-compare-opencode-plugin`. End-user setup and usage are documented in [README.md](README.md).


## Repository layout

- `src/core/` — pure ranking, weight merging, pin hysteresis, reasoning-depth selection, steering block projection, and served-endpoint attribute comparison (no OpenCode imports, no I/O).
- `src/sources/` — catalog acquisition (`local.ts` subprocess runner for the vendored Python script, `remote.ts` HTTPS fetcher, `drops.ts` diagnostic helpers).
- `src/opencode/` — alias and pick planning, primary-request guard, `/use-best` and `/model-compare` command builders, versioned plugin storage, and the 30-minute refresh loop.
- `src/config.ts` and `src/rpc.ts` — warn-and-default option parsing and the typed RPC contract connecting the runtime and TUI halves.
- `src/index.ts` — runtime (server) plugin entrypoint (`"."` export), including OpenCode model-editor alias mutation (`applyAliases`) and hook wiring.
- `src/tui.tsx` — terminal-UI plugin entrypoint; precompiled to `dist/tui.js` (`"./tui"` export) for published packages.
- `vendor/` — pinned copy of upstream `model_compare.py` and `vendor/UPSTREAM.json` provenance record.
- `tests/{unit,conformance,integration}/` — Vitest suites.


## Data sources, caching, and the vendored pin

Three `options.source` modes feed the plugin:

- `auto` (default) — runs a 10-second `python3` version probe (3.10+), then executes the vendored `vendor/model_compare.py --catalog` (no shell, minimal environment, 60-second timeout, 64 MiB stdout cap). If `python3` is unavailable or the run fails, acquisition falls back to `remote`.
- `local` — runs only the vendored script (or `options.scriptPath` when set, skipping the Python pre-probe). On failure, resolution falls back to stored pins or `options.fallback` while keeping any previously acquired in-memory catalog available for `/model-compare` and steering.
- `remote` — fetches `options.catalogURL` (default `https://model-compare.dev/catalog.json`) over HTTPS with a 30-second socket timeout, a 16 MiB streaming body cap, and a 6-hour revalidation TTL. Redirects that leave `https://` fail closed (the legacy `canonical.github.io/model-compare/catalog.json` URL redirects over plaintext `http://` and is rejected).

Validated catalogs are persisted in plugin storage, keyed by source identity (script path or URL) so switching sources never serves stale data from another source. Every acquired catalog records the plugin's own `acquiredAt` timestamp, which `/model-compare` reports as `data age` (rather than upstream's `generated_at`, which is stamped at build time even when serving cached HTTP inputs). Persisted records also carry a cache-era version; schema-era upgrades discard incompatible cached documents cleanly and run on `options.fallback` until the first refresh completes. Note that Python script exit code `2` covers both "no candidates survived filters" and `argparse` usage errors, so callers never interpret exit code `2` as an empty pool without validating output.

### Vendored upstream pin and network profile

`vendor/model_compare.py` is byte-identical to the upstream tag recorded in `vendor/UPSTREAM.json` (currently `v0.7.0`, catalog `schema_version === 6`). `validateCatalog` accepts schema v6 exclusively and rejects any other version.

In schema v6:
- `quality` holds the Artificial Analysis (AA) intelligence index at the model's best measured selectable reasoning effort, paired with `quality_effort` and a per-model `reasoning` block (`default_effort`, expanded `supported_efforts`, capability flags, and `depths` with AA `$/task`).
- `pricing` scalars hold effective-tier rates at a 1M-token prompt size, matching what long coding sessions pay when OpenRouter long-context price overrides apply.

When building a fresh catalog with a cold HTTP cache, `vendor/model_compare.py` fetches per-model endpoint pricing across all candidate models. Failed per-model endpoint fetches drop only that model (HTTP `429` fails immediately without retry), trading pool size for pricing accuracy. Unkeyed runs hydrate quality scores in a single HTTPS fetch from `https://model-compare.dev/catalog.json` (keyed runs query the AA API directly and never fetch the published catalog). Under a slow connection, a cold run can exceed the 60-second local timeout, triggering fallback (`auto` → `remote`, `local` → stored pins / `options.fallback`).

### Upgrading the vendored script

Vendor updates land through reviewed pull requests only:

1. Run `node scripts/sync-vendor.mjs <tag>` to download `model_compare.py` at that tag, verify the SHA-256 diff, update `vendor/UPSTREAM.json`, and print the upstream changelog excerpt (`--check` verifies the pin offline).
2. Run `npm test` — conformance tests verify `--version`, schema v6 output, required fields, recomputed `overall` scores, and the Python stdlib-only import allowlist.
3. Inspect script diffs touching imports, URLs, environment variables, subprocess calls, or file writes (extracted automatically in draft PR bodies opened by `.github/workflows/upgrade-pr.yml`).
4. Cut a plugin release noting the upstream tag; users update via OpenCode's `/plugins` dialog or `opencode plugin update`.

Automated guardrails: a scheduled workflow opens a draft PR when upstream tags a new release (never a downgrade); a nightly canary runs the vendored script against live upstream APIs and pipes the output through `scripts/canary-check.mjs` (`EXPECTED_SCHEMA_VERSION = 6`); a weekly drift check verifies the vendored SHA-256 and score parity; and release builds gate on `https://model-compare.dev/catalog.json` passing `scripts/canary-check.mjs`.


## Pinning, resolution, and the request guard

For each priority (`balanced`, `price`, `quality`), the plugin stores one pin record keyed by the effective normalized weights (so custom `weights` overrides do not collide with default pins). On each catalog refresh (startup plus every 30 minutes):

1. No existing pin → adopt the highest-ranked runnable candidate.
2. Pinned model absent from the catalog or not runnable in OpenCode's `openrouter` provider → switch to the highest-ranked runnable candidate immediately.
3. Pin older than `options.pinDays` (default `14`) → re-evaluate from scratch (which may re-adopt the same model, resetting its `since` timestamp).
4. Otherwise → switch only if the top runnable candidate leads the pinned model's `0`–`1` composite score by at least `options.minLead` (default `0.03`).

With a fresh catalog, rules 1–4 choose the target (falling back to runnable `options.fallback` → alias disabled when no candidate is runnable); without a fresh catalog (`doc: null` at startup seed or after a failed `local` refresh), resolution walks **runnable stored pin → runnable `options.fallback` → alias disabled**. `options.fallback` is checked for runnability on every pass and is never written as a pin. Concurrent OpenCode processes refresh independently (advisory pins, last writer wins).

When a pick changes on a 30-minute tick, the plugin triggers a registry reload in OpenCode so model pickers and agent bindings reflect the new target (in integration measurements, full provider/model/agent replay takes ~90–105 seconds, during which newly started runs wait).

**Disabled-alias behavior:**
- If an agent's configured definition (`ctx.agent.get`) points at `model: openrouter/model-compare/<priority>` and that alias is disabled, the plugin's primary-request guard aborts primary turns with `model-compare: no ranking data for openrouter/model-compare/<priority>` rather than silently running an unintended model — including headless `opencode run --agent …` turns even when the effective root or `--model` model is healthy. Subagent launches fail earlier inside OpenCode with `Model unavailable: openrouter/model-compare/<priority>`. Auxiliary background calls (title generation, compaction) are not blocked.
- `/use-best`, `alt+u`, and `alt+m` refuse to switch onto a currently disabled alias; root-default sessions (and sessions switched *before* an alias became disabled) fall back to OpenCode's own default model selection.


## Request steering, reasoning effort, and endpoint capture

Request mutation and response capture intentionally have different scopes: **provider routing and catalog reasoning-depth injection remain strictly aliases-only** (non-alias request bodies are never modified), whereas **last-reply capture covers every successful (2xx) primary HTTP reply across all providers** so `alt+e` and `/model-compare` never display stale data after switching models.

### Provider routing injection

When a session uses one of the three aliases and the outgoing OpenRouter request targets that alias's resolved model ID, the plugin injects the catalog entry's `steering.provider` object under `body.provider` (stripping the raw block's top-level `model` key). `src/core/catalog.ts` projects `steering.provider` only when both `order` and `ignore` are non-empty string arrays — models whose live endpoints are all baseline-eligible (`ignore: []`) project no steering block and use OpenRouter's default routing:

- `order` — baseline-eligible endpoints sorted cheapest blended price first (eligible endpoints without a computable price are appended last).
- `ignore` — non-eligible endpoints (sub-default quantizations, schedule-gate failures, and separate variant listings).
- `quantizations` — precision floor (`default_precision` and higher); omitted when `default_precision` is `null` so an empty array never filters out every endpoint.
- `allow_fallbacks` — `true`, allowing OpenRouter to route outside `order` if every ordered provider is unavailable.

Injection boundaries:
- **Alias calls only:** selecting a concrete model ID directly never triggers steering, even if that model happens to match an alias's current pick. Primary turns and session compaction are steered; auxiliary calls on other models (such as title generation) are untouched.
- **User `provider` wins:** if the request body already contains a `provider` key, the plugin leaves it intact.
- **Missing steering degrades open:** if no catalog is available (for example, running on `options.fallback` offline) or the entry projects no `steering` block, the request proceeds unsteered. When no catalog source is available at all, the TUI shows a once-per-session toast (`cannot steer this session; OpenRouter default routing applies`), skipped if the request already supplied its own `provider`.

### Reasoning-depth pinning and variant mapping

Catalog entries record `quality` at `quality_effort` alongside `reasoning.depths` (`effort`, `index`, `cost_per_task_usd`). On alias requests that do not already carry `reasoning`, `reasoning_effort`, or an explicit OpenCode `#variant` selection, `reasoningEffortFor` injects `reasoning: { effort: quality_effort }` so the model runs at the thinking depth behind its score.

Two distinct gates apply:
- **Request injection (`gatewayEffort`):** allows only canonical OpenRouter gateway efforts (`max`, `xhigh`, `high`, `medium`, `low`, `minimal`, `none`), withholding `null` and catalog sentinels (`"reasoning"`, `"default"`) from the request body.
- **Variant and `alt` advertisement (`isSelectableDepth`):** additionally requires the effort to appear in `reasoning.supported_efforts` (or be a single-state reasoning model's `#none` toggle). In `/model-compare` text output, an `alt <effort> <index>` suffix appears only when a custom `catalogURL` serves an explicit-effort catalog where another selectable effort scored strictly higher than `quality_effort`. In the TUI report dialog (`alt+shift+m`), the scored effort appears in the inline `variant` column, and pressing `return` binds `openrouter/<id>#<variant>` when the session's location registry offers that variant (falling back to the bare model with an explanatory toast otherwise).
- **Variant vs. requested effort (`requestedEffortOf` and 256 KiB bounded body read):** `#variant` is only the model-ref selector; `requestedEffortOf` resolves the active effort in strict precedence: (1) `@opencode/ai`'s prompt-cache-preserving per-turn items (`body.input` `configuration_update` and `body.messages` `role: "system"` `output_config`, stopping at the most recent marker), (2) top-level body fields across OpenRouter/OpenAI (`reasoning.effort`, `reasoning_effort`), Anthropic (`output_config.effort`), and Google Gemini (`generationConfig.thinkingConfig.thinkingLevel` case-folded, plus `generation_config.thinking_level`), (3) the catalog effort *actually injected* by `injectReasoning` (`reasoningApplied ? catalogEffort : null`), and (4) `#variant` (ignoring `"default"` and `"thinking_level_unspecified"`). Non-alias primary requests and cold-start (`sourced === null`) alias requests read request bodies read-only via `readBoundedJsonBody` (`EFFORT_BODY_MAX_BYTES = 256 * 1024`), skipping `content-encoding` and oversized `content-length` headers up front and fire-and-forget canceling cloned stream readers past 256 KiB (`void reader.cancel().catch(() => {})` — avoiding WHATWG `ReadableStream.tee()`'s two-branch `cancelPromise` deadlock) to fall back cleanly to `#variant`.

Plugin-initiated alias switches never bind a variant. `applyAliases` copies the concrete pick's `variants` onto the alias so a manual `#variant` selection can resolve, but `/use-best` and `switchToPriority` pass only `providerID` and `id` (through `session.switchModel`, or `session.create` on the opening screen); `event.model.variant` is therefore `undefined` for root-default and frontmatter bindings, or `"default"` for `--model` and `switchModel`, and `reasoningEffortFor` treats both as unset. An explicit `#<variant>` on an alias ref can fail OpenCode model resolution with `Variant unavailable for openrouter/model-compare/<priority>: <variant>` when the pick lacks that variant. The error surfaces on paths that pass the variant to `SessionRunnerModel.resolve` (CLI `--model`/`--variant`, headless or API turns on a variant-bound session, subagent launches, and agent/command bindings); a synced TUI prompt drops an unavailable variant, and top-level `opencode.jsonc` `model` drops the variant entirely. Keep configuration and agent bindings bare.

### Bounded 4 KB response peek (`alt+e`)

To power `alt+e` and `/model-compare`'s transcript footer without buffering completions, every successful (2xx) `kind === "primary"` HTTP response across all providers writes an immediate placeholder in `state.lastReplies[sessionID]` (1-based `replySeq[sessionID]`, both `Object.create(null)` maps) and wraps `response.body` in a pass-through `TransformStream` inspecting at most the first `4096` bytes (`PEEK_MAX_BYTES`), forwarding every chunk byte-for-byte:

- **Request-exact `WeakMap` correlation:** `http.request` stores `{ order, effort }` on the final `Request` object in `state.applied: WeakMap<Request, ...>` (`order` is non-null only when `injectSteering` actually injected a block), eliminating concurrent per-session races with compaction/title calls. If a downstream plugin re-creates `event.request`, `steering` degrades safely to `"unknown"` while `requestedEffort` recovers `event.model.variant`.
- **Placeholder + `seq`-guarded multi-protocol upgrade:** non-2xx responses leave the prior reply intact; 2xx responses immediately overwrite any older record with `endpoint: null` and `steering: "unknown"`, then upgrade only while `replySeq[sessionID] === seq` (blocking slow older streams). `extractServedFields(prefix, final)` extracts `servedModel` across OpenRouter/OpenAI Chat (`model`), OpenAI Responses SSE (`response.model`), Anthropic Messages SSE (`message.model`), and Gemini (`modelVersion`), retaining `lastSeenModel` across SSE chunks and finalizing `{ provider: null, model: lastSeenModel }` at the 4 KB cap or stream `flush` without requiring `data: [DONE]`.
- **Tri-state steering and split attribute derivation:** `captureEndpoint` returns `"in-order"` or `"not-in-order"` only when both a non-empty `order` was applied and a parseable `provider` was served (`"unknown"` otherwise). In `reportFooter`, OpenRouter catalog lookup is gated strictly on `providerID === "openrouter"` (`servedModel` first, then non-alias `requestedModel`); `quantization` requires both a catalog match and a non-null `endpoint` (matching display names across `endpoints[]` as `default`, `above default`, `sub-default`, or `mixed`), whereas `effort` resolves independently — comparing against `reasoning.default_effort` in canonical deepest-first order when matched in the catalog, or emitting `{ value, relation: "unknown", default: null }` for non-OpenRouter, uncataloged, or offline replies.
- **Trust-boundary sanitization (`F-20`):** all catalog-, config-, and response-derived strings (`provider`, `model`, `endpoint`, quantization/effort attributes) pass through `sanitizeCatalogText` (control characters and line separators stripped, whitespace collapsed, capped at 120 characters) before entering TUI surfaces or synthetic LLM transcript messages.


## TUI architecture and precompilation

- **Why `dist/tui.js` is precompiled:** OpenCode's Solid JSX loader transforms `.tsx` plugin sources for local directory plugins, but skips files inside `node_modules` (falling back to a React transform that fails with `Cannot find package 'react'`). `scripts/build-tui.mjs` compiles `src/tui.tsx` into `dist/tui.js` using `@opentui/solid`'s Babel preset and rebases relative imports from `src/` to `dist/`. `dist/` is gitignored and built during `prepublishOnly` and CI.
- **Solid context & keymap registration:** keymap layers (`alt+m`, `alt+shift+m`, `alt+u`, `alt+e`, plus the modal list-dialog navigation layer) are registered from an `"app"` UI slot render function so they execute inside the mounted Solid provider tree rather than detached `setup` scope.
- **Worktree-aware session routing:** a TUI tab can view a session whose working directory is a linked git worktree with its own plugin instance and model registry. Event listeners (`report`, `cannotSteer`, `useBest`) match on the unique `sessionID` rather than filtering by directory, and `alt+e` / report-dialog variant checks route RPC and registry lookups to the session's own directory.
- **Responsive dialog geometry:** `showReportDialog` chooses OpenCode's `large` (88-column) dialog preset above 96 terminal columns and `medium` (60-column) narrower, clamping cell widths by terminal display width (`strWidth`, accounting for double-width CJK and emoji code points) and capping scrollbox height to `min(floor(h / 2) - 3, h - 12)`.
- **`alt+e` toast, `CapturePayload`, and transcript-only `lastResponseLine`:** the `report` RPC payload carries `CapturePayload` (`provider`, nullable `endpoint`, `model`, `steering`, validated in `src/rpc.ts`'s `captureSchema` and normalized by `toCapture` in `src/tui.tsx`). `alt+e` renders a decoupled multi-line toast (`last response`, `provider`, `endpoint: <name|unknown>`, optional `quantization` / `effort`, and `steering: in order | ! NOT in order | unknown`), while `lastResponseLine` (`last response: <model> @ <endpoint|unknown> (provider: <provider>)`) remains strictly transcript-only in `/model-compare` (`formatReport` and `report` RPC `text`) and is omitted from `showReportDialog` so the picker stays compact.
- **Update check:** at TUI startup, `context.client.plugin.check` inspects whether an active package-sourced install is marked `outdated`, surfacing a one-time info toast (`New version available - open /plugins to install`). Local directory installs are skipped.


## Local development, testing, and releases

### Running from a local checkout

OpenCode resolves local directory plugins strictly as `<dir>/index.*` (ignoring `package.json` `exports` and rejecting direct file paths), always npm-installs bare package names rather than reading `node_modules`, and only hot-watches npm-packaged plugins (so source edits require restarting OpenCode). Because OpenCode registers plugin IDs (`model-compare`) first-come-first-served, an installed global npm copy or an ancestor `opencode.json` (including when running inside `.worktrees/<branch>`; see [`.test/README.md`](.test/README.md)) shadows a manual `"./src"` entry. Use the helper script to avoid shadowing:

```sh
npm run dev                        # scratch project in /tmp/opencode/model-compare-dev
npm run dev -- --print-config      # inspect generated config (MC_DEV_DIR overrides path)
```

`npm run dev` isolates configuration (hiding global OpenCode config so an installed npm copy cannot shadow `./src`), while sharing your OpenCode data directory (credentials, sessions, and stored pins).

### Test suites and packaging checks

```sh
npm test                                              # hermetic unit + vendor conformance tests
npm run typecheck                                     # tsc --noEmit
npm run build && node scripts/pack-smoke.mjs          # build dist/tui.js and verify npm tarball
MC_INTEGRATION=1 npx vitest run tests/integration/    # live opencode serve suite (127.0.0.1:14721)
```

`fixtures/catalog-v0.7.0.json` is the recorded schema-v6 contract fixture; `fixtures/catalog-no-quality.json` is generated from it via `scripts/make-no-quality-fixture.py`. `MC_INTEGRATION=1` requires `opencode` and `python3` (plus `sqlite3` and network access for the live persistence/hydration cases), includes the permanent `Request`-identity guard (`tests/integration/identity-probe/` and `tests/integration/identity-probe.test.mjs`) verifying that `http.response` receives the post-injection `Request` object `WeakMap` correlation depends on, and must run one session at a time because its harness sweeps `tests/integration/data/run-*` and manages port `14721`. `scripts/pack-smoke.mjs` checks tarball structure and imports offline — install the packed tarball into a scratch project to verify OpenCode loads it before cutting a release.

### Publishing to npm

Cutting a GitHub release tagged `vX.Y.Z` (note: GitHub pre-releases also fire the `published` trigger) runs `.github/workflows/release.yaml`, which executes `build`, `typecheck`, `test`, `pack-smoke`, and the remote `catalog.json` v6 canary, verifies that the git tag matches `package.json`'s `version`, and stages the tarball on npm via OIDC trusted publishing. On npmjs.com, the trusted-publisher entry must match `release.yaml`, `canonical/model-compare-opencode-plugin`, and the `release` environment with **both** "Allow npm publish" and "Allow npm dist-tag" unchecked (stage-only posture). A maintainer completes publication by approving the staged package with 2FA on npmjs.com or via `npm stage approve <stage-id>`.

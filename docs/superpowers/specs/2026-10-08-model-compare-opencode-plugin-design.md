# model-compare-opencode-plugin: v1 design

- **Status:** Draft for review. Not committed (commit on request only).
- **Date:** 2026-10-08
- **Repo:** `canonical/model-compare-opencode-plugin` (private). Worktree branch `design/v1`.
- **Upstream:** `canonical/model-compare` (GPL-3.0), pinned to `v0.3.1` (upgraded from `v0.2.5` to `v0.3.0` on 2026-10-10 for the effective-tier pricing fix and catalog schema v2, then to `v0.3.1` the same day).
- **Platform:** OpenCode v2 (CLI 2.0.16), plugin SDK `@opencode/plugin` 2.0.16.

## 1. Summary

The plugin picks the best value-for-money OpenRouter model from model-compare's ranking for one of three priorities: `balanced`, `price`, or `quality`. The pick is available without hard-coding a model ID:

- as the root default model;
- as the model of subagents, and of primary agents when selected in the TUI (`.opencode/agents/*.md` or `opencode.jsonc`);
- through `/use-best` (switch the session) and `/model-compare` (show the ranking).

Picks refresh while OpenCode runs. Ranking data comes from a vendored copy of `model_compare.py` (default) or the published `catalog.json`.

## 2. Decisions

| Topic | Decision |
|---|---|
| Scope | Picks for the root default and agents, `/model-compare`, `/use-best [priority]`, pinning, fallback, weight overrides for the named priorities, vendored local mode and remote catalog |
| Namespace | Aliases `openrouter/model-compare/{balanced,price,quality}` inside the existing OpenRouter provider. No new provider, no new credentials |
| Agent model | Verified (2026-10-09): an agent's `model` applies to subagent launches, and the TUI applies it on selection, re-applying it on every mid-session switch. Headless paths (`opencode run --agent`, server-side agent switch, create-with-agent) do not apply it — the root config (or `--model`, or `/use-best`) governs |
| Failure | An agent configured with a disabled alias fails loudly on primary requests (the guard), even when the root-governed effective model is healthy — a deliberate trade-off (§9). A subagent fails via OpenCode's own check. The root default, and sessions switched to an alias with `/use-best`, fall back to OpenCode's choice and log. No session notice |
| Data source | `source: "auto"`: vendored script when `python3` 3.10+ is available, otherwise the remote catalog |
| Weights | Override the four component weights of the named priorities only. Named weight sets are roadmap |
| Pin state | One pin/last-known-good record per priority and effective weights, in `ctx.storage`. Concurrent OpenCode processes: last writer wins (accepted; pins are advisory state) |
| Upstream | Vendor the script at a release tag. Upgrades are reviewed PRs |
| OpenCode V1 adapter | Out of v1 |
| Packaging | npm `model-compare-opencode-plugin`. Plugin id `model-compare`. Standalone repo |
| License | GPL-3.0 for the whole plugin |

## 3. Configuration

```jsonc
// opencode.jsonc (project or global)
{
  "$schema": "https://opencode.ai/config.json",
  "model": "openrouter/model-compare/balanced",
  "plugins": [
    {
      "package": "model-compare-opencode-plugin",
      "options": {
        "source": "auto",
        "defaultPriority": "balanced",
        "fallback": "openrouter/anthropic/claude-sonnet-4.5",
        "weights": { "quality": { "quality": 0.5, "price": 0.3, "context": 0.1, "age": 0.1 } },
        "pinDays": 14,
        "minLead": 0.03
      }
    }
  ]
}
```

```md
---
description: Reviews changes for correctness
mode: subagent
model: openrouter/model-compare/quality
---
```

| Option | Default | Meaning |
|---|---|---|
| `source` | `auto` | `auto`, `local`, or `remote` |
| `defaultPriority` | `balanced` | Priority used by `/use-best` with no argument |
| `fallback` | unset | `openrouter/<id>` used when no pick is available. Only OpenRouter models work: the alias's `modelID` lives inside the `openrouter` provider. Runnability is checked at each resolution (§9) |
| `weights` | upstream | Partial overrides per named priority, merged and normalized as in §6 |
| `pinDays` | 14 | Proposed. Age after which a pick is re-evaluated (§7) |
| `minLead` | 0.03 | Proposed. Score lead needed to replace a pinned pick (§7) |
| `catalogURL` | published catalog | Remote source URL. Only point it at a source you trust: it decides which models can be picked |
| `scriptPath` | vendored copy | Development override for a local `model_compare.py` |

**Validation.** On any violation the plugin logs a warning and uses the default (for `weights`, it ignores the override for that priority). It never throws from `setup`, and the aliases stay functional.

| Option | Rule | On violation |
|---|---|---|
| `source` | One of `auto`, `local`, `remote` | Warn, use `auto` |
| `defaultPriority` | One of `balanced`, `price`, `quality` | Warn, use `balanced` |
| `fallback` | String of the form `openrouter/<id>`, `<id>` non-empty | Warn, treat as unset |
| `weights` | Keys are named priorities; each value has only `quality`, `price`, `context`, `age`, each a finite number ≥ 0; the merged map (§6) sums to more than 0 | Warn, ignore the override for that priority |
| `pinDays` | Finite number > 0 | Warn, use 14 |
| `minLead` | Finite number in [0, 1] | Warn, use 0.03 |
| `catalogURL` | Parsable `https:` URL | Warn, use the published catalog |
| `scriptPath` | Non-empty string | Warn, use the vendored copy |

## 4. Architecture

- **Core** (`src/core/`): pure TypeScript. Takes a validated catalog and stored state, and returns ranked candidates, picks, pin decisions, and fallback resolution. No OpenCode imports and no I/O.
- **Sources** (`src/sources/`): `remote` (HTTPS fetch with timeout and cache) and `local` (vendored script via `execFile`). Both produce the same catalog document.
- **Adapter** (`src/opencode/`): all OpenCode V2 calls. Options parsing, alias registration (model transform), the refresh loop, the agent guard (`http.request` hook), commands, persistence through `ctx.storage`, and logging.
- **Vendor** (`vendor/`): `model_compare.py`, `UPSTREAM.json`, recorded fixtures, and the sync script.

## 5. Data contract

Read from catalog schema v2 (the only accepted version, see the rules below):

- `schema_version` (must be 2) and `generated_at`.
- `parameters.weights`: effective weights per priority (`quality`, `price`, `context`, `age`). When no candidate has quality data, upstream removes the `quality` key entirely and renormalizes the rest; a missing key means weight 0.
- `rankings`: ordered candidate IDs per priority.
- `models[]`: `id`, `name`, `pricing.blended_per_1m`, `context`, `tool_calling`, `zdr`, `expired`, `quality`, `scores.{quality,price,context,age}`, and `scores.overall.{balanced,price,quality}`.
- `filtered[]`: diagnostics only.

Rules:
- **Required:** `schema_version`, `generated_at`, and `models[]` with each entry's `id` and `scores` (components and `overall`). A missing required field, or a `schema_version` other than 2 (upstream's current contract — the plugin has never shipped, so no stored v1 documents exist to transition), rejects the document. The previous one stays in use.
- **Schema v2 (upstream 0.3.0):** the `pricing` scalars hold effective-tier values (the tier in effect at `--min-context` tokens — worst case for a long session), with additive `pricing.base`/`pricing.tiers`/`pricing.schedule` sub-objects and a top-level `schedules` deals index; a `schedule` drop reason exists. The fields the plugin consumes kept their shape, so both versions read identically; the additive fields are ignored.
- **Optional, with fallbacks:** `rankings` (missing: sort by `scores.overall[priority]`, §6); any key of `parameters.weights[priority]` (missing: weight 0); `parameters.weights` itself (missing: upstream's `PRIORITY_WEIGHTS` from the pinned tag). Other listed `models[]` fields are optional for ranking; missing `quality` counts as 0 in the tie-break, and missing display fields are shown as `-`.
- Unknown fields are ignored. Upstream adds fields without a schema bump when they are additive (`rankings` appeared between v0.2.2 and v0.2.5 at schema 1), and bumps the version when consumed semantics change (pricing became effective-tier at schema 2).
- The plugin records its own acquisition time for every accepted document, for either source. That time, not `generated_at`, is the data age (§9, §10).

## 6. Ranking and weights

- **Candidates** are upstream's `models`. The plugin doesn't re-apply upstream's filters. Availability is a separate, OpenCode-side check ("runnable", §7): the provider must be connected and the model enabled.
- **No override for a priority:** use `rankings[priority]`. If `rankings` is missing, sort by `scores.overall[priority]` with the tie-break below.
- **Override for a priority:** start from upstream's `parameters.weights[priority]`, replace the keys the user set with the user's values, and normalize the merged map to sum 1 (rescale all keys). Example: balanced (0.4/0.4/0.1/0.1) with `quality: 0.5` → merged {0.5, 0.4, 0.1, 0.1} → normalized {≈0.4545, ≈0.3636, ≈0.0909, ≈0.0909}. The score is `quality·w_q + price·w_p + context·w_c + age·w_a`, summed in that order to match upstream's operand order.
- **Override precedence with missing data:** if upstream's `parameters.weights[priority]` lacks the `quality` key (no candidate has quality data), a user override for `quality` is ignored for that priority, `quality` stays missing (weight 0), and the plugin logs a warning. The other keys apply.
- **Zero sum:** "a zero sum is a config error" means the merged map sums to 0 (§3 validation). If the merged map sums to 0 only at runtime (for example, the user gave weight only to `quality` and the catalog has no quality data), the plugin uses upstream's weights for that priority and logs a warning.
- **Tie-break:** every plugin-side ordering sorts by `(-score, -(quality ?? 0), pricing.blended_per_1m ascending, id ascending)`, mirroring upstream's `ranking_key`.
- **Rounding:** catalog component and overall scores are rounded to 4 decimals, while upstream builds `rankings` from unrounded scores. A recomputed order (override path, or no `rankings`) may therefore differ from `rankings` on near-ties. That is expected.
- Users who override only some keys follow upstream's changes to the remaining defaults.
- **Exactness:** overrides are exact only for the default candidate pool, because component scores are normalized across that pool.

## 7. Picks and pinning

For each priority:

1. **Runnable:** a candidate is runnable if OpenCode lists `openrouter/<id>` as an enabled model (`ctx.model.list()`). The best candidate is the first runnable one in ranked order (§6).
2. **Pin/last-known-good state:** one record per priority, `{ v: 1, id, since }`, in `ctx.storage` under the key `pin/<priority>/<hash of the effective weights used for that priority>`, so different weight configurations don't collide. The record is both the pin and the last-known-good pick. Corrupt or unknown-version entries are discarded with a warning and treated as no pin. Bad state never crashes the plugin.
3. **Storage scope and concurrency:** `ctx.storage` is scoped to the plugin. Concurrent OpenCode processes (for example, the TUI and `opencode serve`) refresh independently, and the last writer wins. This is accepted: pins are advisory state.
4. **Rules**, with a fresh catalog:
   - No pin: adopt the best candidate.
   - Pinned model no longer in the pool, or not runnable: switch to the best candidate now.
   - Pin older than `pinDays`: switch to the best candidate (which may be the same model).
   - Otherwise, switch only when the best candidate's score exceeds the pinned model's score by at least `minLead`. Both scores are computed from the current catalog under the current weights.
5. **Resolution order:** pin (if valid under the rules above and runnable) → best runnable candidate → `fallback` (§9) → alias disabled.
6. `since` resets every time a pin is adopted or re-adopted, including when the best candidate after `pinDays` is the pinned model.
7. Scores are on upstream's 0–1 overall scale.
8. The fallback is never stored as a pin.
9. The last validated catalog document, with its acquisition time, is persisted to `ctx.storage`, so ranking and `/model-compare` work offline after a restart. The record is keyed by the **source identity** (`doc/cache/<hash of remote:<catalogURL> or local:<scriptPath|vendored>>`, with the identity repeated in the record): a document is only served for the source that produced it, so changing `catalogURL`, `scriptPath` or `source` is a cache miss rather than up to six hours of the previous source's data. Under `auto`, setup seeds from the newest valid record of the local and remote identities. A cached document is re-validated on every read (§5 rules, applied to the stored projection); an invalid record is discarded with a warning and treated as no cache.

## 8. Aliases and refresh

- **Aliases:** `openrouter/model-compare/<p>` for each priority.
- **Registration:** a model transform. `editor.update("openrouter", "model-compare/<p>", …)` sets `modelID` to the pick, `name` to `Model Compare: <p> → <pick>`, and `enabled` to true. It copies `capabilities`, `limit`, `cost`, `variants`, `time`, and `status` from `editor.get("openrouter", <pick>)`. With no pick, `enabled` is false (§9). If `editor.get("openrouter", <pick>)` returns nothing (for example, another plugin removed the model), the alias is disabled and a warning is logged; the plugin never skips the alias silently.
- **Verified in the spike:** the alias appears in the model registry with the current `modelID`. Agents and the root default dispatch to it, both in a fresh server and after a plugin file reload.
- The alias `name` (`Model Compare: <p> → <pick>`) is what the TUI and picker display; it keeps the concrete target visible and updates on refresh. The wording is a design choice, revisitable before release.
- **Startup:** setup never blocks on data. `setup` reads the stored pin and catalog, registers each alias from its stored pin if that model is runnable (otherwise the `fallback`, otherwise disabled), and starts the first refresh in the background.
- **Refresh:** a timer checks for new data every 30 minutes (proposed). The plugin cache TTL is 6 hours for both sources, matching upstream's publishing cadence. Any change to a pick or fallback state triggers `ctx.provider.reload()`, `ctx.model.reload()`, and `ctx.agent.reload()`, in that order. The spike used this combination; the minimal set is not yet isolated. Refreshes never overlap within a process. Each tick is bounded: the remote fetch times out after 30 s, the interpreter probe after 10 s, the script after 60 s, and the whole tick after 180 s (sized to outlast the reload chain, §15 item 1); a tick that hits its deadline is abandoned and the non-overlap guard released. A tick that cannot get a fresh catalog (any source failure) still re-resolves each priority without one (§9: stored pin if runnable → fallback if runnable → none) against what OpenRouter lists now. The tick computes the next picks first, persists, then replays the registries and only then marks the picks as applied; the guard and `/use-best` read the applied view, so a failed persist or reload is never reported as a change and the next tick retries it.
- **Known risk:** one spike server process kept dispatching a stale pick after changes. I could not isolate the cause, and later processes refreshed correctly. The integration suite checks the wire model after every change (§13).

## 9. Fallback and failure

Resolution per priority (with no fresh catalog, or when the fresh rules in §7 yield no runnable candidate):

1. Pin/last-known-good (§7), if its model is runnable. A pin whose model is gone or not runnable is skipped.
2. The `fallback` option, if it is runnable at the time of resolution. At setup, a fallback that isn't runnable only logs a warning.
3. None: the alias is disabled.

Effects. All verified in the spike unless marked otherwise.

- **Agent configured with a disabled alias:** for `kind === "primary"` requests only (title, compaction, and generate requests are excluded), the `http.request` hook throws `model-compare: no ranking data for openrouter/model-compare/<p>; set options.fallback or check the data source`. The request aborts, and no model response comes back. The guard is agent-agnostic: at request time it looks the agent up with `ctx.agent.get({ agentID })` and fires only when the agent's configured `model` (a `{providerID, id}` ref) is `openrouter` / `model-compare/<p>` and that alias is disabled. `event.model` cannot be used as the key because it already shows the effective (fallback) reference. Setup-time agent lists don't include file-defined agents. The inputs are verified; the guard itself is not yet (§14).
- **Deliberate trade-off:** the guard protects the configuration's intent ("this agent must run on the alias"). It therefore fires even when the root-governed effective model is healthy, for example on headless primary runs that never apply the agent's `model`.
- **Root default with a disabled alias:** OpenCode falls back silently to its own choice. The plugin logs one warning per refresh. No session notice, as decided. This matters beyond the root case: for primary runs the root config governs in general (an agent's own `model` is not applied, verified for `mode: primary` and `mode: all` agents alike, and for both server-side flows — agent switch and create-with-agent), so the guard is the only protection for alias-configured agents. Exception: selecting an agent in the TUI applies its `model`, re-applied on every mid-session switch (verified with the alias — the pick served; away to `build` → the root model).
- **Session switched to an alias with `/use-best`:** if the alias is disabled later, the session falls back silently and the plugin logs it, as for the root default. The guard does not cover this case.
- **Subagents:** verified (2026-10-09). Enabled: the subagent's request dispatches to the current pick through its configured alias. Disabled: OpenCode fails the launch with `Model unavailable: openrouter/model-compare/quality` before any HTTP request, so OpenCode already fails loudly here and the guard isn't needed.
- **OpenRouter provider missing:** the aliases live under the `openrouter` provider. If it is not connected in the project, the aliases cannot be created: the plugin warns at setup and on every refresh, alias references fail with `Model unavailable` for subagents, and primary runs fall back silently.
- **Offline:** picks stay on pin/last-known-good. Warnings go to the log. `/model-compare` shows the data age, which is the plugin's own acquisition time of the document. It is not upstream's `generated_at`, which the script sets at build time even when it serves its inputs from cache.
- **Local-mode failure:** missing `python3` 3.10+, any non-zero exit, a timeout, invalid JSON on stdout, or a rejected document (§5). The exit code only refines the log message: 1 is a fetch or ranking failure (including missing ZDR data), and 2 is either "no candidates" or an argparse usage error, so 2 must not be read as "no candidates" alone. stderr goes to the log. `auto` falls back to remote. Explicit `local` reports the error and keeps pin/last-known-good.

## 10. Commands

- **`/use-best [priority]`:** priority defaults to `defaultPriority`. Switches the session to `openrouter/model-compare/<p>` via `ctx.session.switchModel`, so the session follows the pick while the alias is enabled. If the alias is disabled later, the session falls back silently with a log line (§9). Verified end to end through the command API: the handler receives the argument as `prompt.text` (`POST /api/session/{id}/command`, `{ "name", "text" }`), `switchModel` accepts the alias, and follow-up requests dispatch to the current pick; switching to a concrete model also works. The command refuses to switch to a disabled alias and reports the error instead. The TUI path of `/use-best` is not tested.
- **`/model-compare`:** top 5 per priority with scores and data age (the plugin's acquisition time, §9), from the persisted catalog (§7). Rankings use the configured `weights` overrides (the same ones the aliases resolve with), priorities with an override are labelled `(custom weights)` and show the recomputed score, and the pick each alias currently serves is marked (a hysteresis pin can differ from rank 1; a pick outside the top 5, a fallback, or a disabled alias gets its own `Current pick:` line). Every plugin message (`/model-compare` output, `/use-best` confirmations and refusals) is a synthetic message sent with `resume: false`, which the v2 API documents as admitting the message without scheduling a model turn. **Outcome (live-verified 2026-10-10):** such a notice is NOT visible immediately — in a headless session it surfaces in the transcript at the session's next turn (integration-verified in ops-cases 1–2); immediate feedback in the TUI is the `./tui` entry's job (status slot + toasts). Headless does not resume: the one-extra-turn cost was dropped in favor of deferred visibility. With no data, `/model-compare` says so.
- **Unknown priority:** an error listing the valid names.

## 11. Vendoring and upgrades

**Vendored:** `vendor/model_compare.py` (byte-identical to one release tag), `vendor/UPSTREAM.json` (`repo`, `tag`, `commit`, `sha256`), and `LICENSE` (GPL-3.0 for the whole plugin). Current pin: `v0.3.1` (upgrade history: `v0.2.5` → `v0.3.0` on 2026-10-10 — effective-tier pricing fix, schema v2; conformance net caught the import-allowlist change `urllib.parse` and re-recorded the fixtures; `v0.3.0` → `v0.3.1` on 2026-10-10 — the only change to `model_compare.py` is `VERSION`, the catalog contract is unchanged (still schema v2), so the `v0.3.0` catalog fixtures remain the contract fixtures).

**Upgrade procedure:**
1. A sync script resolves the tag to its commit, fetches `raw.githubusercontent.com/canonical/model-compare/<commit>/model_compare.py` (the commit, not the mutable tag), records the commit and the file's sha256, and prints the CHANGELOG section for that version.
2. Conformance tests run against fixtures recorded at that tag.
3. A reviewer reads the script diff. CI lists new imports, URLs, environment variables, and subprocess calls.
4. Release: a plugin version with a changelog line naming the upstream tag.
5. Users run `opencode plugin update`. OpenCode checks for updates but doesn't apply them.

A scheduled workflow (`upgrade-pr.yml`) opens a draft upgrade PR when upstream's latest release is **newer** than the pin (never a downgrade), and does nothing when the `vendor/<tag>` branch or an open PR already exists. A PR opened with `GITHUB_TOKEN` does not trigger `pull_request` workflows, so the workflow dispatches `test.yml` (`workflow_dispatch`) on the branch itself; the check runs attach to the PR's head commit. The PR body lists the added script lines that touch imports, URLs, environment variables, subprocesses and file writes. Nothing merges automatically.

**Checks:**
- Per PR: `--version` prints `model-compare <x.y.z>`, and its trailing token equals the pin's tag without the leading `v` (tag `v0.2.5` → `0.2.5`); `schema_version` is 2; required fields are present; recomputed `overall` equals upstream within rounding for every model and priority; the plugin's default ranking, which uses `rankings` directly (no override), equals `rankings` (not asserted for recomputed orders, §6); imports are standard library only (every `import x`, `import a, b` and `from x import y` form is checked against an allowlist, and `__import__`/`importlib` fail the check); the upgrade PR body lists added lines touching URLs, environment variables, subprocess calls, and file writes for the reviewer (no automated pass/fail on those); the script runs on Python 3.10; `LICENSE` and the header are reviewed when they change.
- Smoke test: the runner's invocation succeeds, and a deliberately invalid flag is classified as a usage error (exit 2 with argparse usage on stderr), distinct from "no candidates".
- Nightly canary: a live run of the vendored script, checking schema, a non-empty pool, and required fields. Catches upstream data-source breakage.
- Weekly drift (`drift-check.mjs`), two checks. (1) **Vendor drift:** the script is re-fetched at the commit pinned in `UPSTREAM.json` and its sha256 compared with the vendored file (and with the recorded sha256); a mismatch fails the run. This is the check that ties the pin to upstream's actual bytes; the offline conformance test only compares the file with a hash recorded in the same PR. (2) **Published-contract consistency:** the published `rankings` top 5 per priority against the order derived from the published `scores.overall` (near-ties tolerated); it fails at 3 or more real differences. Neither check reports that upstream has a newer tag (that is `upgrade-pr.yml`), and the second does not compare against the vendored script's own output.

**Upstream changes and responses:**

| Upstream change | Caught by | Response |
|---|---|---|
| Schema bump or removed field | Conformance test; runtime rejects unknown versions | Hold the release. Users keep pin/last-known-good |
| Overall no longer follows from components and weights | Recomputation test | Investigate before release |
| Priority names or weight keys change | Conformance test | Config break. Decide on a mapping |
| CLI flag or exit code changes | Smoke test | Adapt the runner |
| New import, URL, or environment variable | Import allowlist; diff scan | Blocks the PR until reviewed |
| Python minimum raised | CI on Python 3.10 | Raise our minimum or hold |
| Data source breaks | Nightly canary | Wait for upstream, then re-vendor |
| License or notice changes | `LICENSE` and header diff | Stop and review |
| Meaning changes without a test-visible effect | Weekly drift check | Schedule an upgrade |

**Runtime guards:** `execFile` (no shell), a timeout (proposed 60 s), and a minimal environment: `HOME`, `PATH`, plus, when set, `XDG_CACHE_HOME`, `AA_API_KEY`, `HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY`, `http_proxy`, `https_proxy`, `no_proxy`, `SSL_CERT_FILE`, and `SSL_CERT_DIR` (proxied networks and custom CAs). stdout is parsed as JSON, and stderr goes to the log. The script keeps its own cache under `~/.cache/model-compare/` (or `$XDG_CACHE_HOME/model-compare/`), which the CLI shares; the plugin's 6-hour cache sits on top of it (§8).

## 12. Packaging and install

- npm package `model-compare-opencode-plugin`: `"type": "module"`, `exports` pointing at the TypeScript entry and, since 2026-10-10, at the terminal-UI half (`"./tui": "./src/tui.tsx"` — the footer status slot and the /use-best toasts, with `@opentui/core`, `@opentui/solid` and `solid-js` declared as peers OpenCode's runtime provides), and `files` of `src/`, `vendor/model_compare.py`, `vendor/UPSTREAM.json`, `LICENSE`, and `README.md`. Fixtures and the sync script stay out of the package.
- **Packaging check (CI):** `scripts/pack-smoke.mjs` runs `npm pack`, unpacks the tarball, and verifies that its files are exactly the list above, that the `exports` map points at a packaged file, and that every relative import and the vendored-script locator in `src/` resolve inside the package. **Deferred:** loading the *installed* package in a real OpenCode (it needs the opencode binary and an authenticated provider, so it stays a manual/integration step). The raw-`.ts` `exports` entry is the V2 docs' pattern, but the repo's own evidence is mixed — the harness found local-directory plugins resolve `<dir>/index.*` and ignore `exports`, while the README's bridge package relies on `exports` — so a release must be confirmed by installing the tarball into a scratch project before publishing.
- `@opencode/plugin` as a regular `dependency`, pinned to the release we test (2.0.16), following the V2 publish manifest.
- OpenCode installs npm plugins from the `plugins` entry. Spike finding: a local directory plugin needs its dependencies installed in its own folder. Local development uses the same install step, and releases are tested as installed packages (per the V2 docs).
- Repo: `canonical/model-compare-opencode-plugin`, private. First commit `3b93e42` on `main` (`.gitignore` only).

## 13. Testing

- **Unit (core, no OpenCode):** ranking with and without overrides; the merge-and-normalize rule (§6 worked example); the tie-break order; a catalog fixture with no quality data (missing `quality` weight key, quality override ignored, runtime zero-sum falls back to upstream weights); operand order; pin rules (including `since` reset and the resolution order); pin keys per effective-weights hash; the fallback chain; config validation (each §3 rule, with the warning-and-default behavior) and catalog validation (required versus optional fields).
- **Local try-it env:** the repo ships `.test/` — a bridge package (relative re-exports of `src/index.ts` and `src/tui.tsx`, own dependencies) plus a scratch project pointed at it. It is the live-verified local-install recipe of §12, with the fallback model set per environment.
- **Conformance (vendor):** fixtures per tag, with the checks in §11.
- **Integration (OpenCode):** a scripted harness, as in the spike. `opencode serve` on a dedicated port with `OPENCODE_SERVER_PASSWORD` set; a scratch project with the plugin; an `http.request` probe that records the wire model per request. Cases:
  - agent and root default dispatch to the pick;
  - pick change, then the next run uses the new pick (agent and root);
  - the same, after a plugin file reload;
  - disabled alias: the agent run fails with the guard error; the root falls back and logs;
  - the guard fires for an agent it has never seen (not named in the plugin or the harness), keyed only on its configured model;
  - the guard ignores title, compaction, and generate requests;
  - `/use-best` via the command API;
  - subagent with a disabled alias: the call fails with `Model unavailable`;
  - startup offline: the stored pin is served, and setup doesn't block;
  - OpenRouter provider missing: setup warns, aliases are absent, the root falls back;
  - `auto` falls back to remote after a local failure (non-zero exit, invalid JSON, or timeout);
  - the stale-dispatch case: the wire model is checked after every change;
  - assumption checks the design rests on: a primary run uses the root config model even when the agent configures another (any agent mode); a subagent dispatches through its configured alias to the pick; `/use-best` switches the session and follow-ups dispatch to the pick, and it refuses a disabled alias; the guard fails any agent configured with a disabled alias and leaves agents with real models alone; `/model-compare` costs one model turn.
- **Manual:** TUI checks. Done (2026-10-09): selecting an alias-configured agent in the TUI applied its model, and mid-session switches re-applied it in both directions (to the alias → the pick; away to `build` → the root model). Still open: `/use-best` in the TUI, and the picker display.

## 14. Spike evidence (2026-10-08/09)

Throwaway code and logs: `/tmp/opencode/alias-spike`.

| Question | Result |
|---|---|
| Alias as agent model | Works in a fresh server. The wire model is the current pick |
| Alias as root default | Works. The CLI shows `build · model-compare/quality` |
| Pick change without restart | Works for agent and root, including after a plugin file reload |
| Disabled alias, agent | Silent fallback to `anthropic/claude-haiku-5.5` via OpenRouter |
| Disabled alias, root | The same silent fallback |
| Loud failure | Works. Throwing in `http.request` aborts the request |
| Synthetic message | Visible in the CLI, but starts another model turn in that session |
| `/use-best` | The argument arrives as `prompt.text` via the command API |
| Two config layers, same package | One instance, with the higher layer's options and no merge |
| File-defined agents | Absent from `ctx.agent.list()` at setup, present after an agent reload. `ctx.agent.get` works at request time |
| `session.created` | Published, with `data.sessionID` |
| Subagent with disabled alias (2026-10-09) | OpenCode fails the call with `Model unavailable` before any request |
| Agent `model` on a primary run (2026-10-09) | Not applied: the root config governs; `--agent` selects the agent only. Explains the earlier "Haiku instead of Flash-Lite" run — the root alias was disabled, so OpenCode's fallback answered |
| Subagent with enabled alias (2026-10-09) | The subagent dispatched to the current pick through its configured alias |
| `switchModel` to the alias (2026-10-09) | Works: follow-up requests dispatch to the pick; switching to a concrete model also works |
| Guard key (2026-10-09) | Must be the agent's configured model: `event.model` already shows the effective (fallback) reference when the root alias is disabled |
| Guard inputs versus guard (2026-10-09) | Inputs verified: `ctx.agent.get` returns the configured model at request time, and `Agent.Info.model` is a `{providerID, id}` ref (from the spike's `agent.lookup` logs; raw log since truncated, observation recorded in session). The agent-agnostic, `ctx.agent.get`-keyed guard is not yet implemented or verified: the spike's throw used a name-keyed stand-in (`event.agent === "mc-quality"`). Covered by the §13 never-seen-agent case |
| `mode: all` agent launched as primary (2026-10-09) | Root config governs; the agent's `model` key is not applied. The key binds only in the subagent role |
| Agent switch on an existing session (2026-10-09) | `POST /api/session/{id}/agent` changes the agent but not the model: the follow-up request used the session's existing model, and the CLI showed `mc-lead · <root model>` |
| Session created with an agent (2026-10-09) | `POST /api/session {agent}` does not apply the agent's `model`: the first request used the root-derived model |
| TUI agent selection (2026-10-09) | Honors the agent's `model`: after selecting `mc-lead` in the TUI, the session's model was the alias and requests dispatched to the pick. Mid-session switches re-apply it in both directions: to `build` → the root model, back to `mc-lead` → the alias and the pick. The server's API-call log was lost to a redirect, so the mechanism (an explicit model switch) is inferred; the behavior is verified |

Corrections to earlier assumptions:
- A local plugin entry must be a directory. A `.ts` path fails with "configured plugin path must be a directory", although the docs example shows one.
- `ctx.model.list()` returns `{location, data}`, not an array.
- A disabled alias doesn't produce the "Model unavailable" error I expected. OpenCode falls back.
- `opencode run "/command"` sends the text to the model. Commands need the API or the TUI.
- `model_compare.py --version` prints `model-compare 0.2.5`, not the bare version.

## 15. Open questions

Resolved in review (2026-10-09). Each item states the outcome.
1. **Reload set:** which of the provider, model, and agent reloads are needed for refresh. **Outcome:** keep all three; narrowing is deferred (roadmap). **Measured cost (integration harness, 2026-10-10, one machine; not a spike):** after a pick change the alias flips about 90-105 s later, and runs started during the provider→model→agent reload chain block until it finishes (`tests/integration/harness.mjs`: `RUN_TIMEOUT_MS`/`SETUP_TIMEOUT_MS`). A change happens at most once per refresh tick and only when the pick actually changes (picks are pinned, §7), so the latency is occasional, but it is real and user-visible. Finding the minimal reload set (or whether `ctx.model.reload()` alone suffices) is the first thing to try if it hurts. The tick's own deadline (180 s) is sized to outlast this chain.
2. **Stale dispatch:** the root cause, or a regression test that shows it can't recur. **Outcome:** a regression test is must-have before ship. It checks the request model after each change (§13).
3. **Subagents:** whether the guard covers subagent requests. **Outcome:** tested. OpenCode fails the subagent call with `Model unavailable` before any HTTP request, so the guard isn't needed there (§9).
4. **`/model-compare` output:** a synthetic message starts a model turn. **Outcome (revised 2026-10-10):** the message is now sent with `resume: false`, which the API documents as not scheduling a turn. **Visibility (live-verified 2026-10-10, integration ops-cases 1-2):** the notice is NOT immediate — it surfaces in the transcript at the session's next turn. The TUI's immediate feedback is the `./tui` entry (status slot + toasts), not a resumed notice; resuming (one extra model turn per call) was dropped.
5. **Plugin logging:** where warnings surface. **Outcome (corrected 2026-10-10):** the plugin SDK (2.0.16) exposes no logging API, and the server API only offers an experimental per-session log. Warnings go through `console.warn`/`console.error`, but the integration harness showed that this output does **not** reach `opencode serve`'s stdio nor any shared OpenCode log file (README, Troubleshooting). The earlier "lands in the server log" statement was wrong. Every "the plugin logs a warning" in this document therefore means "emits `console.warn`/`console.error`, which is currently invisible". The only visible diagnosis channel is the `/model-compare` output (data age, no-data line). Surfacing more state there (last refresh error, current picks) is a follow-up.

Confirmed in review (2026-10-09):
6. Pin defaults (`pinDays` 14, `minLead` 0.03) and refresh cadence (30-minute checks, 6-hour cache). **Outcome:** accepted. They are tunable options.
7. Repo visibility (private until publish) and npm scope (unscoped for now). **Outcome:** keep the repo private until the first publish, then make it public. npm stays unscoped.
8. Guard scope and false positives. **Outcome:** the guard covers `kind === "primary"` requests only, and fires for alias-configured agents even when the root-governed effective model is healthy (deliberate trade-off, §9). Sessions on an alias via `/use-best` or the root default fall back silently with a log line.
9. Pin concurrency across processes. **Outcome:** last writer wins; accepted because pins are advisory state (§7).

## 16. Out of scope for v1

Named weight-set tweaking, local knob pass-through (filters, input share), picker curation, an agent-facing tool, a TUI status widget, provider failover, the OpenCode V1 adapter, other providers, and a visible root-default notice. These are parked in `/home/rkratky/.opencode/plan/model-compare-opencode-plugin-roadmap.md`.

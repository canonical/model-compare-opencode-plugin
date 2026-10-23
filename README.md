# model-compare-opencode-plugin

An [OpenCode](https://opencode.ai) v2 plugin that picks the best value-for-money OpenRouter model from [canonical/model-compare](https://github.com/canonical/model-compare)'s ranking, for three priorities: `balanced`, `price`, `quality`. Ranking data comes from a vendored copy of upstream's `model_compare.py` (default) or the published `catalog.json`.

Each priority is a live alias inside the existing OpenRouter provider — no new provider, no new credentials:

| Alias | Resolves to |
|---|---|
| `openrouter/model-compare/balanced` | best all-round value pick |
| `openrouter/model-compare/price` | best price pick |
| `openrouter/model-compare/quality` | best quality pick |

The alias re-points at the current pick while OpenCode runs (refresh every 30 minutes, data cache 6 hours). OpenCode's model picker shows it as `Model Compare: <priority> → <pick>`, with `(fallback)` or `(unavailable)` when the fallback is serving or the alias is disabled.


## Install

Add a `plugins` entry to `opencode.jsonc` (project or global):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "model-compare-opencode-plugin",
      "options": {
        "source": "auto",
        "defaultPriority": "balanced",
        "fallback": "openrouter/z-ai/glm-5.3-flash"
      }
    }
  ]
}
```

All options are optional — see [Configuration](#configuration). The package is on npm; OpenCode resolves and loads it itself. The terminal-UI half ships precompiled (`dist/tui.js`): OpenCode compiles plugin JSX itself only for local sources — files under a `node_modules` directory skip its Solid JSX transform and would fall back to a React compile that cannot resolve — so the published package must not ship raw JSX. To run a checkout of this repo instead, see [Development](#development).


## Usage

Point sessions at an alias — as the root default in `opencode.jsonc`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "model": "openrouter/model-compare/balanced"
}
```

Per agent (in the `.md` frontmatter):

```md
---
description: Reviews changes for correctness
mode: subagent
model: openrouter/model-compare/quality
---
```

Or via `--model`:

```
opencode run --model "openrouter/model-compare/price" "msg"
```


**Where the alias binds.** An agent's `model` applies to subagent launches everywhere, and to primary agents only when you select the agent in the TUI. Headless runs (`opencode run --agent …`) and server-side agent switches do **not** apply it — the root default (or `--model`, or `/use-best`) governs.

Commands:

- `/use-best [priority]` — switch the session to `openrouter/model-compare/<p>` (defaults to `defaultPriority`). Refuses a disabled alias.
- `/model-compare` — top 5 per priority with scores and data age; priorities whose `weights` override actually takes effect are labelled `(custom weights)` with recomputed scores, and each alias's current pick is marked `← current pick`. The output is a synthetic message (`resume: false`): it costs no model turn and, in a headless session, surfaces in the transcript at the next turn. In the TUI it opens the report dialog instead.


### Keyboard shortcuts

| Key | Action |
|---|---|
| `alt+m` | picks dialog — all three priorities with their current picks |
| `alt+e` | toast the last response's served endpoint (`!` prefix flags a downgrade — not in the steering order) |
| `alt+shift+m` | report dialog — the top-5 table; `return` switches the session to the highlighted model |
| `up` / `down` | move the dialog cursor |
| `return` | select the highlighted row (picks dialog: switch to that priority) |
| `esc` | close the dialog |

Both dialogs open anywhere — including the opening screen, where no session exists yet. There, picking a row (a priority in the picks dialog, a model in the report) creates a new session already bound to that model and opens it; merely opening a dialog never creates a session. With a session open, a pick switches that session as before. The TUI has no `/use-best` keybinding: the slash command already covers switching.

Status: the footer shows `MC: balanced → <pick>` (balanced only — `disabled`/`unavailable`/`(fallback)` as applicable; all three priorities live in the picks dialog). Toasts announce `/use-best` outcomes and pick changes — never for the first observation after load. Headless, all feedback is synthetic transcript messages at the next turn.


## Configuration

Options live under `plugins[].options`:

| Option | Default | Meaning |
|---|---|---|
| `source` | `auto` | `auto`, `local`, or `remote`. `auto` uses the vendored script when `python3` 3.10+ is available, otherwise the remote catalog |
| `defaultPriority` | `balanced` | Priority used by `/use-best` with no argument |
| `fallback` | unset | `openrouter/<id>` used when no pick is available. Only OpenRouter models work: the alias's `modelID` lives inside the `openrouter` provider. Runnability is checked at each resolution |
| `weights` | upstream | Partial overrides per named priority (`quality`, `price`, `context`, `age`), merged with upstream's weights and renormalized to sum 1 |
| `pinDays` | `14` | Age in days after which a pick is re-evaluated |
| `minLead` | `0.03` | Score lead needed to replace a pinned pick |
| `catalogURL` | published catalog | Remote source URL. The catalog is published at `https://model-compare.dev/catalog.json` — the plugin's built-in default, fetched directly over https. (The old `https://canonical.github.io/model-compare/catalog.json` home redirects to a plaintext `http://` target; the plugin fails closed on any redirect that leaves https.) Only point it at a source you trust: it decides which models can be picked |
| `scriptPath` | vendored copy | Development override for a local `model_compare.py` |

A present-but-invalid value logs a warning and applies the default (`weights` drop invalid entries individually; the valid remainder applies). Absent options apply defaults silently. Setup never throws; the aliases stay functional.


## Pinning and fallback

Per priority the plugin keeps one pin/last-known-good record in plugin storage, keyed by the effective weights so different weight configurations don't collide. With a fresh catalog:

- No pin: adopt the best candidate.
- Pinned model gone or not runnable: switch to the best candidate now.
- Pin older than `pinDays`: re-evaluate (which may re-adopt the same model; `since` resets on every adoption).
- Otherwise: switch only when the best candidate leads the pinned pick by at least `minLead` (upstream's 0–1 score scale).

Resolution order: pin (if runnable) → best runnable candidate → `fallback` (if runnable) → the alias is disabled. The fallback is never stored as a pin. Pins are advisory: concurrent OpenCode processes refresh independently, last writer wins.


## Data sources

- `auto` — vendored `vendor/model_compare.py` run with `python3` (no shell, 60 s timeout, minimal environment); degrades to remote when python3 is missing or the run fails.
- `local` — the vendored script only; failures are reported and the pin/last-known-good pick is kept.
- `remote` — HTTPS fetch of `catalogURL` with a 6-hour cache (upstream republishes every 6 hours).

The last validated catalog is persisted, so ranking and `/model-compare` work offline after a restart. The cache is keyed by source (URL or script path), so changing the source never serves the previous source's data. Script exit code 2 means "no candidates" *or* an argparse usage error — never read it as "no candidates" alone.

**Vendored pin:** `vendor/model_compare.py` is byte-identical to upstream `v0.4.0` (`vendor/UPSTREAM.json` records repo, tag, commit, sha256). Since upstream 0.4.0 the catalog is schema v3: `pricing` carries tier and schedule structure alongside the flat scalars, and `parameters` carries the published ranking weights. The plugin accepts schema v3 ONLY — `validateCatalog` rejects anything else — and releases are gated on the live remote serving v3 (the release-gate check pipes `https://model-compare.dev/catalog.json` through `scripts/canary-check.mjs`, which fails closed when the served document is not the expected schema). Effective-tier pricing semantics still apply: `pricing` scalars hold effective-tier values — the tier in effect at 1M-token prompts — so models with OpenRouter price overrides are ranked at what a long session actually pays.

**Vendored 0.4.0 cold-cache network profile:** since 0.4.0 the vendored script performs per-model endpoint-pricing fetches when building a fresh catalog (71 in the recorded run). Each fetch fails closed per model — after the script's internal retries, a failed endpoint fetch drops that model and the catalog shrinks silently (429-class responses raise without retry) — so a degraded network costs pool coverage, not pricing correctness. A cold cache under a slow network can exceed the plugin's 60-second local budget, in which case the plugin warns and falls back (`auto` → remote, `local` → its cached document).

**Upgrading the pin** — reviewed PRs only; nothing merges automatically:

1. `node scripts/sync-vendor.mjs <tag>` — fetches the script at that commit, reports the sha256 change, re-pins `UPSTREAM.json`, prints the matching CHANGELOG section (`--check` verifies offline).
2. Conformance tests check `--version`, schema v3, required fields, recomputed `overall` scores, and the standard-library-only import allowlist.
3. The upgrade PR body lists script lines touching imports, URLs, environment variables, subprocess calls and file writes, for reviewer attention.
4. Release with a changelog line naming the upstream tag; users run `opencode plugin update` (OpenCode checks but doesn't apply).

A scheduled workflow opens a draft upgrade PR when upstream publishes a newer release (never a downgrade); a nightly canary exercises the vendored script against live upstream data and asserts the generated catalog is schema v3 (`scripts/canary-check.mjs` pins `EXPECTED_SCHEMA_VERSION = 3` and exits nonzero on any other version); releases additionally gate on the live remote itself (see the publishing gates below); a weekly drift check compares the vendored sha256 against upstream's pinned commit and the published rankings against the published scores.


## Troubleshooting

- **`model-compare: no ranking data for openrouter/model-compare/<p>`** — an agent whose `model` is that alias made a primary request while the alias was disabled. The guard aborts the request — even when the root-governed effective model is healthy — to protect the configuration's intent. Set `options.fallback` or fix the data source. Primary requests only; title/compaction/generation are untouched.
- **Primary run answered with a model I didn't configure** — the root default (and `/use-best`-switched sessions) fall back silently to OpenCode's choice when the alias is disabled. Agent `model` doesn't apply on headless primary runs anyway — see the binding note above.
- **Where are the plugin's warnings?** Nowhere, currently: `opencode serve` prints nothing to stdio and plugin `console.warn` reaches no log. The visible diagnosis surface is `/model-compare` — its data-age and no-data lines.
- **A pick change takes a minute or two to land, and runs started meanwhile wait.** When a pick changes (at most once per 30-minute refresh), the plugin replays OpenCode's provider/model/agent registries; the harness measured ~90–105 s, with runs started during the replay blocking. Nothing is wrong.
- **`Model unavailable: openrouter/model-compare/<p>`** — a subagent configured with a disabled alias; OpenCode fails the launch before any request, so the guard is not involved.
- **Data age in `/model-compare`** — the plugin's own acquisition time of the document, not upstream's `generated_at` (set at build time even when serving inputs from cache).
- **No aliases at all** — the aliases live inside the `openrouter` provider; if it is not connected in the project, they cannot be created. The plugin warns at setup and on every refresh; primary runs fall back silently.
- **`Cannot find package 'react'` for `src/tui.tsx` in the CLI log** — an OpenCode install of a release that still shipped the TUI half as raw TSX: OpenCode's Solid JSX transform skips `node_modules` paths, so the installed TSX fell to a React compile. Update the plugin to a release that ships the precompiled `dist/tui.js` entry (the server half is unaffected either way). If the warning persists after updating, restart the TUI so the new package generation is picked up.


## Development

Run a checkout instead of the npm package:

```json
{
  "plugins": [
    {
      "package": "./src",
      "options": {
        "source": "auto"
      }
    }
  ]
}
```

OpenCode's local loader resolves a directory target strictly as `<dir>/index.*` — `exports` are ignored for local paths, and file targets are rejected. `src/` has the physical entry files (`src/index.ts`, `src/tui.tsx`); the plugin's imports resolve from the repo's `node_modules` (`npm ci` once at the repo root). The repo ships this setup as [`.test/`](.test/README.md). Two caveats: the watcher only watches package-style entries, so source edits need an OpenCode restart; and a bare package name is always npm-installed by OpenCode — it is not read from `node_modules` — so local testing must use the directory form.

```sh
npm test                                              # unit + vendored-conformance suites (hermetic)
npm run build                                         # regenerate dist/tui.js from src/tui.tsx
MC_INTEGRATION=1 npx vitest run tests/integration/    # live-server suite (opt-in)
```

- Local development loads `src/` directly and needs no build; the *published* package does — OpenCode's Solid JSX transform skips `node_modules` paths, so the npm-installed raw TSX cannot load (see [Install](#install) and the troubleshooting entry). `npm run build` precompiles `src/tui.tsx` through the same Babel pipeline as the host's loader (taken from the pinned `@opentui/solid`) into `dist/tui.js`, rebasing relative imports from `src/`-relative to `dist/`-relative; `prepublishOnly` runs it, and CI builds before the packaging check. `dist/` is regenerated, never committed.
- The integration files skip unless `MC_INTEGRATION=1`, so plain `npm test` stays hermetic. The suite drives a real `opencode serve` on 127.0.0.1:14721 and needs the `opencode` CLI and `python3` (skips cleanly when either is missing); one case needs network access and the `sqlite3` CLI.
- `node scripts/pack-smoke.mjs` (also in CI, after `node scripts/build-tui.mjs`) packs the plugin and checks the tarball against the packaging list (files, `exports`, relative imports, and that the TUI artifact is precompiled — no react import). It does **not** load the package in OpenCode — install the tarball into a scratch project and confirm OpenCode loads it before publishing.
- Publishing: cut a GitHub release tagged `vX.Y.Z` and `.github/workflows/release.yaml` stages the package on npm through trusted publishing (tokenless OIDC — no token secret; the npmjs.com trusted-publisher entry must name `release.yaml`, the `canonical/model-compare-opencode-plugin` repository and the `release` environment, with "Allow npm publish" and "Allow npm dist-tag" unchecked — stage-only, npm's recommended posture). Nothing goes live until a maintainer approves it with 2FA on npmjs.com (package page → Staged Packages) or via `npm stage approve`. The workflow fails closed when the tag does not match `package.json`'s version, and the gates (build, typecheck, tests, pack-smoke, live-remote canary) run before staging.
- `fixtures/catalog-v0.4.0.json` is the sole contract fixture — a recorded schema-v3 catalog; `fixtures/catalog-no-quality.json` is derived from it by `scripts/make-no-quality-fixture.py` (the vendored script's own quality-blind weights, so its scores are internally consistent). No v2 fixture exists; the v3-only gate rejects one. `node scripts/sync-vendor.mjs --check` verifies the pin's sha256 offline.
- Repo layout: `src/core/` (pure ranking/pinning), `src/sources/` (local + remote acquisition), `src/opencode/` (aliases, guard, commands, storage, refresh), `dist/` (generated `tui.js` artifact, gitignored), `vendor/` (pinned upstream script), `tests/{unit,conformance,integration}`.


## License

GPL-3.0 — see [LICENSE](LICENSE). The vendored `vendor/model_compare.py` comes from [canonical/model-compare](https://github.com/canonical/model-compare) (GPL-3.0).

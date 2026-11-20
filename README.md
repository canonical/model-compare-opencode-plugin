# model-compare-opencode-plugin

<a href="https://www.npmjs.com/package/model-compare-opencode-plugin">
  <img src="https://img.shields.io/npm/v/model-compare-opencode-plugin" /></a>

An [OpenCode](https://opencode.ai) v2 plugin that keeps three model aliases pointed at the best value-for-money OpenRouter picks from [model-compare.dev](https://model-compare.dev/) (GitHub: [canonical/model-compare](https://github.com/canonical/model-compare)).

Each priority is registered inside your existing `openrouter` provider — no extra provider setup and no separate credentials:

| Alias | Resolves to |
|---|---|
| `openrouter/model-compare/balanced` | Best all-round value pick |
| `openrouter/model-compare/price` | Best price pick (bulk or mechanical work) |
| `openrouter/model-compare/quality` | Best quality pick (planning or code review) |

While OpenCode runs, the plugin refreshes rankings every 30 minutes (caching catalog data for 6 hours), steers alias requests to the backend endpoints that earned the model its rank, and pins the reasoning depth behind its quality score. OpenCode sessions display the aliases as `Model Compare: <priority> → <pick>` (with `(fallback)` when running on your fallback model, or `(unavailable)` when disabled).


## Install

Add `model-compare-opencode-plugin` (published on npm at [model-compare-opencode-plugin](https://www.npmjs.com/package/model-compare-opencode-plugin)) to `opencode.jsonc` (project or global):

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

OpenCode downloads and loads the npm package automatically, and shows a startup toast whenever a newer plugin version is ready to install via `/plugins`. All `options` are optional — see [Configuration](#configuration).


## Use

Set an alias as your default model in `opencode.jsonc`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "model": "openrouter/model-compare/balanced"
}
```

Bind specific subagents (or TUI-selected primary agents) in their `.md` frontmatter:

```md
---
description: Reviews changes for correctness
mode: subagent
model: openrouter/model-compare/quality
---
```

Or pass an alias on the command line for headless runs:

```sh
opencode run --model "openrouter/model-compare/price" "Fix bugs"
```

Note that an agent's frontmatter `model` applies to subagent launches everywhere and to primary agents selected in the TUI; headless `opencode run --agent ...` runs use the root default or `--model` instead.


### Slash commands

- `/use-best [priority]` — switch the current session to `openrouter/model-compare/<priority>` (case-insensitive; defaults to `defaultPriority` and refuses to switch to a disabled alias).
- `/model-compare` — inspect the top 5 models per priority (marking active picks with `← current pick` and recomputing `(custom weights)` scores when `weights` overrides apply). Opens the interactive report dialog in the TUI, and records a synthetic transcript summary (`resume: false`, costing no extra model turn) when run inside a session.


### Keyboard shortcuts

| Key | Action |
|---|---|
| `alt+m` | Open the current-picks dialog for `balanced`, `price`, and `quality` |
| `alt+shift+m` | Open the top-5 report dialog (same as `/model-compare`) |
| `alt+u` | Switch the session to your `defaultPriority` pick (same as `/use-best`) |
| `alt+e` | Show a toast with the provider, endpoint, quantization, effort, and steering status of the session's last reply |

Both dialogs and `alt+u` also work on OpenCode's opening screen before a session exists: selecting a priority or model creates and opens a new session bound to that choice. The TUI footer shows `MC: balanced → <pick>` as a compact status indicator, and toasts announce pick changes when a refresh flips an alias.

OpenCode currently keeps the prompt's model selection separate from the session's, so a plugin-initiated switch — an alias, or a concrete model picked in the report dialog — does not always reach the prompt ([upstream bug #57771](https://github.com/anomalyco/opencode/issues/57771)). When Model Compare detects that the switch did not follow, it warns and points at the `ctrl+x m` → **Select model** picker, which does update the prompt selection. Press `d` in the warning to stop showing it; that opt-out is stored durably.


## Configuration

Configure the plugin under `plugins[].options` in `opencode.jsonc`:

| Option | Default | Description |
|---|---|---|
| `source` | `"auto"` | `"auto"`, `"local"`, or `"remote"`. `"auto"` runs the vendored Python 3.10+ script when available and falls back to the remote catalog otherwise |
| `defaultPriority` | `"balanced"` | Priority used by `/use-best` (without arguments) and `alt+u` |
| `fallback` | unset | `openrouter/<model-id>` (OpenRouter models only, without a `#variant` suffix), checked for runnability on each refresh and used when no ranked pick is available |
| `weights` | from `model-compare` | Partial per-priority overrides (`quality`, `price`, `context`, `age`), merged with `model-compare` defaults and renormalized |
| `pinDays` | `14` | Days before a pinned pick is re-evaluated from scratch |
| `minLead` | `0.03` | Score lead (`0`–`1` scale) required to unseat a pinned pick early |
| `catalogURL` | `https://model-compare.dev/catalog.json` | HTTPS URL for `remote` (and `auto` fallback); point this only at a source you trust |
| `scriptPath` | vendored copy | Path override for testing a local `model_compare.py` |

To avoid constant model churn as prices twitch, each priority pins its chosen model and switches early only if the model disappears, becomes unrunnable, or trails a newcomer by at least `minLead`. Invalid option values log a warning and fall back to their defaults without breaking setup.


## Steering and served endpoints

On OpenRouter, a single model ID is often hosted by several providers at different quantizations and rates. When a session uses one of the three `model-compare` aliases, the plugin injects the catalog's `steering.provider` routing block (`order`, `ignore`, `quantizations`, and `allow_fallbacks`) into each OpenRouter request, so your calls go to the baseline-eligible endpoints behind the ranking.

Steering stays out of your way when you don't want it:
- **Aliases only:** picking a concrete model ID directly leaves routing untouched, even if it happens to be the same model an alias currently points to.
- **Explicit `provider` wins:** if a request body already sets `provider`, the plugin leaves it alone.
- **Graceful fallback:** if no catalog data is available (for example, while offline on `options.fallback`), requests proceed with OpenRouter's default routing, and the TUI shows a one-time notice.

While **steering** applies only to the three aliases, **last-reply capture** (`alt+e` and `/model-compare`'s transcript summary) tracks every successful primary HTTP reply in the session across all providers. Press `alt+e` after any reply to see the model, API `provider` (`openrouter`, `anthropic`, `openai`, …), served `endpoint` (from the response body when reported, or `endpoint: unknown` when unreported or beyond the bounded 4 KB response peek), optional `quantization` and reasoning `effort` (and how they compare to the model's OpenRouter catalog defaults when applicable), and the tri-state steering status (`steering: in order`, `steering: ! NOT in order`, or `steering: unknown` when no steering order applied or no served endpoint was reported).


## Reasoning efforts and variants

Artificial Analysis benchmarks reasoning models across several thinking depths (`minimal`, `low`, `medium`, `high`, `xhigh`, `max`). `model-compare` scores each model at the best measured depth OpenRouter supports and records it as `quality_effort`. On an alias request, the plugin adds `reasoning: { effort }` when that value names a discrete OpenRouter effort, so the call runs at the depth behind its score. For an unscored model, an uncataloged fallback, or a session with no catalog data yet, no effort is injected and the model's own default applies.

OpenCode calls its selectable depths **variants** (`provider/model#variant`): named presets that OpenCode applies to the request. On OpenRouter, an effort variant sets `reasoning.effort` too, but a variant can also change headers or other body fields. `default` means "no variant selected", not a reasoning level.

On an alias request, an explicit `#variant` or a request body that already sets `reasoning` takes precedence over the plugin's choice:

| Session model | OpenCode variant | Who sets the effort |
|---|---|---|
| `openrouter/model-compare/balanced` | `default` | The plugin, from `quality_effort` |
| `openrouter/model-compare/balanced#high` | `high` | OpenCode, from the variant |
| `openrouter/<model>` (bare or `#variant`) | `default` or `<variant>` | OpenCode or the model default; the plugin leaves concrete models alone |

A bare alias can show `default` while the request runs at `high`. The plugin's effort applies to the request, not the variant label; `alt+e` shows what the last request actually asked for.

Aliases inherit variants from their current pick. If a refresh switches that pick to a model without your chosen `#variant`, the variant can become unavailable: the TUI drops it on the next prompt, while headless and API turns fail with a `Variant unavailable` error. Keep alias bindings in `opencode.jsonc` and agent frontmatter bare, and use `#variant` on an alias only as a temporary session override. In the `alt+shift+m` report dialog, the `variant` column lists the scored depth when OpenRouter supports selecting that effort (`-` otherwise); pressing `return` switches to that concrete model (adding `#<variant>` when OpenCode offers it, or noting when that variant is unavailable).


## Troubleshooting

- **`model-compare: no ranking data for openrouter/model-compare/<p>`** — an agent configured with that alias tried to run a primary turn while the alias was disabled (including headless `opencode run --agent …`, where the guard still inspects the agent's frontmatter `model`). Configure `options.fallback` or check your network/Python setup. (Root-default sessions fall back to OpenCode's own choice instead of aborting.)
- **`Model unavailable: openrouter/model-compare/<p>`** — a subagent configured with that alias launched while the alias was disabled; OpenCode rejects the launch before any request starts.
- **No aliases appear in the picker** — make sure the `openrouter` provider is connected in your OpenCode setup; the aliases are registered inside it.
- **A pick change takes ~90–105 seconds to settle** — when a 30-minute refresh switches a pick, OpenCode reloads its provider, model, and agent registries; runs started mid-reload wait until it finishes.
- **Checking plugin health** — `opencode serve` suppresses plugin `console.warn` output, so run `/model-compare` to check catalog data age (when the plugin itself acquired the catalog, not `model-compare`'s `generated_at` timestamp) or diagnose missing data.


## Development

```sh
npm ci         # install dependencies
npm run dev    # launch OpenCode with scratch config pointed at ./src
npm test       # run hermetic unit + vendored-script conformance tests
npm run build  # precompile src/tui.tsx -> dist/tui.js
```

To test a local checkout manually in `opencode.jsonc`, set `"package": "./src"` (restart OpenCode after editing source files, and prefer `npm run dev` if the npm package is installed globally so duplicate plugin IDs cannot shadow `./src`).

Internal architecture, pin storage, the 4 KB pass-through response peek, Solid/OpenTUI precompilation, vendored script upgrades, and staged npm publishing are documented in [DESIGN.md](DESIGN.md).


## License

GPL-3.0 — see [LICENSE](LICENSE). Includes `vendor/model_compare.py` from [canonical/model-compare](https://github.com/canonical/model-compare) (GPL-3.0).

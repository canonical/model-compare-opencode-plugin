# Steering injection + served-endpoint visibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Alias requests carry the catalog's per-model OpenRouter `provider` steering object (so the paid price matches the ranked price), and the plugin records + surfaces (alt+e toast, report-dialog footer) which endpoint actually served each response.

**Architecture:** Two `session.hook` registrations on the existing wire — `http.request` injects the steering block into the JSON body of alias-scoped requests; `http.response` peeks the response body's first chunks through a pass-through transform stream (never buffering) to capture the `provider` and `model` fields in a per-session capture map (keyed by sessionID). The capture state lives on the existing mutable `WireState`. The steering block is projected through `validateCatalog` with the pricing-split posture (malformed fields → absent per field, never a document rejection). A throwaway spike (Task 1) settles the four open facts in the spec before any wiring task is written in full.

**Tech Stack:** TypeScript, OpenCode plugin SDK (`session.hook`, `effect/registration`), no new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-23-steering-endpoint-visibility-design.md`

## Global Constraints

- Every hook body fails open: any error leaves the original request/response untouched, never throws out of the hook (spec: anti-goals).
- Never buffer or consume a response stream to inspect it — only a bounded first-chunk peek through a pass-through transform; the rest forwards byte-for-byte (spec: anti-goals).
- Steering applies ONLY to the three aliases (`openrouter/model-compare/{balanced,price,quality}`); a model the user picked directly is never modified (spec: non-goals).
- No steering toggle: always-on for aliases; no cross-link work on the model-compare site (spec: non-goals).
- No request-kind filter: a request of ANY kind (primary, compaction, title, generate) whose model is the alias's current pick gets steering; auxiliary kinds whose requests run a different model are naturally excluded (the spike settles which kinds those are). The recorded/displayed endpoint is the last **primary** response's (spec: constraints).
- Q2 ruling: if the spike finds no reliable alias-binding signal, steering does NOT ship — fall back to OpenRouter default routing, and a toast informs the user ("cannot steer this session; OpenRouter default routing applies"). Partial coverage is not shipped.
- Catalog projection follows the existing hostile-catalogURL posture: malformed steering fields → field absent, never a thrown error.

## Review Focus

- **A request body already carrying a `provider` key:** the plugin must not inject (never clobber user/provider-configured routing). Test: injection hook on a body that pre-sets `provider` leaves it byte-identical. → Task 4.
- **A response body that is not parseable JSON/SSE** (binary, empty, or malformed): capture must leave the stream byte-for-byte untouched and record nothing — never throw, never stall the stream. Test: capture hook against a malformed/chunked body. → Task 5.
- **A session whose model is NOT an alias** (directly-picked model): zero modification of request or response — the hook must be a no-op. Test: same hooks with a non-alias model ref. → Task 4.
- **The no-signal world (Q2 ruling):** if the spike's signal fails, the "cannot steer" toast path must fire instead of silently doing nothing. Test: wiring under a forced no-signal state emits the cannot-steer event and the TUI toasts. → Task 6.
- **The report dialog footer with no capture** (no session yet, or a session that never made an alias call): the footer line is omitted entirely (not rendered as `last response: -`). Test: report entries with an empty capture state. → Task 7.

---

### Task 1: Spike — settle the four open facts (throwaway)

**Files:**
- Create (throwaway, NOT committed): `scripts/spike-steering.ts` (or ad-hoc scripts under `scripts/`, deleted after)
- Test: none — the spike produces recorded facts, not code

**Interfaces:**
- Consumes: the integration harness's existing patterns (`tests/integration/`), the live server, a real OpenRouter key.
- Produces: recorded facts written into this plan's Task 3 and Task 4 wiring notes before those tasks are executed (their implementers read them here; fact 3's `provider`-format finding feeds Task 3's membership comparison too).

- [x] **Step 1: Write the spike script** — register `http.request` + `http.response` hooks against a live session bound via root-default/`--model`/frontmatter to an alias, log (a) `event.model` for every binding style and every request kind — auxiliary kinds (title/compaction) may use a small model — plus a disabled-alias run (the fallback case), (b) the session domain's model ref at request time, (c) whether the request body carries a `provider` key, (d) the response's first chunk(s) verbatim.

- [x] **Step 2: Run the spike** against a real OpenRouter call with a steered model (e.g. `z-ai/glm-5.3-flash` from the catalog fixture) and record the four facts into this plan as a comment block.

- [x] **Step 3: Record the verdict** on the Q2 gate — does `event.model` read as the alias ref reliably across root-default/`--model`/frontmatter bindings? **Verdict: PASS** (see the findings section at the bottom) — the PASS branch applies: Tasks 2–9 proceed as written. Branch:
  - **PASS** → proceed with Tasks 2-9 as written.
  - **FAIL** → steering injection does NOT ship. Task 4 is skipped; Task 3 ships `captureEndpoint` only (`steeringFor`/`injectSteering` are not wired); Task 6 ships ONLY the cannot-steer toast — the Q2 ruling's fallback notification — its emit re-homed onto its own `http.request` registration (Task 4's hook does not exist), fired on the best available partial signal; Task 5 proceeds with capture scoped by the best available partial signal (direct-pick false positives accepted, documented in the ledger); Task 7 ships the alt+e toast + footer but the steering note MUST NOT render (nothing is steered); Task 8 documents default routing + the observability paths only (no steering claims); Task 9 records the branch in the ledger.

- [x] **Step 4: Delete the spike script** — never committed; findings live in the plan/ledger only. (Deleted: `scripts/spike-steering/`, `scripts/spike-steering-driver.mjs`.)

---

### Task 2: Project the steering block through `validateCatalog`

**Files:**
- Modify: `src/core/catalog.ts` (projection — alongside the weights block)
- Modify: `src/core/types.ts` (add the `Steering` type to `ModelEntry`)
- Test: `tests/unit/catalog.test.ts`

**Interfaces:**
- Produces: `ModelEntry.steering?: { order: string[]; ignore: string[]; quantizations?: string[]; allow_fallbacks: boolean }` — arrays of strings, `quantizations` optional, `allow_fallbacks` boolean. The catalog's raw steering is `{ model, provider: { order, ignore, quantizations, allow_fallbacks } }`; the projection reads the `provider` sub-object as `ModelEntry.steering` — the top-level `model` is never projected. Any malformed element (non-string array item, non-boolean flag, non-array) → that field is dropped; if `order`/`ignore` are missing or invalid the whole `steering` is absent. An empty array is invalid: an empty `quantizations` drops the field, an empty `order`/`ignore` drops the whole block — the vendored script never emits an empty `quantizations`/`order` list (OpenRouter semantics would filter out every endpoint), and a hostile catalog serving `[]` must not strand routing.

- [x] **Step 1: Write the failing test** — feed `validateCatalog` a fixture model whose raw JSON carries a well-formed `steering` block, plus a second fixture with a hostile one (a string where an array belongs, a non-boolean flag, a nested object). Assert the well-formed one projects through and the hostile one reads as absent (no throw, no partial field), that a hostile raw block leaves the projected entry's `steering` `undefined` — not the raw object (the raw field passes through the `...entry` spread today), that an empty `quantizations` reads as absent, and that the projected entry carries no top-level `steering.model`.

- [x] **Step 2: Run the test** — `npx vitest run tests/unit/catalog.test.ts`. Expected: FAIL (steering not yet projected).

- [x] **Step 3: Implement** the projection in `validateCatalog` — the pricing-split posture (per-field absence, never a document rejection): only string-array members with finite shape survive; a bad `allow_fallbacks` drops the whole block. The sanitized `steering` field must explicitly OVERRIDE the `...entry` spread in the projected entry — assign it after the spread, with the key set to `undefined` when invalid (a conditional spread placed after `...entry` would leave the hostile RAW steering block in place). Add the `Steering` type to `ModelEntry`.

- [x] **Step 4: Run the test** — expect PASS.

- [x] **Step 5: Commit** — `git commit -m "feat: project the catalog's steering block through validateCatalog"`

---

### Task 3: Pure core — steering decision + capture decision

**Files:**
- Create: `src/core/steering.ts`
- Test: `tests/unit/steering.test.ts`

**Interfaces:**
- Consumes: `ModelEntry.steering` (Task 2), the hook event's model ref (the alias signal — `parseAliasRef` in `src/opencode/guard.ts`, not an unresolved spike question; spike fact 1 (revised) still verifies its reliability across binding styles), optionally the request body's model, the alias registry's current picks, and the catalog's `ModelEntry` map (the picks' steering data — `quantizations` lists included — resolves from the pick ids through it, not from the pick objects).
- Produces:
  - `steeringFor(eventModel: ModelRef, bodyModel: string | undefined, picks: Partial<Record<Priority, AliasTarget>>, models: Map<string, ModelEntry>): Steering | null` — identifies the alias via `parseAliasRef(eventModel)` (null for non-alias refs) and returns that alias's steering block when the session's pick has one; when a body model is supplied, only when it equals the pick's id. Never match on "the pick's model equaling the request ref" — that INVERTS the rule (an alias-bound ref is never equal to a concrete pick id, while a directly-picked model would match) and steers requests the anti-goal forbids. Returns null for non-alias/directly-picked/no-data.
  - `injectSteering(body: unknown, steering: Steering): unknown` — returns the body with the `provider` sub-object injected (never the block's top-level `model` field), or the body untouched when it already carries `provider`.
  - `captureEndpoint(provider: string | null, order: string[] | null): { endpoint: string | null; downgrade: boolean }` — symmetric normalized comparison: both the served provider string and each `order` entry are normalized (the script's `normalize_provider` semantics), reduced to their provider part (the text before the first `/`), and compared (spike fact 3's format finding refines the exact reduction). `downgrade: true` ONLY when a parseable provider matches no entry of a NON-EMPTY order. An absent/empty `order` (no steering data — offline, or a model without a steering block) → the endpoint is recorded, `downgrade: false`, no verdict. An unparseable/absent `provider` → no verdict.

**Spike wiring notes (Task 1, recorded 2026-10-23 — see the findings section at the bottom for full evidence):**
- Fact 1 (Q2 gate PASS): `event.model` is the alias ref under all three binding styles — root-default and frontmatter refs carry NO `variant` key, `--model` refs carry `variant:"default"` — so `parseAliasRef` stays variant-blind (it already is). The title kind never carries the alias (it carries the title agent's own model); the compaction kind DOES (alias-scoped, steered in the spike). The disabled-alias/fallback case shows the fallback-resolved CONCRETE ref (`moonshotai/kimi-k3.1-pro` live) — no alias signal, correctly unsteered/uncaptured.
- Fact 3 (membership refinement): the served `provider` string is a DISPLAY NAME — `Novita`, `Moonshot AI`, `InferenceNet` — never the script's tagged slug, no `/` ever observed in a served string, may contain spaces/mixed case. The reduction: served string → provider part = the whole string; `order` entry → text before the first `/` (`novita/fp8`, `deepinfra/fp8/flex` → `novita`/`deepinfra`); then `normalize_provider` both sides (casefold, strip non-alnum: `Moonshot AI` → `moonshotai`, `Atlas Cloud` ↔ `atlas-cloud` → `atlascloud`).

- [x] **Step 1: Write the failing tests** — `steeringFor` with an alias-bound event ref (`openrouter/model-compare/price`) whose pick has steering (returns the block); with a DIRECTLY-PICKED concrete ref whose id equals the current pick's id (returns null — the anti-goal case); with no steering data (null); with a pre-existing `provider` in the body (injection must be a no-op); with the block's `model` field (must not leak into the body); and `captureEndpoint` with a matching provider, a non-matching one (downgrade), a tag-carrying served string (`streamlake/fp8` vs order `streamlake/fp8` → match, no flag; vs a different provider → downgrade), an empty-order case (no downgrade flag), and an unparseable one (no verdict).

- [x] **Step 2: Run the test** — expect FAIL (module doesn't exist).

- [x] **Step 3: Implement** the three functions. Normalization follows the script's `normalize_provider` semantics (casefold, strip non-alphanumerics); both sides of the membership comparison are reduced to their provider part symmetrically (spike fact 3 refines the reduction).

- [x] **Step 4: Run the test** — expect PASS.

- [x] **Step 5: Commit** — `git commit -m "feat: pure steering decision + capture-decision core"`

---

### Task 4: Wire the `http.request` injection hook

**Files:**
- Modify: `src/index.ts` (inside `wire`, after the guard's hook registration)
- Test: `tests/unit/wiring.test.ts` (extend the existing hook tests)

**Interfaces:**
- Consumes: `steeringFor`/`injectSteering` (Task 3), the guard's existing registration pattern (`ctx.session.hook`), `parseAliasRef` for alias identification from the event's model ref (spike fact 1 confirms its reliability across binding styles).
- Produces: a registered `http.request` hook that, for alias-scoped requests with a resolvable steering block and no pre-existing `provider` key, re-creates the Request with the injected body. Fails open.

**Spike wiring notes (Task 1, recorded 2026-10-23 — see the findings section at the bottom for full evidence):**
- Fact 2 (mechanism verified live 4/4, including a compaction request): read via `event.request.clone().text()` → `JSON.parse` → set `body.provider = steering` (the `provider` SUB-OBJECT only; never the block's top-level `model`) → `event.request = new Request(event.request.url, { method, headers, body: JSON.stringify(modified) })` with `content-length` and `content-encoding` DELETED from the copied headers (the runtime re-derives content-length). The mutated request survived the real path and OpenRouter honored the routing (unsteered control landed on ignore-list endpoints; every steered alias run landed on an order entry — `Novita` = `novita/fp8`, 3/3).
- Fact 4a: a SECOND `http.request` hook in the SAME plugin coexists with the first (both fired on every request, spike-verified) — the injection hook can be registered alongside the guard's hook without conflict.
- Fact 4b: OpenCode NEVER sets a `provider` key in the request body itself (0/14 observed requests across all kinds and bindings) — the no-clobber guard is a safety net, not a live conflict. Body keys observed: primary `model, messages, tools, stream, stream_options, store, prompt_cache_key, usage`; title adds `reasoning`; no `models` array, no `route`.
- Scoping confirmations: alias-bound refs arrive for primary AND compaction kinds (no request-kind filter is correct); the title kind's ref is its own agent's concrete model (naturally excluded). The disabled-alias/fallback world delivers the fallback concrete ref — no injection (fail-open to default routing), matching the Q2 ruling's expectation.

- [x] **Step 1: Write the failing wiring test** — using the existing harness's fake session context: a request whose event model is the alias ref (`openrouter/model-compare/price`) gets its JSON body's `provider` set to the steering object; a DIRECTLY-PICKED request whose model id equals the current pick's id is untouched (the anti-goal case); a request with a pre-set `provider` is untouched; a non-alias request is untouched; a hook that throws is swallowed (the original request proceeds).

- [x] **Step 2: Run the test** — expect FAIL.

- [x] **Step 3: Implement** the hook in `wire`. Per the spike: read the body, decide, re-create the Request only when injecting, and swallow every error (spec anti-goal).

- [x] **Step 4: Run the test** — expect PASS.

- [x] **Step 5: Commit** — `git commit -m "feat: inject the catalog steering block into alias requests"`

---

### Task 5: Wire the `http.response` capture hook

**Files:**
- Modify: `src/index.ts` (state gains the per-session capture map on `WireState`; a new hook registration; widen the structural `session.hook` name union — currently the literal `"http.request"` — to also accept `"http.response"`, and extend `HttpEvent` with the response field)
- Modify: `src/core/types.ts` (the capture-record type — pure data, shared vocabulary; the state FIELD itself lives on `WireState` in `src/index.ts`)
- Test: `tests/unit/wiring.test.ts` (extend; the fake's hook signature pins `_name: "http.request"` and must accept the response hook too)

**Interfaces:**
- Consumes: `captureEndpoint` (Task 3), the pass-through transform pattern, and the steering `order` actually applied to the request — passed as `null` whenever nothing was injected (no steering data, a pre-existing body `provider`, or the Q2 FAIL branch), so `!` only ever asserts "despite the steering" when a non-empty order was actually applied (spec: endpoint membership rule).
- Produces: a per-session capture map `lastEndpoints: Record<string, { endpoint: string; model: string; downgrade: boolean; at: number }>` keyed by sessionID — one entry per session, last-writer-wins WITHIN a session; stale entries for ended sessions are acceptable (or pruned on session removal if a hook exists). The capture record itself is `{ sessionID: string; endpoint: string; model: string; downgrade: boolean; at: number } | null` — `model` is the response's `model` field, captured alongside `provider` (spike fact 3 establishes both are present). Only primary responses update it.

- [x] **Step 1: Write the failing wiring test** — a streaming SSE response whose first chunk carries `"provider": "streamlake/fp8"` updates `state.lastEndpoints` with the right session, endpoint, and the captured response `model` alongside the endpoint; two different sessions' captures do not clobber each other; a response whose first chunk is not parseable updates nothing; a non-streaming JSON body whose `provider` key lies beyond the peek window → no capture, clean byte-for-byte pass-through, no error; a non-primary kind updates nothing; the stream's bytes are forwarded byte-for-byte (assert the full body content survives the wrap).

- [x] **Step 2: Run the test** — expect FAIL.

- [x] **Step 3: Implement** the hook — (a) widen the structural `session.hook` name union in `src/index.ts` (currently the literal `"http.request"`) to also accept `"http.response"`; (b) extend `HttpEvent` with the response field (the real SDK supports both hooks and the integration probe already registers `http.response` against the real context — only the repo's structural types need widening); (c) wrap `event.response.body` in a `TransformStream` that peeks at most the first few chunks, extracts `provider` (SSE or plain JSON), then forwards everything untouched. Swallow every error.

- [x] **Step 4: Run the test** — expect PASS.

- [x] **Step 5: Commit** — `git commit -m "feat: capture the served endpoint from alias responses"`

---

### Task 6: Q2 fallback — the cannot-steer toast

**Files:**
- Modify: `src/index.ts` (the hook emits the cannot-steer rpc event when the alias-binding signal is absent but a request arrives that would have been steered)
- Modify: `src/tui.tsx` (a listener on the rpc events bridge that calls `context.ui.toast.show`)
- Test: `tests/unit/wiring.test.ts`, `tests/unit/tui.test.ts` (extend)

**Interfaces:**
- Consumes: the spike's verdict on the signal (Task 1), the existing rpc-event → TUI bridge (`rpcRegistration.events.emit` → the TUI's toast — the report-events pattern). The toast cannot be emitted from `src/index.ts`: `PluginCtx` has no ui domain; `context.ui.toast.show` exists only in the TUI plugin.
- Produces: when the signal is absent, the hook emits a single event per session (not per request) and the TUI toasts `cannot steer this session; OpenRouter default routing applies`. Headless (no TUI) shows nothing — acceptable, matching the existing TUI-coupled surfaces.

- [x] **Step 1: Write the failing tests** — with the signal forced absent, a steerable alias request emits the cannot-steer event exactly once for that session and the request body is untouched; the `src/tui.tsx` listener turns the event into `context.ui.toast.show` with the right copy.

- [x] **Step 2: Run the test** — expect FAIL.

- [x] **Step 3: Implement** — the hook emits from the same hook body, guarded by a per-session "already toasted" flag on the state; `src/tui.tsx` listens and toasts. In the Q2 FAIL branch (Task 1 Step 3), where Task 4 does not ship, the emit rides the task's own `http.request` registration (spike fact 4's coexistence).

- [x] **Step 4: Run the test** — expect PASS.

- [x] **Step 5: Commit** — `git commit -m "feat: toast when steering cannot be applied (no alias-binding signal)"`

---

### Task 7: alt+e toast + report-dialog footer

**Files:**
- Modify: `src/tui.tsx` (new `alt+e` keybind; footer line in `showReportDialog`)
- Modify: `src/index.ts` (the RPC report payload gains the footer fields; the event emit too)
- Modify: `src/opencode/commands.ts` (`reportEntries`/`formatReport` gain the last-endpoint fields)
- Modify: `README.md` (add the `alt+e` row to the Keyboard shortcuts table — it currently lists `alt+m` and `alt+shift+m` only)
- Test: `tests/unit/commands.test.ts`, `tests/unit/tui.test.ts` (extend)

**Interfaces:**
- Consumes: `state.lastEndpoints` (Task 5), looked up by the CURRENT session's id, the catalog's `ModelEntry` map (the current picks' steering blocks' `quantizations` lists resolve from the pick ids through it), the existing keybind registration pattern (`alt+m`, `alt+shift+m`), the existing toast pattern.
- Produces:
  - `alt+e` → toast `last response served by <endpoint>` or, when `downgrade`, `! served by <endpoint> — not in steering order`; nothing when nothing was captured.
  - Report footer: `last response: <model> @ <endpoint>` when captured, omitted otherwise — `<model>` is the captured response `model` from Task 5's record. The steering note `routing steered to <quant> endpoints (aliases only)` derives from the union of the current picks' steering blocks' `quantizations` lists (resolved via the catalog's `ModelEntry` map) across the three ENABLED aliases; it renders only when EVERY enabled alias's current pick carries `quantizations` data (omitted when any is missing — no steering data, offline) and shows that union when so. The note renders only when steering shipped (Task 1's Q2 verdict PASS) — in the FAIL branch it never renders.

- [x] **Step 1: Write the failing tests** — the TUI keybind fires the toast with the right copy in both the normal and downgrade cases and nothing with no capture; alt+e and the footer read the CURRENT session's capture; the report entries carry the footer fields only when capture exists; the steering note derives from the quantizations union across the enabled aliases' current picks and is omitted when ANY enabled alias's pick lacks `quantizations` (partial-data vector: one alias's pick without `quantizations` → note omitted) and when steering did not ship; an enabled/disabled-alias vector (a disabled alias's pick is excluded from the union).

- [x] **Step 2: Run the tests** — expect FAIL.

- [x] **Step 3: Implement** the keybind, the toast, and the report-dialog footer (option C from the mockup), and add the `alt+e` row to the README's Keyboard shortcuts table.

- [x] **Step 4: Run the tests** — expect PASS.

- [x] **Step 5: Commit** — `git commit -m "feat: alt+e toast + report-dialog footer for the served endpoint"`

---

### Task 8: README documentation (#4)

**Files:**
- Modify: `README.md` (a new steering section)

**Interfaces:**
- Consumes: the implemented behavior (Tasks 4-7).
- Produces: a README section covering what is injected (the `provider` routing object), where it comes from (the catalog's per-model `steering` block — vendored script or published catalog), the aliases-only rule, the pre-existing-`provider` exception, the cannot-steer fallback, and how to verify which endpoint served a call (alt+e toast; response body's `provider` field; OpenRouter's dashboard) — including the bounded-peek limitation: alt+e may show nothing when the `provider` field sits beyond the peek window, and the response body's `provider` field and OpenRouter's dashboard remain the authoritative verification paths.

- [x] **Step 1: Write the section** after the existing alias/pinning/fallback sections, matching the README's existing tone and heading level.

- [x] **Step 2: Verify** — read the section against the spec's goals; every claim must match the implemented behavior (no aspirational docs).

- [x] **Step 3: Commit** — `git commit -m "docs: README steering section (issue #4)"`

---

### Task 9: Version bump + ledger

**Files:**
- Modify: `package.json` (0.2.0 → 0.3.0 — a feature release)
- Modify: `docs/superpowers/plans/` (a ledger entry recording the wave, the spike's verdict, and the Q2 ruling's outcome)

- [x] **Step 1: Bump** the version.

- [x] **Step 2: Write the ledger entry** — the spike's recorded facts, the Q2 verdict, and what shipped.

- [x] **Step 3: Commit** — `git commit -m "chore: release 0.3.0 — steering + served-endpoint visibility"`

- [x] **Step 4: Run the full suite** — `npx vitest run` — expect PASS, then the pack-smoke gate.

---

## Spike findings (recorded by Task 1, 2026-10-23)

> Recorded from a live spike (throwaway plugin + driver under `scripts/`,
> deleted after; scratch tree under /tmp/opencode/spike-steering). Method: a
> spike plugin registered TWO `http.request` hooks (observer + injector) and an
> `http.response` hook (bounded first-chunk peek via a pass-through
> TransformStream) beside the real plugin's guard hook, against a live
> `opencode serve` in a scratch project whose root default was
> `openrouter/model-compare/price` (pick = `z-ai/glm-5.3-flash`, the fixture's
> steered model; every fixture model carries a steering block). Binding styles
> driven: plain run (root-default), `--model openrouter/model-compare/price`,
> and a frontmatter agent (`model:` in `.opencode/agents/mc-front.md`); plus an
> explicit-compaction call (`POST /api/session/{id}/compact`) and a
> disabled-alias run (empty-catalog fixture; the price alias disabled by a
> never-used weights-override pin key, the other aliases last-known-good).

### Verdict on the Q2 gate: **PASS**

`event.model` reads as the alias ref for alias-bound primary requests under
ALL THREE binding styles — root-default, `--model`, frontmatter (3/3, see
fact 1) — and for the alias-bound compaction kind. Steering injection ships;
Tasks 2–9 proceed as written.

### Fact 1 — `event.model` per binding style and kind (verbatim refs)

`event.model` is a `Model.Ref` object (`{id, providerID, variant?}`). Observed
`event.model` for every primary request, by session:

| run (binding) | kind | event.model (verbatim) | body `model` |
|---|---|---|---|
| warmup, `--model openrouter/z-ai/glm-5.3-flash` (DIRECT pick — control) | primary | `{"id":"z-ai/glm-5.3-flash","providerID":"openrouter","variant":"default"}` | `z-ai/glm-5.3-flash` |
| root-default (plain run; config `model` = the price alias) | primary | `{"id":"model-compare/price","providerID":"openrouter"}` — **the alias ref, no `variant` key** | `z-ai/glm-5.3-flash` (the pick) |
| `--model openrouter/model-compare/price` | primary | `{"id":"model-compare/price","providerID":"openrouter","variant":"default"}` — **the alias ref, `variant:"default"`** | `z-ai/glm-5.3-flash` |
| frontmatter agent `mc-front` (`model:` = the price alias) | primary | `{"id":"model-compare/price","providerID":"openrouter"}` — **the alias ref, no `variant` key** | `z-ai/glm-5.3-flash` |
| compaction (`POST /api/session/{id}/compact` on the root-default session) | compaction | `{"id":"model-compare/price","providerID":"openrouter"}` — **the alias ref** | `z-ai/glm-5.3-flash` |
| disabled-alias run (empty fixture; root default = the DISABLED price alias; unpinned) | primary | `{"id":"moonshotai/kimi-k3.1-pro","providerID":"openrouter"}` — **the fallback-resolved CONCRETE ref, never the alias** | `moonshotai/kimi-k3.1-pro` |
| every run's title request | title | `{"id":"xiaomi/mimo-v2.6-flash","providerID":"openrouter","variant":"none"}` — the TITLE AGENT's own pinned model, never the session's alias | `xiaomi/mimo-v2.6-flash` |

- The alias ref's `variant` key is NOT stable across bindings (absent for
  root-default/frontmatter, `"default"` for `--model`) — alias identification
  must stay variant-blind (`parseAliasRef` reads only `providerID`/`id`).
- The title kind never carries the alias (it carries the title agent's own
  model) — auxiliary requests using a different model are naturally excluded
  from alias scoping, exactly as the spec's no-filter rule assumes.
- The compaction kind DOES carry the alias ref and wires to the pick — it is
  alias-scoped and (spike plugin) steering was injected into it; consistent
  with the no-request-kind-filter constraint. (The compaction call's
  http.response was not observed — the phase transition stopped the server
  ~2 s after the request fired; response-side coverage of the compaction kind
  remains unverified, and Task 5's capture is primary-only anyway.)
- The `generate` kind was never triggered (no headless trigger found); its
  refs are unverified — accepted gap, same no-filter rule covers it.
- Disabled-alias/fallback case: `event.model` shows the EFFECTIVE
  (fallback-resolved) concrete ref — the guard's documented exception, now
  confirmed live. In that world the plugin sees no alias ref at all: no
  injection, no capture scoping (OpenRouter default routing applies; nothing
  to surface). Note the live fallback resolved to `moonshotai/kimi-k3.1-pro`
  and COMPLETED 200 — the built-in fallback is a working model, not a
  guaranteed failure.
- (b) of the brief: `event.model` IS the session domain's model ref at request
  time as delivered to the hook — no separate session-domain read exists at
  the hook seam; the two questions collapse into one observation.

### Fact 2 — request mutation survives the real path; OpenRouter honors the routing

The spike's injector hook re-created the Request (`clone().text()` →
`JSON.parse` → set `provider` → `new Request(url, {method, headers,
body: JSON.stringify(modified)})` with `content-length`/`content-encoding`
deleted from the copied headers) and reassigned `event.request`. On every
alias-bound request (3 binding styles + compaction — 4/4) the mutation
survived: the request completed 200 with correct model output, and the served
endpoint moved into the steering order:

- UNSTEERED `z-ai/glm-5.3-flash` (direct `--model` control, no injection):
  served by `CoreWeave` and `Crusoe` (the two unsteered control runs) — both
  IGNORE-list endpoints (`coreweave/nvfp4`, `crusoe/fp4`), i.e. exactly the
  endpoints the ranking never ranked. Steered primary cost 0.000646464
  (`Novita`, an order entry) vs unsteered control costs 0.001156
  (`CoreWeave`) / 0.00116735 (`Crusoe`) (same model, same prompt shape) —
  the paid price moved with the endpoint.
- STEERED (injected `provider` block, order head `streamlake/fp8,
  gmicloud/fp8, novita/fp8, …`): served by `Novita` on ALL THREE alias runs
  (3/3) — `novita/fp8` IS an order entry (the two heads were skipped,
  presumably unavailable at request time; fallback WITHIN the order is
  OpenRouter honoring the routing, `allow_fallbacks: true`).
- Non-streaming cross-check (direct API call, deepseek pick): unsteered →
  `InferenceNet` (an order entry for that model), steered → `DeepInfra`
  (order entry `deepinfra/fp8`, served with `service_tier:"flex"`).

### Fact 3 — the response's `provider`/`model` fields, both shapes

- **Streaming (SSE):** EVERY `data:` chunk carries top-level `"provider"` and
  `"model"`. Verbatim first data chunk (root-default alias run):
  `data: {"id":"gen-1792784250-…","object":"chat.completion.chunk","created":1792784250,"model":"z-ai/glm-5.3-flash","provider":"Novita","choices":[{"index":0,"delta":{…},…}]}`.
  CAVEAT: chunk 0 is NOT always data — an SSE comment line
  (`: OPENROUTER PROCESSING\n\n`) can precede it (observed once); a capture
  peek must skip comment lines and keep peeking until a `data:` line parses.
  The final chunk carries `usage`/`cost` details; the stream ends with
  `data: [DONE]`.
- **Non-streaming (direct `stream:false` call):** top-level `"provider"` and
  `"model"` in the JSON body, same fields plus `system_fingerprint`,
  `service_tier`. Verbatim head: `{"id":"gen-1792784274-…","object":"chat.completion","created":1792784274,"model":"deepseek/deepseek-v4.1-flash-1017","provider":"DeepInfra","system_fingerprint":null,"service_tier":"flex",…}`.
- **The `provider` string's exact format: a DISPLAY NAME** — `Novita`,
  `CoreWeave`, `Crusoe`, `Moonshot AI`, `Makora`, `Cohere`, `InferenceNet`,
  `DeepInfra`. It is NEVER the script's tagged-slug form
  (`novita/fp8`), never lowercased, may contain spaces. The `model` field is
  the bare model id (`z-ai/glm-5.3-flash`) — same string as the request
  body's `model`.
- Membership-rule refinement for Task 3 (spike-driven): reduce BOTH sides to
  their provider part — for a served display name the whole string is the
  provider part (no `/` was ever observed in a served `provider` string);
  for an `order` entry the text before the first `/` (tag
  `novita/fp8`/`deepinfra/fp8/flex` → `novita`/`deepinfra`) — then apply the
  script's `normalize_provider` (casefold, strip non-alphanumerics):
  `Moonshot AI` → `moonshotai`, `Atlas Cloud` ↔ `atlas-cloud` →
  `atlascloud`. Symmetric, order-entries-tag-safe, display-name-safe.

### Fact 4 — hook coexistence; OpenCode never sets `provider` itself

- TWO `http.request` hooks registered by the SAME plugin both fired on every
  request (observer + injector counters advanced per request; e.g. the
  root-default session shows observer lines AND injector lines for both its
  primary and its title request). Cross-plugin coexistence with the guard's
  hook was also live (the spike plugin registered first; the guard's hook ran
  after; requests proceeded). Task 4's second registration is safe.
- The request body NEVER carried a `provider` key: `hasProviderKey:false` on
  all 14 observed requests (primary/title/compaction × all bindings × both
  fixture phases). OpenCode does not set `provider` itself — the injection's
  no-clobber guard is a pure safety net, not a live conflict.
- Body keys observed (primary, build agent): `model, messages, tools, stream,
  stream_options, store, prompt_cache_key, usage`; title adds `reasoning` and
  drops `tools`. No `models` array, no `route`.

### Response-hook mechanism (feeds Task 5)

Wrapping `event.response.body` in a `TransformStream` (peek-first-chunks,
forward every chunk byte-for-byte) and REASSIGNING `event.response = new
Response(wrapped, {status, statusText, headers-minus-content-length/encoding})`
worked on every observed response (12/12 `resp-wrapped`, zero
`resp-wrap-error`): all runs completed with correct output text, statuses 200.
The reassignment path is honored by OpenCode's pipeline.

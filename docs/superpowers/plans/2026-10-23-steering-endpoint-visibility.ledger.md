# Ledger — 2026-10-23-steering-endpoint-visibility plan

Branch: `steering-endpoint-visibility` · Worktree: `.worktrees/steering-endpoint-visibility` (base 0419cea)
Operative plan: `docs/superpowers/plans/2026-10-23-steering-endpoint-visibility.md` (committed with this ledger)
Spec: `docs/superpowers/specs/2026-10-23-steering-endpoint-visibility-design.md`

## Spike verdict (Task 1, 2026-10-23): Q2 **PASS** — steering ships

A live spike (throwaway plugin + driver under `scripts/`, deleted after; scratch
tree under /tmp/opencode/spike-steering) drove a real `opencode serve` against a
steered fixture model (`z-ai/glm-5.3-flash`) under three alias bindings, an
explicit compaction call, and a disabled-alias run. Verdict: `event.model` reads
as the alias ref for alias-bound primary requests under ALL THREE binding
styles (3/3) and for the alias-bound compaction kind → the Q2 gate passes and
the PASS branch applied: Tasks 2–9 proceeded as written (no partial coverage
shipped; the cannot-steer toast exists only as its designed runtime fallback,
not as the shipped default).

The plan's "Spike findings" section (committed in this same docs commit) is the
VERBATIM spike record and governs over any session report. Digest of the four
recorded facts:

1. **`event.model` per binding style and kind.** The alias ref arrives for
   root-default, `--model` and frontmatter bindings and for the compaction
   kind; its `variant` key is NOT stable across bindings (absent for
   root-default/frontmatter, `"default"` for `--model`) → alias identification
   must stay variant-blind (`parseAliasRef` reads only `providerID`/`id`).
   The title kind carries the title agent's own pinned model, never the alias —
   auxiliary requests on a different model are naturally excluded, exactly as
   the spec's no-request-kind-filter rule assumes. The disabled-alias run shows
   the EFFECTIVE fallback-resolved CONCRETE ref (`moonshotai/kimi-k3.1-pro`,
   completed 200 — the built-in fallback is a working model) — the guard's
   documented exception, confirmed live; no alias signal, correctly
   unsteered/uncaptured. (Response-side coverage of the compaction kind stayed
   unobserved; `generate` was never triggered — both accepted gaps under the
   same no-filter rule, and Task 5's capture is primary-only anyway.)
2. **Request mutation survives the real path; OpenRouter honors the routing.**
   Re-creating the Request (`clone().text()` → `JSON.parse` → set `provider` →
   `new Request` with `content-length`/`content-encoding` deleted) and
   reassigning `event.request` worked on every alias-bound request (3 binding
   styles + compaction — 4/4): 200s with correct output. Unsteered control
   landed on IGNORE-list endpoints (`CoreWeave`, `Crusoe` — endpoints the
   ranking never ranked); every steered alias run landed on an order entry
   (`Novita` = `novita/fp8`, 3/3, fallback WITHIN the order under
   `allow_fallbacks: true`) — the paid price moved with the endpoint
   (steered 0.000646464 vs unsteered 0.001156/0.00116735, same model and
   prompt shape). A non-streaming cross-check agreed (`InferenceNet` →
   `DeepInfra` = order entry `deepinfra/fp8`).
3. **The response's `provider`/`model` fields, both shapes.** Every SSE
   `data:` chunk and every non-streaming JSON body carries top-level
   `provider` and `model`. The served `provider` is a DISPLAY NAME (`Novita`,
   `Moonshot AI`, `DeepInfra`, …) — never the script's tagged-slug form, may
   contain spaces — which refined Task 3's membership rule: reduce BOTH sides
   to their provider part (served string → the whole string; `order` entry →
   the text before the first `/`), then `normalize_provider` both sides
   (`Moonshot AI` → `moonshotai`, `Atlas Cloud` ↔ `atlas-cloud` →
   `atlascloud`). Caveat feeding Task 5: an SSE comment line
   (`: OPENROUTER PROCESSING`) can precede chunk 0 — the capture peek must
   skip comment lines and keep peeking until a `data:` line parses.
4. **Hook coexistence; OpenCode never sets `provider` itself.** TWO
   `http.request` hooks registered by the same plugin both fired on every
   request (and the cross-plugin case with the guard's hook was live), so
   Task 4's second registration was safe. No observed request body ever
   carried a `provider` key (the plan records 0/14; the wave's session ledger
   corrected the tally to 13 — a count slip, not a fact change) — the
   injection's no-clobber guard is a pure safety net. The response-hook
   mechanism (pass-through TransformStream peek + `event.response`
   reassignment, headers minus `content-length`/`content-encoding`) worked
   12/12 with zero wrap errors.

## Rulings (sticky — shaped the wave)

1. **Applied-order threading (Task 4 → Task 5).** Task 5's `captureEndpoint`
   needs the steering order ACTUALLY applied to the request, but the plan never
   named how the response hook learns it. Ruling: Task 4's injection hook
   records the applied order per session on WireState when it injects (and
   nulls the record when it does not inject); Task 5's response hook reads that
   record as `captureEndpoint`'s `order` argument — so `!` only ever asserts
   "served outside the steering order" when a non-empty order was actually
   applied. Cost if wrong: a false `!` toast (or a missed verdict) — cosmetic.
2. **The cannot-steer toast's TUI scope guards + once-per-session semantics.**
   The emit fires at most once per session (a per-session "already toasted"
   flag, not per request); the TUI listener adopts the report-events pattern's
   BOTH scope guards (event `location.directory === here` AND the event's
   sessionID === the current session). Accepted cost: a notice for a
   same-project background session is dropped forever — the toast is a
   cold-start nicety about the session the user is interacting with (the copy
   says "this session"), and noise from sessions the user never opened is the
   worse failure. Headless (no TUI) shows nothing — matching the existing
   TUI-coupled surfaces.
3. **The pre-existing-`provider` exclusion binds the Q2 path too.** The
   no-clobber rule's rationale ("user-configured routing is not 'cannot
   steer'"; the toast copy "OpenRouter default routing applies" would be false)
   applies verbatim to the cannot-steer emit: when the request body already
   carries a `provider` key, the hook skips the emit (a one-off clone-parse
   gated behind the once-flag check — the skip does not burn the flag) and
   leaves the body untouched.

## Entries

| # | Task | Outcome |
|---|------|---------|
| 2 | Project the steering block through `validateCatalog` | **Outcome 2026-10-23:** commit c1d2d41 — `ModelEntry.steering` projected from the raw `provider` sub-object with the pricing-split posture (malformed field → field absent, never a document rejection; empty `order`/`ignore` → whole block absent, empty `quantizations` → field absent; the sanitized field explicitly overrides the `...entry` spread so a hostile raw block cannot leak); `Steering` type added. 365 unit tests + typecheck green; review clean. |
| 3 | Pure steering decision + capture-decision core | **Outcome 2026-10-23:** commit 54d31a7 — `src/core/steering.ts`: `steeringFor` (variant-blind alias identification; the inverted-match anti-goal — never match "the pick's model equals the request ref" — pinned by test), `injectSteering` (no-clobber; never the block's top-level `model`), `captureEndpoint` (symmetric provider-part reduction per spike fact 3; `downgrade` only against a non-empty parseable order). 391 unit tests; review clean. |
| 4 | Wire the `http.request` injection hook | **Outcome 2026-10-23:** commit 55e29e9 — second `http.request` registration beside the guard's (spike fact 4), per the spike's verified Request-recreation mechanism, failing open; records the applied order per session per Ruling 1. 412 passed / 13 skipped; review clean. |
| 5 | Wire the `http.response` capture hook | **Outcome 2026-10-23:** commit a8f2492 — pass-through TransformStream peek (SSE comment-line skipping per spike fact 3) with byte-for-byte forwarding; per-session `lastEndpoints` (last-writer-wins within a session, `model` captured alongside `endpoint`); `order` consumed from Ruling 1's record; hook-name union widened to accept `"http.response"`. 421 passed / 13 skipped; review clean. |
| 6 | Q2 fallback — the cannot-steer toast | **Outcome 2026-10-23:** commits 1c60155 + b80b80d — once-per-session emit from the injection hook when the alias-binding signal is absent but a steerable alias request arrives; `src/tui.tsx` listener → `context.ui.toast.show`. Review fix round adopted both scope guards (Ruling 2) and bound the pre-existing-`provider` exclusion to the Q2 path (Ruling 3). 416 unit tests; review clean after 1 fix round. |
| 7 | alt+e toast + report-dialog footer | **Outcome 2026-10-23:** commit f60127a — `alt+e` keybind (`last response served by <endpoint>`, or `! served by <endpoint> — not in steering order` on downgrade; silent with no capture); report-dialog footer `last response: <model> @ <endpoint>` (omitted with no capture); the steering note derives from the enabled aliases' current picks' `quantizations` union and renders only when every enabled alias carries the data; README Keyboard-shortcuts row added. Review clean. |
| 8 | README documentation (#4) | **Outcome 2026-10-23:** commit 787823e — the steering section: what is injected (the `provider` routing object), where it comes from (the catalog's per-model `steering` block), the aliases-only rule, the pre-existing-`provider` exception, the cannot-steer fallback, and endpoint verification (alt+e; the response body's `provider`; OpenRouter's dashboard) including the bounded-peek limitation. Every claim traced to the implemented behavior; review clean. |
| 9 | Version bump + ledger | **Outcome 2026-10-23:** this docs commit (ledger + plan + spec committed; Tasks 2–9 checkboxes swept to `[x]`) + the release commit (`chore: release 0.3.0 — steering + served-endpoint visibility`; package.json 0.2.0 → 0.3.0, lock's two version fields only, matching the 0.1.3/0.1.2 release-commit shape). Gates: `npx vitest run` — 450 passed / 13 skipped / 0 failed (22.1 s); `MC_INTEGRATION=1 npx vitest run tests/integration/` — 13/13 (142.9 s, one run, single session on 14721); `node scripts/pack-smoke.mjs` — ok: 27 files in model-compare-opencode-plugin-0.3.0.tgz, §12 list matches, exports and imports resolve; `npm run typecheck` — 0. |

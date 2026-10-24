# Steering injection + served-endpoint visibility — design

Resolves upstream issues [#4](https://github.com/canonical/model-compare-opencode-plugin/issues/4)
(steering documentation) and [#5](https://github.com/canonical/model-compare-opencode-plugin/issues/5)
(served endpoint in the UI), on top of the merged vendor-0.4.0-v3 work (catalog schema v3).

## Intent and why

The v0.4.0 catalog carries a per-model `steering` block — OpenRouter's provider
routing object (`provider: {order, ignore, quantizations, allow_fallbacks}`),
built so that routing lands on exactly the endpoints whose pricing the ranking
used (baseline-eligible, default-precision, cheapest blended first; sub-default
quantizations and ineligible endpoints ignored). The plugin neither projects
nor validates this block (the raw field passes through the catalog spread
untouched), so nothing injects it and OpenRouter default-routes every request:
traffic can land on sub-default-quantization endpoints whose prices the
ranking never ranked, the paid price diverges from the ranked price, and
nothing in the TUI shows which endpoint actually served a response.

Two fixes, one release:

1. **Steering injection (#4):** alias requests carry the catalog's steering block
   in their OpenRouter request body, so the paid price matches the ranked price.
2. **Served-endpoint visibility (#5):** the plugin records which endpoint actually
   served each alias response and surfaces it in the TUI, making OpenRouter's
   fallback behavior (and any downgrade routing) observable in-session.

## Goals

- Requests made through one of the plugin's three aliases
  (`openrouter/model-compare/{balanced,price,quality}`) carry the resolved pick's
  `provider` steering object in the JSON body.
- The plugin records, per session, the endpoint and model that served the last
  response to an alias request.
- `alt+e` toasts the last alias response's served endpoint — alias responses
  only, never all responses; an endpoint outside the steering order (a fallback
  OpenRouter chose despite the steering) is flagged `!` with
  "not in steering order".
- The report dialog (alt+shift+m) shows a footer line naming the last response's
  endpoint (the user's chosen variant C): `last response: <model> @ <endpoint>`,
  plus the steering note `routing steered to <quant> endpoints (aliases only)`.
- The README documents what gets injected, where the block comes from (the
  catalog's per-model `steering` block, vendored script or published catalog),
  that steering applies **only to the plugin's aliases** — never to a model the
  user picked directly — and how to verify which endpoint served a call
  (the alt+e toast; the response body's `provider` field; OpenRouter's dashboard).

## Non-goals

- No steering for non-alias requests: a model the user selects directly is
  never modified, even when the catalog has steering data for it.
- No steering toggle: steering is always-on for aliases. It is what makes the
  plugin's value promise ("the ranked price is what you pay") true.
- No auto-toast per response: the toast fires only on the keybind.
- No cross-link work on the model-compare site (that is the site repo's job).

## Anti-goals (a failure even if it technically works)

- A plugin hook error breaking or delaying a request/response. Every hook
  body fails open: any error leaves the original request/response untouched.
- Buffering or consuming a response stream to look at it. The capture must
  forward the stream byte-for-byte; only a bounded peek happens inline.
- Steering requests the user made outside the aliases (changes behavior the
  user never asked the plugin to govern).

## Constraints

- Bodies are one-shot streams: the request hook re-creates the Request from the
  modified JSON; the response hook wraps the body in a pass-through transform
  that peeks at most the first chunks and then forwards everything untouched.
- Scoping: injection and capture fire only when the session's model is one of
  the three alias refs AND the request's model equals that alias's current pick.
- Offline / no steering data: no injection (OpenRouter default-routing applies,
  today's behavior); capture still records whatever served.
- No request-kind filter: the scoping rule applies per request — a request of
  any kind (primary, compaction, title, generate) whose model is the alias's
  current pick gets steering, and auxiliary kinds whose requests run a
  different model are naturally excluded (the spike settles which kinds those
  are). The recorded/displayed endpoint is the last **primary** response's.
- The plugin must not assume the response is SSE or JSON: any body it cannot
  parse passes through unmodified, uncaptured.
- Capture is best-effort within the bounded peek: a non-streaming JSON body
  whose `provider` key lies beyond the peek window is forwarded untouched and
  not captured — the alt+e toast then reports nothing; the response body's
  `provider` field and OpenRouter's dashboard remain the authoritative
  verification paths.

## Decisions (user-approved in conversation)

- Report dialog shows a **footer line** (option C), not per-row markers:
  `last response: <model> @ <endpoint>` — omitted when nothing was captured.
- The steering note renders in the report dialog footer above the last-response
  line; copy generalizes over the steering block's `quantizations` list.
- Toast on a new keybind, `alt+e` (issue's suggestion, user-approved toasts).
  Downgrade/fallback case: `! served by <endpoint> — not in steering order`.
- Docs (#4): a README section covering the injected routing object, its source
  (the catalog's per-model `steering` block from the vendored script or the
  published catalog), the aliases-only rule, and verification paths.

## Builder-check rulings (settled design calls, 2026-10-23)

- **Endpoint membership rule (downgrade `!` flag):** the spike records the exact
  string OpenRouter's response `provider` field carries. Matching is
  symmetric: both the served provider string and each `order` entry are
  normalized (casefold, strip non-alphanumerics — the script's
  `normalize_provider` semantics), both are reduced to their provider part
  (the text before the first `/`), and the two parts are compared — so a
  tag-carrying served string (`streamlake/fp8`) matches its identical `order`
  entry and is never flagged. Spike fact 3's format finding refines the exact
  reduction if the observed format differs. A served provider matching no
  `order` entry is flagged `!`. An unparseable or absent `provider` string
  flags nothing — the toast then reports the endpoint verbatim with no
  verdict. With no steering data — an absent or empty `order` (offline, or a
  model without a steering block) — capture records the endpoint but flags
  nothing: `!` may only assert a fallback "despite the steering" when a
  non-empty steering order was actually applied.
- **Pre-existing routing in the body:** if the request body already carries a
  `provider` key, the plugin does NOT inject — it never clobbers routing the
  user or provider configured. The divergence is observable via the alt+e
  toast; the README's steering section notes the exception. The spike records
  whether OpenCode ever sets `provider` itself in practice. The steering
  block's top-level `model` field is never injected — only the `provider`
  sub-object is. A body `models` array is left untouched.
- **Footer steering note:** the note derives from the union of the
  `quantizations` lists across the three enabled aliases' current picks; shown
  when that union is non-empty (`routing steered to fp8 endpoints (aliases
  only)`), omitted when any of it is missing (no steering data, offline).

## Open items resolved by a spike (before wiring)

The `http.request`/`http.response` events expose the session's model
reference, and for an enabled alias-bound session that IS the alias ref —
committed integration evidence asserts post-switch requests' `event.model`
carries the alias ref (`model-compare/<p>`), never the fallback-resolved
concrete pick id. (The guard's "effective (fallback) reference" note applies
to the disabled-alias/built-in-fallback case only.) Alias identification
therefore parses the event's model ref with the guard's `parseAliasRef` —
that is the signal; no extra one is needed. A live spike (integration
harness, real server) must establish, for one alias call:

1. that `event.model` reads as the alias ref for EVERY binding style
   (root-default, `--model`, frontmatter — the Q2 gate's reliability
   question), which refs auxiliary kinds (title/compaction) carry (they may
   use a small model), and what the disabled-alias/fallback case shows;
2. that mutating the request (clone, inject `provider`, reassign) survives the
   real request path and OpenRouter honors the routing;
3. that OpenRouter responses carry `provider` (and `model`) in both the
   streaming (first SSE chunk) and non-streaming shapes — and the exact format
   of the `provider` string (steering tags are script-built slugs like
   `streamlake/fp8`; the response's format determines the membership rule);
4. that a second `http.request` hook coexists with the guard's, and whether
   OpenCode ever sets a `provider` key in the request body itself.

The spike is throwaway; its findings land as recorded facts in the plan's
wiring tasks (Task 3's and Task 4's wiring notes).

## Q2 ruling — coverage gate (2026-10-23)

If the spike finds no reliable alias-binding signal (no signal covering
root-default/`--model`/frontmatter bindings), steering does NOT ship: the
plugin falls back to OpenRouter's default routing and says so. A toast informs
the user that steering cannot be applied — "cannot steer this session;
OpenRouter default routing applies" — delivered over the plugin's existing
rpc-event → TUI bridge (the hook emits an rpc event; the TUI renders the
toast — the hook layer has no ui domain). The steering-injection feature is
gated on a reliable alias-binding signal existing; partial coverage is not
shipped.

Capture and visibility still ship in that world, scoped by the best available
partial signal (the request-model-equals-pick heuristic, or whatever the spike
records): direct-pick false positives are accepted and documented in the
ledger. The report's steering note must not render when nothing is steered.

## What's left to the builder

- The exact sanitization shape for the projected `steering` field (validated
  arrays/booleans; anything malformed → field absent per field), following the
  pricing-split posture — not the weights posture (which rejects the whole
  document on shape violations).
- Alias identification wired into a pure, unit-tested decision function over
  the guard's `parseAliasRef` (the spike confirms the ref's reliability across
  binding styles).
- Test placement per the repo's flat `tests/unit/` layout and the integration
  harness's existing patterns.

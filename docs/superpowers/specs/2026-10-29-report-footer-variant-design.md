# Report dialog: drop the dead variant cell, raise the list cap with room to spare

**Status:** proposed
**Date:** 2026-10-29
**Branch:** `vendor-0.7.0-v6-only` (same worktree; both changes follow from the v6 semantics and the dialog's current layout)

## Intent

Two small UI corrections to the report dialog (alt+shift+m, the selectable ranked list):

1. **The "best higher variant" cell is dead.** Under catalog v6, `quality` is the AA index at the model's **best measured selectable depth**. No measured selectable depth can score higher, so `bestDepthAlternative` returns null for every model. The in-repo proof is the recorded fixture (`fixtures/catalog-v0.7.0.json`): 0 of its 14 scored models has any deeper selectable variant. The live published catalog showed the same when verified during the 0.7.0 branch review, but no repo test pins that invariant — the nightly canary (`scripts/canary-check.mjs`) checks document shape (schema_version, models, scores), not the best-depth property — so the removal rests on the v6 semantics plus the fixture. The cell can still fill only for a user-pointed `catalogURL` serving an **explicit-effort** v6 document, and the `/model-compare` text report already prints that alternative conditionally (the signal that survives for such catalogs).

2. **The list is capped more tightly than it needs to be.** The shared cap is `min(contentLines, max(1, floor(h/2) − 6))`. On a 40-row terminal the report shows 14 of its ~21 content lines, though the dialog has vertical room to spare.

## Decisions

**Footer — Approach A (chosen):** remove the cell from the report-dialog footer only.

- Footer becomes `variant: max` (or `variant: -` when the model has no scored effort).
- Keep `alternative` in the RPC payload and the `/model-compare` text report unchanged.
- Do not remove `bestDepthAlternative` / `formatDepthAlternative` or their tests: they remain correct for explicit-effort v6 documents and as defense-in-depth.
- Remove `altW` and the status-line width arithmetic that reserved 24 columns for the label; the variant cell keeps its 7-column clamp.

**List cap — Approach B (chosen): a height-aware bump.**

```
cappedRowsHeight(contentLines, h) =
  min(contentLines, max(1, min(floor(h/2) − 3, h − 12)))
```

- `floor(h/2) − 3` is the requested +3 over today's `− 6`.
- `h − 12` is the viewport budget, not a today-preserving clamp. It is the smaller term below h ≈ 18 (it ties with `floor(h/2) − 3` at h = 17–18 and binds strictly for h ≤ 16), so on short terminals it — not the bump term — sets the cap. Chrome recount from the dialog's JSX (src/tui.tsx:621-718): title 1 + status 1 + Details 1 + paddingBottom 1, plus box gaps — the outer box stacks 4 + F children (title, scrollbox, status line, F rendered footerLines 0–2, Details), so 3 + F gaps — totalling **7 + 2F plugin lines** (7 bare, 9/11 with one/both footer lines; the status line renders in the report dialog only, so the picks dialog's chrome is smaller still), plus the host dialog panel's padding, which in-repo is known to contribute one top blank (src/tui.tsx:618-620) and is unquantified beyond that. Budget check: (h − 12) + 7 + 2F ≤ h − 1 for F ≤ 2, so the dialog fits the viewport with a row to spare even with both footer lines, and lands exactly on h once the host's known top blank is counted. This reproduces today's cap exactly only at h ≤ 13 (both give 1 there); in the 14–17 band the cap grows 1–3 rows over today **by design** — that growth is the requested bump, and the budget is what keeps it inside the viewport.
- **Content-bounded, always:** the result is still `min(contentLines, …)` and the scrollbox uses it as `maxHeight`, not a fixed height. A short list keeps its natural height — no blank rows, no padding to the ceiling. `contentLines = 0` still yields 0.

| terminal rows | today | new |
|---|---|---|
| 13 | 1 | 1 |
| 16 | 2 | 4 |
| 20 | 4 | 7 |
| 24 | 6 | 9 |
| 40 | 14 | 17 |
| 60 | 24 | 27 |

At 40 rows the report's ~21 content lines still exceed the cap (so it stays scrollable, three more models visible); at 60 it already shows everything.

## Non-goals

- No structural change to the alt+m picks dialog (it has no footer lines and no status line). Its height does move with the shared formula below h ≈ 18: the picks list is 3 content lines, content-bound for h ≥ 15 (today h ≥ 18); below that the shared cap binds it, and the new formula binds it less aggressively (terminal 16: 2 → 3) — an accepted side effect of the shared formula, pinned by a test (see Tests).
- No change to `/model-compare` text output, the RPC schema, alias names, or the core alternative functions.
- No change to the home/prompt footer status line (`MC: balanced → <pick>`).
- No blank-line removal: the heading separators are intentional and are part of `rowsHeight`.

## Documentation

Three README sentences describe the footer as showing "the highlighted model's variant and its best higher variant" (lines 15, 74, 90). Update them to say the status line shows the highlighted model's variant. Keep the text-report sentence about `· alt max 56.0` (still true there).

## Tests

- `cappedRowsHeight`: pin the new values (13 → 1, 16 → 4, 20 → 7, 24 → 9, 40 → 17), plus the 14–17 band the guard binds in: (50, 14) → 2, (50, 15) → 3, (50, 17) → 5 — today 1/1/2; the growth is intentional. Also pin the picks side effect: (3, 16) → 3 (today 2 — the picks list's 3 lines become content-bound from h = 15). Keep "short lists keep their natural height" (content-bound, no padding) and "no rows means no height"; keep the tiny-viewport one-row floor.
- The resize test's terminal-24 `maxHeight` assertion (tests/unit/tui.test.ts:1402) changes 6 → 9. The terminal-40 assertions stay **12**: :1406 and the row-area test's :1432 assert the rig fixture's 12 content LINES, which is content-bound under both formulas (min(12, 17) = 12) — no test asserts 14. "14" appears only in the comments: update :1404 and :1425 ("the cap rises to/is 14") to 17, and :1400's "the cap is 6" to 9. The picks assertion (:1442, 3 at terminal 24) is unchanged (min(3, 9) = 3).
- Footer assertions: `variant: high · best higher variant: max 56.0` → `variant: high`; the two `· best higher variant: -` cases → `variant: medium` / `variant: max`.
- The two wide-character clamp tests: drop the `alternative` half of each assertion and fixture entry; keep asserting the effort cell clamps by display columns and the line fits the 56-column budget.
- Pin the `variant: -` fallback: one assertion for an entry whose `effort` is "" (the `entry.effort || "-"` branch this change rewrites; currently zero-covered — the ENTRIES fixture carries only high/medium/max).
- Comment and name refresh: src/tui.tsx:157-163 (the `cappedRowsHeight` doc comment states the −6 formula — restate the new one), :120-123 and :773-777 (the `ListRow.status` and `showReportDialog` comments name "best higher variant"), :798-804 (the 24-column reservation arithmetic — removed with `altW`), :851-859 (variant-only wording); tests/unit/tui.test.ts:1010-1014 (the describe comment names "best higher variant"), :1280 (the test name "caps the row area at half the viewport minus six rows" — rename to the new bound), :1400/:1404/:1425/:1440-1441 (cap-arithmetic comments quoting the old 6/14 numbers → 9/17).

## Risk

Low, display-only. The height formula is shared by both list dialogs: the picks dialog is content-bound for h ≥ 15 (today h ≥ 18) and the shared cap binds it below that — after the bump less aggressively (terminal 16: 2 → 3, accepted and pinned). Below h = 14 the cap is unchanged from today; in the 14–17 band it grows 1–3 rows by design, and the `h − 12` budget is what keeps the dialog inside the viewport there.

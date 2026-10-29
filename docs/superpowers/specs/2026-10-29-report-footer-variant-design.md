# Report dialog: drop the dead variant cell, raise the list cap with room to spare

**Status:** proposed
**Date:** 2026-10-29
**Branch:** `vendor-0.7.0-v6-only` (same worktree; both changes follow from the v6 semantics and the dialog's current layout)

## Intent

Two small UI corrections to the report dialog (alt+shift+m, the selectable ranked list):

1. **The "best higher variant" cell is dead.** Under catalog v6, `quality` is the AA index at the model's **best measured selectable depth**. No measured selectable depth can score higher, so `bestDepthAlternative` returns null for every model: 0 of 14 scored models in the recorded fixture has any deeper selectable variant, and the live published catalog behaves the same. The footer cell is therefore permanently `-` — noise in a 56-column footer. The cell can still fill only for a user-pointed `catalogURL` serving an **explicit-effort** v6 document, and the `/model-compare` text report already prints that alternative conditionally.

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
- `h − 12` is the viewport guard: the dialog's chrome is ~7 plugin lines plus the host panel's padding, leaving roughly one spare row. On short terminals this term returns today's cap instead of overflowing; at h = 13 both give 1.
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

- No change to the alt+m picks dialog (it has no footer, and its 3 rows never reach the cap).
- No change to `/model-compare` text output, the RPC schema, alias names, or the core alternative functions.
- No change to the home/prompt footer status line (`MC: balanced → <pick>`).
- No blank-line removal: the heading separators are intentional and are part of `rowsHeight`.

## Documentation

Three README sentences describe the footer as showing "the highlighted model's variant and its best higher variant" (lines 15, 74, 90). Update them to say the status line shows the highlighted model's variant. Keep the text-report sentence about `· alt max 56.0` (still true there).

## Tests

- `cappedRowsHeight`: pin the new values (13 → 1, 16 → 4, 20 → 7, 24 → 9, 40 → 17); keep "short lists keep their natural height" (content-bound, no padding) and "no rows means no height"; keep the tiny-viewport one-row floor.
- Resize/row-area tests that assert `maxHeight` 6 at terminal 24 (report) and 14 at 40: update to 9 and 17.
- Footer assertions: `variant: high · best higher variant: max 56.0` → `variant: high`; the two `· best higher variant: -` cases → `variant: medium` / `variant: max`.
- The two wide-character clamp tests: drop the `alternative` half of each assertion and fixture entry; keep asserting the effort cell clamps by display columns and the line fits the 56-column budget.

## Risk

Low, display-only. The height formula is shared by both list dialogs, but the picks dialog is always content-bound; the `h − 12` guard preserves today's behaviour on terminals too short for the bump.

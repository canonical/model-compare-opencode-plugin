# Report-dialog footer: drop the dead "best higher variant" cell

**Status:** proposed
**Date:** 2026-10-29
**Branch:** `vendor-0.7.0-v6-only` (same worktree; this is the UI consequence of the v6 semantics)

## Intent

The report dialog (alt+shift+m, the selectable ranked list) renders a status line under the cursor:

```
variant: max · best higher variant: -
```

Under catalog v6, `quality` is the AA index at the model's **best measured selectable depth**. No measured selectable depth can score higher, so `bestDepthAlternative` returns null for every model: 0 of 14 scored models in the recorded fixture has any deeper selectable variant, and the live published catalog behaves the same. The "best higher variant" cell is therefore permanently `-` for both of the plugin's sources — noise in a 56-column footer.

The cell can still fill for one configuration: a user-pointed `catalogURL` serving an **explicit-effort** v6 document, where `quality` sits at the requested effort while a higher measured selectable depth exists. That information is already carried, conditionally, by the `/model-compare` text report (`· alt max 56.0` appended only when non-empty). So the footer loses nothing that is not available elsewhere.

## Decision

**Approach A (chosen):** remove the cell from the report-dialog footer only.

- Footer becomes `variant: max` (or `variant: -` when the model has no scored effort).
- Keep `alternative` in the RPC payload and the text report unchanged.
- Do not remove `bestDepthAlternative` / `formatDepthAlternative` or their tests: they remain correct for explicit-effort v6 documents and as defense-in-depth against a malformed document.
- Remove the `altW` clamp and the status-line width arithmetic that reserved 24 columns for the label; the variant cell keeps its 7-column clamp.

## Non-goals

- No change to the alt+m picks dialog (it has no footer).
- No change to `/model-compare` text output, the RPC schema, alias names, or the core alternative functions.
- No change to the home/prompt footer status line (`MC: balanced → <pick>`).

## Documentation

Three README sentences describe the footer as showing "the highlighted model's variant and its best higher variant" (lines 15, 74, 90). Update them to say the status line shows the highlighted model's variant. Keep the text-report sentence about `· alt max 56.0` (still true there).

## Tests

- `tests/unit/tui.test.ts` footer assertions: `variant: high · best higher variant: max 56.0` → `variant: high`; the two `· best higher variant: -` cases → `variant: medium` / `variant: max`.
- The two wide-character clamp tests: drop the `alternative` half of each assertion and fixture entry; keep asserting the effort cell clamps by display columns and the line fits the 56-column budget.
- No other test reads the footer label.

## Risk

Low. Display-only. The only behaviour lost from the dialog is a permanent `-`; the custom explicit-effort case still surfaces in the text report.

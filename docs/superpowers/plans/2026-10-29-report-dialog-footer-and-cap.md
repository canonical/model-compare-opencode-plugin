# Report dialog: variant-only footer and a height-aware list cap — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the permanently-dead "best higher variant" cell from the report dialog's cursor status line, and raise the shared list cap by 3 rows on roomy terminals while keeping it content-bounded (no blank rows).

**Architecture:** Two independent display changes in `src/tui.tsx`. The footer change rewrites `statusOf` and deletes `altW`; the cap change rewrites `cappedRowsHeight` to `min(contentLines, max(1, min(floor(h/2) − 3, h − 12)))`. Both are pure/display-only; the RPC payload, `/model-compare` text report, and `bestDepthAlternative` stay untouched.

**Tech Stack:** TypeScript + Solid (TUI), vitest (unit rig renders the dialog tree).

**Spec:** `docs/superpowers/specs/2026-10-29-report-footer-variant-design.md` (approved after review; corrected at commit `b44cd2d`).

**Worktree:** `.worktrees/vendor-0.7.0-v6-only`, branch `vendor-0.7.0-v6-only`. Baseline: `npm run typecheck` exit 0; `npm test` 511 passed / 13 skipped / 0 failed.

## Global Constraints

- **Content-bounded, always:** `cappedRowsHeight` returns `min(contentLines, budget)`; the scrollbox uses it as `maxHeight`, never a fixed height. Short lists keep their natural height — no blank rows. `contentLines = 0` → 0.
- **Footer becomes `variant: <effort>`** (or `variant: -` when the effort is empty). No "best higher variant" text remains anywhere the user reads.
- **Do not change:** `alternative` in the RPC schemas (`src/rpc.ts`), the `/model-compare` text report (`src/opencode/commands.ts`), `bestDepthAlternative`/`formatDepthAlternative` (`src/core/reasoning.ts`) or their tests, alias names, the home/prompt footer (`statusLine`).
- **Formula (exact):** `min(contentLines, max(1, min(Math.floor(h / 2) - 3, h - 12)))`. Expected values: (50,13)→1, (50,14)→2, (50,15)→3, (50,16)→4, (50,17)→5, (50,20)→7, (50,24)→9, (50,40)→17, (50,60)→27, (3,16)→3, (3,40)→3, (0,40)→0.
- Line numbers are from `fc0841a`+`b44cd2d`; if drifted, grep for the quoted content.
- **Never** run background shell commands without an explicit working directory (earlier in this branch, background shells inherited the main checkout); every command must run in the worktree.

## Review Focus

- **Tiny viewport (h ≤ 13):** the budget must not shrink below today's behaviour or overflow — expect (50,13)→1 and the one-row floor preserved.
- **Short list on a tall terminal:** no padding to the cap — expect (3,40)→3 and the picks dialog at terminal 24 → 3 (content-bound).
- **The 14–17 growth band:** intentional +1–3 rows; expect (50,14)→2, (50,15)→3, (50,17)→5 and no overflow with 2 footer lines (budget check: (h−12) + 7 + 2·2 ≤ h−1).
- **Unscored model:** effort empty → `variant: -` (currently untested).
- **Legacy v5 alias names:** `usebest.ts` still strips `[alt …]` from names — removing the footer must not touch that path.

---

### Task 1: Height-aware content-bounded list cap

**Files:**
- Modify: `src/tui.tsx:157-167` (`cappedRowsHeight` + its doc comment)
- Test: `tests/unit/tui.test.ts:1279-1295` (cap pins), `:1396-1412` (resize), `:1423-1443` (row-area), comments at `:1400,1404,1425,1440-1441`

**Interfaces:**
- Consumes: nothing.
- Produces: `cappedRowsHeight(contentLines: number, terminalHeight: number): number` — content-bounded as specified in Global Constraints; sole call site `src/tui.tsx:638` (`maxHeight`).

- [ ] **Step 1: Write the failing tests**

Replace the `cappedRowsHeight` describe with:

```ts
describe("cappedRowsHeight (the palette's list cap)", () => {
  test("caps the row area at half the viewport minus three, within the viewport budget", () => {
    expect(cappedRowsHeight(50, 40)).toBe(17)
  })

  test("the viewport budget binds on short terminals (the 14-17 growth band)", () => {
    expect(cappedRowsHeight(50, 13)).toBe(1)
    expect(cappedRowsHeight(50, 14)).toBe(2)
    expect(cappedRowsHeight(50, 15)).toBe(3)
    expect(cappedRowsHeight(50, 17)).toBe(5)
  })

  test("short lists keep their natural height", () => {
    expect(cappedRowsHeight(3, 40)).toBe(3)
    // The picks dialog's 3 rows are content-bound from h = 15 (were from 18).
    expect(cappedRowsHeight(3, 16)).toBe(3)
  })

  test("a tiny viewport still shows one row", () => {
    expect(cappedRowsHeight(50, 13)).toBe(1)
  })

  test("no rows means no height", () => {
    expect(cappedRowsHeight(0, 40)).toBe(0)
  })
})
```

In the resize test (`:1396-1412`): `expect(scrollbox.props.maxHeight).toBe(6)` → `toBe(9)`; keep the terminal-40 `toBe(12)` assertion (the 12-line rig fixture is content-bound under both formulas); update its comment `"the cap rises to 14"` → `17`. In the row-area test (`:1423-1433`): keep `toBe(12)`; update the comment `"the cap is 14"` → `17`. The picks assertion (`:1442`) stays `toBe(3)`; update its comment `"min(3, cap 6 at terminal 24)"` → `"min(3, cap 9 at terminal 24)"`.

- [ ] **Step 2: Run to verify RED**

Run: `npx vitest run tests/unit/tui.test.ts -t 'cappedRowsHeight|resize|row-area'`
Expected: the new cap pins FAIL (`17` vs `14`, `2` vs `1`, `9` vs `6`); the terminal-40 pins pass already.

- [ ] **Step 3: Implement the formula**

In `src/tui.tsx`, replace `cappedRowsHeight` and its comment:

```ts
// The list dialogs' row-area cap: min(content LINES, the dialog's vertical
// budget). The budget is the requested half-viewport allowance minus three
// rows (the host palette's −6, loosened by three), further bounded by
// h − 12 so the dialog's chrome (7 plugin lines plus up to two footer
// lines) plus the host panel's top blank always fit: on short terminals
// the budget binds before the allowance does. The first argument is
// rowsHeight(rows), never the rows' count, or the cap clips tail rows even
// on a roomy terminal. Content-bounded: a short list keeps its natural
// height, so the dialog never pads with blank rows. The host's dialog layer
// caps nothing itself and anchors UNcentered dialogs a quarter viewport
// down — without this cap an uncapped list overflows the viewport at large
// font sizes (the report dialog did exactly that). Exported for the unit
// rig.
export function cappedRowsHeight(contentLines: number, terminalHeight: number): number {
  return Math.min(
    contentLines,
    Math.max(1, Math.min(Math.floor(terminalHeight / 2) - 3, terminalHeight - 12)),
  )
}
```

- [ ] **Step 4: Run to verify GREEN**

Run: `npx vitest run tests/unit/tui.test.ts && npm test`
Expected: PASS; suite 511+ passed / 13 skipped / 0 failed.

- [ ] **Step 5: Commit**

```bash
git add src/tui.tsx tests/unit/tui.test.ts
git commit -m "feat(tui): raise the list cap by three rows within the viewport budget"
```

### Task 2: Variant-only cursor status line

**Files:**
- Modify: `src/tui.tsx:120-123` (ListRow.status doc), `:773-777` (showReportDialog comment), `:798-806` (`altW` + width comment), `:851-864` (`statusOf`)
- Test: `tests/unit/tui.test.ts:1013` (describe comment), `:1047,1055,1058,1080,1137` (assertions), wide-char fixtures at `:1070` and `:1128`

**Interfaces:**
- Consumes: nothing.
- Produces: `statusOf(entry) => \`variant: ${cell(entry.effort || "-", effortW)}\`` — no alternative cell.

- [ ] **Step 1: Write the failing tests**

In `tests/unit/tui.test.ts`:
- Describe comment `:1013`: "The scored variant and the best higher variant moved off the table…" → "The scored variant moved off the table into a status line below the list…".
- `:1047`: `"variant: high · best higher variant: max 56.0"` → `"variant: high"`.
- `:1055`: `"variant: medium · best higher variant: -"` → `"variant: medium"`.
- `:1058`: `"variant: max · best higher variant: -"` → `"variant: max"`.
- Wide-char CJK test `:1070`: fixture entry becomes `{ ...ENTRIES[0], effort: "深度深度深度深度" }`; assertion `:1080` becomes `"variant: 深度深…"`; comment drops the alternative clause.
- Emoji test `:1128`: fixture entry becomes `{ ...ENTRIES[0], effort: "🚀🚀🚀🚀🚀" }`; assertion `:1137` becomes `"variant: 🚀🚀🚀…"`; comment drops the alternative clause.
- New test in the same describe, after the cursor-following test:

```ts
  test("an unscored model's empty effort renders as a dash", async () => {
    active = await activate()
    active.reportPayload.age = "1h"
    active.reportPayload.entries = [{ ...ENTRIES[0], effort: "" }]
    await active.command("model-compare.report").run()
    await drain()
    expect(treeTexts(renderDialog(active).tree)).toContain("variant: -")
  })
```

- [ ] **Step 2: Run to verify RED**

Run: `npx vitest run tests/unit/tui.test.ts -t 'cursor status line|clamps|dash'`
Expected: the footer assertions FAIL (old string still rendered); the `variant: -` test FAILS while `statusOf` still appends the alternative (the rendered line is `variant: - · best higher variant: …`).

- [ ] **Step 3: Implement**

In `src/tui.tsx`:
- Delete `const altW = 13` and rewrite the comment above `effortW` to cover only the variant cell: the 56-column line is `9 ("variant: ") + 7 = 16`, clamped in display columns, with the rest of the box left free.
- Replace `statusOf` body with:

```ts
      const statusOf = (entry: ReportEntry): string =>
        `variant: ${cell(entry.effort || "-", effortW)}`
```

- Rewrite the comments at `:851-859` to describe the variant-only line (catalog v6 quality sits at the best selectable depth, so there is no higher selectable alternative to advertise; the alternative label survives only in the text report for explicit-effort documents from a custom catalogURL), and the `ListRow.status` / `showReportDialog` comments to say "the report table's variant" only.

- [ ] **Step 4: Run to verify GREEN**

Run: `npm run typecheck && npm test`
Expected: typecheck exit 0; suite 512+ passed / 13 skipped / 0 failed.

- [ ] **Step 5: Commit**

```bash
git add src/tui.tsx tests/unit/tui.test.ts
git commit -m "feat(tui): variant-only report-dialog status line"
```

### Task 3: README and final verification

**Files:**
- Modify: `README.md:15`, `:74`, `:90`

- [ ] **Step 1: Update the three README sentences**

- `:15`: "…the report dialog's status line uses “variant” and shows the highlighted model's variant and its best higher variant." → "…the report dialog's status line uses “variant” and shows the highlighted model's variant."
- `:74`: "…a status line that follows the cursor and shows the highlighted model's variant and its best higher variant." → "…a status line that follows the cursor and shows the highlighted model's variant." (Keep the earlier sentence in that line about `· alt max 56.0` — the text report still prints it.)
- `:90`: "…the report dialog's status line carries the variant and best higher variant." → "…the report dialog's status line carries the variant."

- [ ] **Step 2: Final verification**

Run: `npm run typecheck && npm test`
Expected: exit 0; 512+ passed / 13 skipped / 0 failed.
Run: `node scripts/sync-vendor.mjs --check && curl -fsSL --proto-redir =https https://model-compare.dev/catalog.json | node scripts/canary-check.mjs`
Expected: pin ok; `canary ok: schema_version=6, …`.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: the report status line shows the variant only"
```

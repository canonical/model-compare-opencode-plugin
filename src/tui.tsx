// src/tui.tsx
// The model-compare CLI plugin (design §10, "Notices and status"): the
// terminal-UI half of the plugin, loaded from the `./tui` export. It owns
// everything the headless server cannot show:
//
//   * a live status line in the prompt and home footers, derived from the
//     model registry (the runtime plugin keeps the alias entries' display
//     names current, so the registry IS the state; no messaging involved);
//   * the picks dialog (alt+m): a select over the three priorities —
//     choosing one switches the session to it, with the same decision logic
//     as the server command; with no session open (the opening screen)
//     choosing one CREATES a session already bound to that alias and opens
//     it, so the shortcuts work from the first keystroke (merely OPENING a
//     dialog never creates a session);
//   * the report dialog (alt+shift+m): the /model-compare command emits its
//     structured report as an RPC event, and this half opens it as a
//     selectable dialog (selecting a ranked model switches straight to it) —
//     one command serves both worlds, so no TUI duplicate of the server
//     command exists; with no session open the report is fetched directly
//     over the plugin's RPC (no session command to post it to) and a pick
//     creates a session bound to that model;
//   * a toast when a pick flips (at most one per changed priority per
//     reload, and never for the first observation after load).
//
// The headless path (servers, `opencode run`, API clients) has no TUI: its
// notices stay inbox items delivered at the session's next turn (the
// commands' `resume: false`), which is correct there — there is no UI to
// toast in.
//
// Owner discipline: everything the host's bridges read through Solid context
// (the keymap layer registration) runs in setup's own scope, under the owner
// the TUI host captured for this activation. The createRoot below detaches
// from that chain on purpose — it owns the solid-js lifetime of the memos
// and effects — so nothing inside it may call context APIs that resolve
// Solid context: `context.keymap.layer(...)` inside the root threw
// "Keymap.Provider is missing" and failed the whole TUI half (observed live,
// 2026-10-11). The memos and helper functions therefore live at setup scope,
// where the root's effects and the keymap layers can both close over them.

import { Plugin } from "@opencode/plugin/tui"
import type { KeymapCommand } from "@opencode/plugin/tui/context"
import { TextAttributes, RGBA, type ColorInput } from "@opentui/core"
// The OpenTUI JSX element types (<text fg>, <box>): a type-only import loads
// the package's solid-js JSX augmentation without a runtime import — the TUI
// host already provides the runtime side.
import type { JSX } from "@opentui/solid"
import type { ScrollBoxRenderable } from "@opentui/core"
import {
  createEffect,
  createMemo,
  createRoot,
  createSignal,
} from "solid-js"
import type { Priority } from "./core/types"

import {
  ALIAS_PROVIDER,
  PRIORITIES,
  alignedPriority,
  aliasId,
  pickOf,
  pickFromName,
  readAliasViews,
  statusLine,
  useBestDecision,
  useBestNotice,
  useBestRefusal,
  type AliasView,
} from "./opencode/usebest"
import type { ReportEntry } from "./opencode/commands"
import { gatewayEffort } from "./core/reasoning"
import { lastResponseLine, sanitizeCatalogText } from "./opencode/commands"
import { ModelCompare } from "./rpc"

const TOAST_MS = 6_000
const RESYNC_MS = 30_000

// The plugin package name fragment this entry shares state with: the config
// lookup matches `plugins[].package` entries against it to read the runtime
// plugin's options (defaultPriority) through the client's config API.
const PACKAGE_FRAGMENT = "model-compare-opencode-plugin"
// The RPC event the /model-compare command emits (see src/rpc.ts; the wire
// name is prefixed with the RPC's id).
const REPORT_EVENT = "rpc.model-compare.report"
// The event the runtime hook emits once per session when it would have
// steered a request but has no steering data (no catalog source) — the Q2
// fallback's runtime notification. The toast copy below is the whole message.
const CANNOT_STEER_EVENT = "rpc.model-compare.cannotSteer"
const CANNOT_STEER_COPY = "cannot steer this session; OpenRouter default routing applies"

// The list dialogs' lifecycle token (see showListDialog): a module-scope
// generation counter, bumped every time a dialog is armed, plus the armed
// dialog's close. A dialog's close() tears down the shared state (the modal
// keymap layer, the host dialog) only while that dialog is STILL the armed
// one — a stale close must not clear a newer dialog's keyboard and surface —
// and arming a new dialog closes whatever is still armed first.
let dialogGeneration = 0
let armedClose: (() => void) | null = null
// The armed dialog's reveal hook (see showListDialog): its own
// revealOnFrame, exposed module-scope so the setup-scope resize handler can
// re-reveal the cursor when a resize re-caps the row area under it. Set
// when a dialog is armed, cleared by its close() alongside armedClose.
let armedReveal: ((center: boolean) => void) | null = null

function StatusLine(props: { line: () => string; fg?: ColorInput }) {
  return <text fg={props.fg}>{props.line()}</text>
}

// One list-dialog row (see showListDialog).
type ListRow = {
  // Section headings render in the palette's category color, and are
  // skipped by the cursor.
  heading?: string
  // A pre-built column-header line (the report table): dim, skipped by
  // the cursor, and never gets a blank line above it.
  headerLine?: string
  label: string
  // Trailing dim right-justified columns (the report table); when
  // present, label renders in its own span so the two tones can differ.
  columns?: string
  // The cursor-following status line (the report table's variant): the
  // dialog renders this row's status below the list and swaps it as the
  // cursor moves.
  status?: string
  selected?: string
  value?: string
  // The OpenCode variant the pick must select (`provider/model#variant`):
  // the effort the row's quality was measured at, when the catalog names a
  // gateway-selectable one. Undefined means the bare model (its default).
  // Carried on the row, not derived from `value`, because a model can be
  // listed under several priorities and the pick must use THIS row's effort.
  variant?: string
  dim?: boolean
}

// The rows' ONE height rule, shared by three places that must agree or the
// scroll lands on the wrong line: the rows' JSX (the heading's blank line
// above), rowOffset's arithmetic and the row-area cap's content measure. A
// header-line row renders as its text ONLY — the JSX checks headerLine
// before heading — so a row carrying both fields counts the way it renders,
// never as both. Every other row is one line except the second and later
// headings, which carry one blank line above (the palette's heading
// recipe).
function isHeadingRow(row: ListRow): boolean {
  return row.headerLine === undefined && row.heading !== undefined
}
function rowLines(row: ListRow, headingsSoFar: number): number {
  return isHeadingRow(row) && headingsSoFar > 0 ? 2 : 1
}
// The rows' total LINE count (not their row count — heading blanks are
// content too); `upto` measures the first rows alone, which is how rowOffset
// gets a row's y within the content.
function rowsHeight(rows: readonly ListRow[], upto: number = rows.length): number {
  let y = 0
  let headings = 0
  for (let k = 0; k < upto; k++) {
    const row = rows[k]!
    y += rowLines(row, headings)
    if (isHeadingRow(row)) headings += 1
  }
  return y
}

// The list dialogs' row-area cap: min(content LINES, the dialog's vertical
// budget). The budget is the host palette's half-viewport allowance minus
// three rows (-6 loosened by three), further bounded by h - 12 so the
// dialog's chrome (7 plugin lines plus up to two footer lines) and the host
// panel's top blank always fit: on short terminals the h - 12 budget binds
// before the allowance does. The first argument is rowsHeight(rows), never
// the rows' count, or the cap clips tail rows even on a roomy terminal (with
// the scrollbar hidden). Content-bounded: a short list keeps its natural
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

// The terminal display width of one code point, in columns: 2 for the ranges
// terminals render double-width — East Asian Wide/Fullwidth (CJK, Hangul) and
// the emoji/symbol planes — and 1 for everything else. Deliberately
// CONSERVATIVE: it never undercounts the wide content the catalog can carry.
// Blocks that are only partially wide are covered at BLOCK width — the
// narrow tails inside the SMP symbol planes (alchemical symbols, chess)
// count 2 anyway — and variation selector 16 (emoji presentation) counts 1
// itself, so a base+VS16 sequence such as ☺️ always totals ≥ 2 even when the
// base alone would not. Overcounting only makes a clamp cut
// earlier; it can never let a line render wider than its budget. (Genuinely
// East-Asian-Ambiguous characters OUTSIDE these ranges — ±, an en dash,
// Greek — count 1; a terminal font that renders those wide is beyond the
// clamp's scope. Catalog text is sanitized to a single line by
// sanitizeCatalogText, so width is the only wrap risk left.)
function charWidth(codePoint: number): number {
  // Variation selectors (VS1–VS16) are zero-width in reality. VS16 forces
  // emoji presentation on the preceding base, so the pair renders 2 columns:
  // counting the selector itself as 1 keeps any base+VS16 sequence at ≥ 2
  // even when the base is NOT in a wide block (⌨️ = U+2328+VS16), while a
  // wide base + VS16 overcounts by one — the safe direction.
  if (codePoint >= 0xfe00 && codePoint <= 0xfe0f) return 1
  if (
    (codePoint >= 0x1100 && codePoint <= 0x115f) || // Hangul Jamo
    (codePoint >= 0x2e80 && codePoint <= 0xa4cf) || // CJK radicals … Yi
    (codePoint >= 0xa960 && codePoint <= 0xa97f) || // Hangul Jamo Ext. A
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) || // Hangul syllables
    (codePoint >= 0xf900 && codePoint <= 0xfaff) || // CJK compat ideographs
    (codePoint >= 0xfe10 && codePoint <= 0xfe19) || // vertical forms
    (codePoint >= 0xfe30 && codePoint <= 0xfe6f) || // CJK compat forms
    (codePoint >= 0xff00 && codePoint <= 0xff60) || // fullwidth forms
    (codePoint >= 0xffe0 && codePoint <= 0xffe6) || // fullwidth signs
    (codePoint >= 0x2600 && codePoint <= 0x27bf) || // misc symbols + dingbats (☺ ✨ ⚠ — ambiguous, commonly 2 under emoji presentation)
    (codePoint >= 0x2b00 && codePoint <= 0x2bff) || // misc symbols and arrows (⭐)
    (codePoint >= 0x1f000 && codePoint <= 0x1faff) || // the SMP symbol planes: mahjong/cards, enclosed ideographs, pictographs, transport (🚀), supplemental, symbols ext-A
    (codePoint >= 0x20000 && codePoint <= 0x2fffd) || // CJK ext B+
    (codePoint >= 0x30000 && codePoint <= 0x3fffd) // CJK ext G+
  ) {
    return 2
  }
  return 1
}

// A string's terminal display width (the sum of its code points' widths).
// Exported for the unit rig, which asserts rendered lines against it.
export function strWidth(value: string): number {
  let width = 0
  for (const char of value) width += charWidth(char.codePointAt(0)!)
  return width
}

// One report entry's defensive normalization, shared by the two paths that
// carry report data across a trust boundary (the /model-compare command's
// event and the TUI's direct RPC call): an entry missing any identity field
// is dropped, every other field falls back to its neutral value.
function toReportEntries(raw: unknown): ReportEntry[] {
  if (!Array.isArray(raw)) return []
  return raw.flatMap((item): ReportEntry[] => {
    const entry = item as Partial<ReportEntry>
    if (
      typeof entry?.id !== "string" ||
      typeof entry?.value !== "string" ||
      typeof entry?.priority !== "string"
    )
      return []
    return [
      {
        priority: entry.priority as Priority,
        rank: typeof entry.rank === "number" ? entry.rank : null,
        // The F-20 split (see ReportEntry): `id` sanitized for display,
        // `value` the raw catalog id for switching.
        id: entry.id,
        value: entry.value,
        score: typeof entry.score === "string" ? entry.score : "-",
        quality: typeof entry.quality === "string" ? entry.quality : "-",
        effort: typeof entry.effort === "string" ? entry.effort : "",
        alternative: typeof entry.alternative === "string" ? entry.alternative : "",
        price: typeof entry.price === "string" ? entry.price : "-",
        current: entry.current === true,
        fromFallback: entry.fromFallback === true,
      },
    ]
  })
}

// The report payload's footer capture (the last-response line and the alt+e
// toast's data), defensively normalized at the trust boundary like the
// entries: anything but a well-shaped object — or one without an endpoint —
// degrades to null (no capture), never a placeholder line.
function toCapture(raw: unknown): { endpoint: string; model: string; downgrade: boolean } | null {
  if (typeof raw !== "object" || raw === null) return null
  const capture = raw as { endpoint?: unknown; model?: unknown; downgrade?: unknown }
  if (typeof capture.endpoint !== "string" || capture.endpoint === "") return null
  return {
    endpoint: capture.endpoint,
    // The Task-5 handoff: a capture may carry an empty model (a response
    // whose provider had no model id) — carried as-is, and the footer omits
    // the model part rather than rendering an empty slot.
    model: typeof capture.model === "string" ? capture.model : "",
    downgrade: capture.downgrade === true,
  }
}

// The footer's steering note, defensively normalized: anything but a
// non-empty string means the note does not render (no steering data).
function toSteeringNote(raw: unknown): string | null {
  return typeof raw === "string" && raw !== "" ? raw : null
}

export default Plugin.define({
  id: "model-compare-tui",
  async setup(context) {
    const location = context.location ?? context.data.location.default()
    const here = (location as { directory?: string } | undefined)?.directory

    const notify = (message: string, variant: "success" | "error" = "success") =>
      context.ui.toast.show({ title: "model-compare", message, variant, duration: TOAST_MS })

    // The terminal's size, reactive: the renderer emits "resize" carrying the
    // fresh dimensions, and the dialogs' row-area caps must track font-size
    // and window changes the way the host's own dialogs do (the palette caps
    // its list at a fraction of the viewport; the dialog layer gives plugin
    // dialogs no cap of their own). Detached in the returned cleanup.
    const [terminalSize, setTerminalSize] = createSignal({
      width: context.renderer.width,
      height: context.renderer.height,
    })
    const onRendererResize = (width: number, height: number) => {
      setTerminalSize({ width, height })
      // A resize re-caps the armed dialog's row area under its cursor: the
      // reveal re-runs on the next frame (see showListDialog's
      // revealOnFrame) or a shrunken viewport can leave the cursor below
      // the fold until the next key move.
      armedReveal?.(false)
    }
    context.renderer.on("resize", onRendererResize)

    let disposeRoot = () => {}
    // The three slot disposers (the two footers and the app slot below):
    // slots claimed but never released survive the plugin's unload and keep
    // rendering into a torn-down UI. Called from the returned cleanup.
    let disposePromptFooter = () => {}
    let disposeHomeFooter = () => {}
    let disposeAppSlot = () => {}
    let resyncTimer: ReturnType<typeof setInterval> | undefined
    // The report dialog's hand-off: the /model-compare event callback runs
    // ownerless (data.listen), and a dialog mounted from an ownerless
    // callback renders but its keyboard never attaches — the mount lands
    // outside the provider tree no matter how the call is wrapped. So the
    // callback only PARKS the data on this signal; the app slot below owns
    // an effect (created inside the tree) that opens the dialog when it
    // fires.
    const [pendingReport, setPendingReport] = createSignal<{
      sessionID: string
      age: string | null
      entries: ReportEntry[]
      capture: { endpoint: string; model: string; downgrade: boolean } | null
      steeringNote: string | null
    } | null>(null)

    // The registry view, reactive: OpenCode's data layer updates the list
    // when the runtime plugin's reloads commit, so the memo re-runs. Created
    // at setup scope (see the owner-discipline note above): the footers'
    // slots and the flip-watch effect below read it inside the root, and the
    // keymap layer's run() reads it outside — a memo works from both.
    const aliases = createMemo<AliasView[]>(() =>
      readAliasViews(
        (context.data.location.model.list(location) ?? []) as Array<{
          id?: unknown
          name?: unknown
          enabled?: unknown
          modelID?: unknown
        }>,
      ),
    )
    const line = createMemo(() => statusLine(aliases()))

    // The focused session: the router's current route when it is a session
    // route; null otherwise (home, dialogs). Defensive: the route's shape
    // is the host's, so every field is read guardedly.
    function currentSessionID(): string | null {
      const route = context.ui.router.current() as
        | { type?: unknown; sessionID?: unknown; data?: { sessionID?: unknown } }
        | undefined
      if (route === undefined || route === null) return null
      if (route.type !== undefined && route.type !== "session") return null
      if (typeof route.sessionID === "string") return route.sessionID
      if (typeof route.data?.sessionID === "string") return route.data.sessionID
      return null
    }

    // The runtime plugin's configured default priority, read through the
    // client's config API: the config documents carry `plugins[].options`.
    // Falls back to "balanced" when the option is absent or unreadable.
    async function readDefaultPriority(): Promise<"balanced" | "price" | "quality"> {
      try {
        const entries = await context.client.config.get()
        for (const entry of entries ?? []) {
          // ConfigEntry is a union; only document entries carry the config.
          if (entry.type !== "document") continue
          const plugins = (entry.info as { plugins?: unknown }).plugins
          if (!Array.isArray(plugins)) continue
          for (const plugin of plugins) {
            if (typeof plugin !== "object" || plugin === null) continue
            const record = plugin as { package?: unknown; options?: Record<string, unknown> }
            const pkg = typeof record.package === "string" ? record.package : ""
            if (!pkg.includes(PACKAGE_FRAGMENT)) continue
            const priority = record.options?.defaultPriority
            if (priority === "balanced" || priority === "price" || priority === "quality") {
              return priority
            }
          }
        }
      } catch {
        // Unreadable config: the default applies (§3 semantics).
      }
      return "balanced"
    }

    // Switch to one of the plugin's aliases — the shared decision chain
    // behind /use-best, the palette command and the picks dialog's
    // selection. With a session open it switches THAT session; with none
    // (the opening screen) it creates a session already bound to the alias
    // and opens it — the pick is the session's starting model. A disabled
    // alias refuses before anything is created.
    async function switchToPriority(priority: Priority): Promise<void> {
      const views = aliases()
      if (!views.some((view) => view.priority === priority && view.enabled)) {
        notify(useBestRefusal(priority), "error")
        return
      }
      const view = views.find((item) => item.priority === priority)
      const notice = useBestNotice(priority, view?.modelID ?? pickFromName(view?.name ?? ""))
      const sessionID = currentSessionID()
      if (sessionID === null) {
        await createSessionOnModel(
          { providerID: ALIAS_PROVIDER, id: aliasId(priority) },
          notice,
        )
        return
      }
      try {
        await context.client.session.switchModel({
          sessionID,
          model: { providerID: ALIAS_PROVIDER, id: aliasId(priority) },
        })
        notify(notice)
      } catch (error) {
        notify(`use-best failed: ${error instanceof Error ? error.message : String(error)}`, "error")
      }
    }

    // Switch the current session straight to a concrete model (the report
    // dialog's selection).
    async function switchToModel(sessionID: string, id: string, variant?: string): Promise<void> {
      try {
        await context.client.session.switchModel({
          sessionID,
          model: { providerID: ALIAS_PROVIDER, id, ...(variant === undefined ? {} : { variant }) },
        })
        // F-20: `id` here is the raw catalog id (the switch needs it) — the
        // toast shows the flattened form so it cannot be line-injected.
        notify(`switched to openrouter/${sanitizeCatalogText(id)}`)
      } catch (error) {
        notify(`switch failed: ${error instanceof Error ? error.message : String(error)}`, "error")
      }
    }

    // No session open (the opening screen's pick paths): create one already
    // bound to the given model and navigate into it. Returns whether the
    // session came up; a failure is toasted and nothing else happens — no
    // half-open session to clean up.
    async function createSessionOnModel(
      model: { providerID: string; id: string },
      success: string,
    ): Promise<boolean> {
      try {
        const session = await context.client.session.create({ model })
        context.ui.router.navigate({ type: "session", sessionID: session.id })
        notify(success)
        return true
      } catch (error) {
        notify(
          `could not open a session: ${error instanceof Error ? error.message : String(error)}`,
          "error",
        )
        return false
      }
    }

    // The custom list dialog. The host's `dialog.select` (SDK 2.0.16
    // runtime) renders one GROUPED box per category with one cursor each —
    // its search flattening (verified against main) does not exist in this
    // build — so three simultaneous cursors move independently. This
    // renderer replaces it: `dialog.show` + our own rows — one cursor,
    // palette styling (bold title, dim esc, theme action colors on the
    // selected row). The modal keymap layer cannot be registered from the
    // render closure (context-less — "Keymap.Provider is missing", the same
    // trap as setup scope), so the app slot's IN-TREE effect registers it
    // while `listKeys` is armed, and the host unmounts it with the dialog.

    // The keymap layer hand-off (see showListDialog): set while a list
    // dialog is open, cleared on close; the app slot's in-tree effect maps
    // it to a modal layer.
    const [listKeys, setListKeys] = createSignal<{
      move: (delta: number) => void
      pick: () => void
    } | null>(null)

    function showListDialog(
      title: string,
      rows: ListRow[],
      onPick: (row: ListRow & { value: string }) => void,
      // The footer's extra lines (the report dialog's steering note and
      // last-response line), rendered muted ABOVE the Details line. Absent
      // for the other dialogs (the picks dialog carries no footer lines).
      footerLines: string[] = [],
    ): void {
      const selectable = rows.filter((row) => row.value !== undefined)
      if (selectable.length === 0) {
        notify("nothing to select", "error")
        return
      }
      const initial = Math.max(
        0,
        selectable.findIndex((row) => row.selected !== undefined),
      )
      // The DIALOG surface: the exact theme call the host's own dialogs make
      // (dialog-select/dialog-alert) — uniform colors with the host chrome
      // and the palette's heading color.
      const theme = context.theme.surface("dialog")
      const base = theme.text.base
      const muted = theme.text.muted
      const accent = theme.hue.accent[200]
      const hiFg = theme.text.action.primary.focused
      const hiBg = theme.background.action.primary.focused
      // The native rows' inactive background: explicitly transparent, so the
      // dialog surface shows through.
      const transparent = RGBA.fromInts(0, 0, 0, 0)

      // This dialog's lifecycle token: its generation in the module-scope
      // counter. Replaced dialogs are closed first (below), so a close()
      // that finds a newer generation knows it lost ownership and must not
      // touch the armed dialog's shared state.
      armedClose?.()
      const generation = ++dialogGeneration

      let alive = true
      // The cursor as a SIGNAL: the JSX closure reads it reactively, so
      // every move repaints the dialog (a plain `let` painted once and
      // never updated — the cursor sat on row 1 however many times the
      // keymap moved the internal index; observed live, 2026-10-11).
      const [cursor, setCursor] = createSignal(initial)
      // The scrollbox that carries the rows (see the JSX below); its ref
      // lands when the host renders the dialog. The cursor's row is kept in
      // view with the native lists' look-ahead: the content scrolls as soon
      // as the cursor comes within three lines of an edge, and the cursor
      // only touches an edge line when the content ends (the scroll clamps
      // at its maximum).
      //
      // The row offsets are pure ARITHMETIC, not renderable geometry —
      // rowsHeight (module scope) is the ONE row-height rule the rows' JSX
      // and the row-area cap share. Reading the host's .y was tried and is
      // unreliable across the plugin boundary — it reported the scrollbox's
      // own position for every row — while scrollTop/scrollHeight/height
      // behave as plain numbers.
      let listScroll: ScrollBoxRenderable | undefined
      let pendingReveal: (() => void) | undefined
      const rowOffset = (index: number): number => rowsHeight(rows, index)
      const reveal = (center: boolean) => {
        const box = listScroll
        if (box === undefined) return
        const top = rowOffset(rows.indexOf(selectable[cursor()]))
        const max = Math.max(0, box.scrollHeight - box.height)
        // The look-ahead band, clamped to the window: at box.height <= 3 the
        // three-line margin degenerates to plain ensure-visible (the row
        // lands ON a window line instead of the overscroll an unclamped
        // `box.height - 4` produced once it went negative — cap values of
        // 1-3 are exactly what large font sizes reach).
        const band = Math.min(3, Math.max(0, box.height - 1))
        // Keep the row on-screen whatever the branch: the row's line must
        // stay within [scrollTop, scrollTop + box.height - 1].
        const visible = (target: number): number =>
          Math.min(top, Math.max(top - box.height + 1, target))
        let target = box.scrollTop
        if (center) target = top - Math.floor(box.height / 2)
        else if (top - box.scrollTop > box.height - 1 - band) target = visible(top - (box.height - 1 - band))
        else if (top - box.scrollTop < band) target = visible(top - band)
        box.scrollTo(Math.max(0, Math.min(target, max)))
      }
      // Positions exist only after a layout frame, so the reveal defers to
      // the next rendered frame (the palette's own once(FRAME) +
      // requestRender() pattern) rather than racing the renderer inside the
      // key handler.
      const revealOnFrame = (center: boolean) => {
        if (pendingReveal !== undefined) context.renderer.off("frame", pendingReveal)
        const run = () => {
          pendingReveal = undefined
          if (!alive) return
          reveal(center)
        }
        pendingReveal = run
        context.renderer.once("frame", run)
        context.renderer.requestRender()
      }
      const close = () => {
        if (!alive) return
        alive = false
        // A pending frame reveal is THIS dialog's alone: cancel it here or
        // the once("frame") listener (and its closure over the rows)
        // outlives the dialog — it self-guarded on `alive`, but leaked until
        // the next frame.
        if (pendingReveal !== undefined) {
          context.renderer.off("frame", pendingReveal)
          pendingReveal = undefined
        }
        // A newer dialog was armed since this one: its own close owns the
        // shared state (the keymap layer, the host dialog, the reveal hook)
        // now — clearing here would kill ITS keyboard and surface.
        if (generation !== dialogGeneration) return
        armedClose = null
        armedReveal = null
        setListKeys(null)
        context.ui.dialog.clear()
      }
      // move(±1) walks the SELECTABLE rows only; heading rows never take
      // the cursor. Wraps: one past the last is the first, one before the
      // first is the last (the command palette's behavior).
      const move = (delta: number) => {
        setCursor((cursor() + delta + selectable.length) % selectable.length)
        // Frame-deferred like every reveal — and it CANCELS a pending one,
        // so the preselected row's open-time centering can never land after
        // the user has already moved the cursor off it.
        revealOnFrame(false)
      }
      const pick = () => {
        const row = selectable[cursor()]
        close()
        onPick(row as ListRow & { value: string })
      }

      // Arm the modal layer via the app slot's in-tree effect (see the app
      // slot below); it registers on the next reactive run. This dialog is
      // now the armed one (the lifecycle token above).
      armedClose = close
      armedReveal = revealOnFrame
      setListKeys({ move, pick })

      context.ui.dialog.show(
        () => (
          // Top/bottom blanks follow the native boxes: 1 with a tip line at
          // the bottom (the host's dialog panel contributes the other top
          // blank, so our own top padding is 0).
          <box paddingTop={0} paddingBottom={1} gap={1}>
            <box paddingLeft={4} paddingRight={4} flexDirection="row" justifyContent="space-between">
              <text attributes={TextAttributes.BOLD} fg={base}>
                {title}
              </text>
              <text fg={muted} onMouseUp={() => close()}>
                esc
              </text>
            </box>
            <scrollbox
              ref={(element) => {
                listScroll = element
                // The report's preselected row (the current pick) opens
                // centered in the scrollbox: scheduled from the ref, so the
                // frame it waits for is the one that lays these rows out.
                if (initial > 0) revealOnFrame(true)
              }}
              maxHeight={cappedRowsHeight(rowsHeight(rows), terminalSize().height)}
              paddingLeft={1}
              paddingRight={1}
              scrollbarOptions={{ visible: false }}
            >
              {(() => {
                let headings = 0
                return rows.map((row) => {
                  if (row.headerLine !== undefined) {
                    // The table's column header: dim, cursor-skipped, and
                    // directly above the first section (no blank line).
                    return <text fg={muted}>{row.headerLine}</text>
                  }
                  if (row.heading !== undefined) {
                    // The palette's heading recipe: accent hue, bold, one
                    // blank line above every heading but the first — the
                    // blank is rowLines' call (the ONE row-height rule the
                    // offsets and the cap share), not a second copy of its
                    // condition. Flush with the title: 1 (list inset) + 3 = 4.
                    const paddingTop = rowLines(row, headings) - 1
                    headings += 1
                    return (
                      <box paddingTop={paddingTop} paddingLeft={3}>
                        <text fg={accent} attributes={TextAttributes.BOLD}>
                          {row.heading}
                        </text>
                      </box>
                    )
                  }
                  const active = row.value !== undefined && selectable[cursor()] === row
                  // The row BOX carries the background: it stretches the
                  // list's full width, so the cursor is "justified" — from
                  // the 1-blank left inset to the 1-blank right inset —
                  // while the text stays at the content indent (4).
                  const nameFg = row.dim === true ? muted : active ? hiFg : base
                  return (
                    <box
                      flexDirection="row"
                      paddingLeft={3}
                      paddingRight={3}
                      backgroundColor={active ? hiBg : transparent}
                    >
                      {row.columns !== undefined ? (
                        <text>
                          <span style={{ fg: nameFg }}>
                            {active && row.dim !== true ? <b>{row.label}</b> : row.label}
                          </span>
                          <span style={{ fg: row.dim === true || !active ? muted : hiFg }}>
                            {row.columns}
                          </span>
                        </text>
                      ) : (
                        <text
                          fg={nameFg}
                          attributes={active && row.dim !== true ? TextAttributes.BOLD : undefined}
                        >
                          {row.label}
                        </text>
                      )}
                    </box>
                  )
                })
              })()}
            </scrollbox>
            {(() => {
              const row = selectable[cursor()]
              return row.status === undefined ? null : (
                <box paddingLeft={4}>
                  <text fg={muted}>{row.status}</text>
                </box>
              )
            })()}
            {footerLines.map((line) => (
              <box paddingLeft={4}>
                <text fg={muted}>{line}</text>
              </box>
            ))}
            <box paddingLeft={4}>
              <text fg={muted}>Details: https://model-compare.dev</text>
            </box>
          </box>
        ),
        close,
      )
      // The palette's presentation: vertically centered at the medium width.
      // The size/centered state persists across dialogs (the host's own set
      // it on every open), so the explicit set also clears a stale xlarge a
      // host dialog may have left behind.
      context.ui.dialog.set({ size: "medium", centered: true })
    }

    // The picks dialog: the three priorities, one cursor, palette styling.
    // A snapshot at open time; unavailable priorities are dimmed — the
    // cursor still reaches them, and choosing one is refused with a toast
    // (switchToPriority's guard). Choosing an available priority switches
    // the session to it — or, with no session open, creates one bound to
    // it (the opening screen's path; opening the dialog never does).
    function showPicksDialog(): void {
      const views = aliases()
      const rows: ListRow[] = PRIORITIES.map((priority) => {
        const view = views.find((item) => item.priority === priority)
        const enabled = view !== undefined && view.enabled !== false
        return {
          label: `${alignedPriority(priority)} → ${enabled ? (pickOf(view!) ?? "unavailable") : "disabled"}`,
          value: priority,
          dim: !enabled,
        }
      })
      showListDialog("Model Compare — current picks", rows, (row) => {
        void switchToPriority(row.value as Priority)
      })
    }

    // The report dialog: the ranked entries under bold-ish priority
    // headings (palette category color, blank line above each — headings
    // are skipped by the cursor), one cursor over all of them; choosing a
    // model switches straight to it. Empty entries mean the command had no
    // ranking data.
    function showReportDialog(data: {
      // The session the report belongs to — null when the dialog was opened
      // with no session (the opening screen's direct-RPC path); a pick then
      // creates a session bound to the chosen model instead of switching.
      sessionID: string | null
      age: string | null
      entries: ReportEntry[]
      // The footer (design §Steering visibility, the user's option C): the
      // steering note above the last-response line, both omitted when their
      // data is absent — never a placeholder.
      capture: { endpoint: string; model: string; downgrade: boolean } | null
      steeringNote: string | null
    }): void {
      if (data.entries.length === 0) {
        notify("no ranking data available yet", "error")
        return
      }
      // The approved table now carries three columns: model name, quality
      // and price. The scored variant (the catalog's effort) moved into a
      // cursor-following status line below the list (see ListRow.status), so
      // the table stays readable. No score
      // column — the transcript's text report keeps it. Column widths are clamped
      // (qual ≤ 5, $ in/out ≤ 13) and oversized cells are truncated to their
      // clamped width, so with the name clamp below the row budget holds
      // even for hostile/absurd column strings: what the clamp guarantees is
      // that a row and the header stay within the dialog's fixed 52-char
      // content width (hostile values get truncated rather than pushed into
      // wrapping — the 40-char rankless fallback label did exactly that
      // before the name clamp).
      const labels = data.entries.map(
        (entry) =>
          `${entry.rank === null ? "·" : entry.rank}. ${entry.id}${
            entry.fromFallback ? " (fallback)" : ""
          }`,
      )
      const labelOf = new Map(data.entries.map((entry, index) => [entry, labels[index]]))
      const colW = (values: string[], floor: number, cap: number): number =>
        Math.min(cap, Math.max(floor, ...values.map(strWidth)))
      // Quality is a one-decimal AA index (max "100.0"); the caps leave the
      // 52-char row budget intact (see `fixed` below) while fitting real
      // values: "10.00/100.00" (price).
      const qualW = colW(data.entries.map((entry) => entry.quality), "qual".length, 5)
      // The status line's variant cell keeps its 7-column clamp: the status
      // box is a direct child of the 60-wide dialog with only its own 4-char
      // left inset, so one text line has 56 columns — the worst case, 9
      // ("variant: ") + 7 = 16, leaves ample slack. Clamping the cell (in
      // display columns, see cell) keeps hostile catalog strings from
      // wrapping.
      const effortW = 7
      const priceW = colW(data.entries.map((entry) => entry.price), "$ in/out".length, 13)
      // A cell wider than its clamped column is truncated to fit — measured
      // in terminal COLUMNS (strWidth), not string length: a 7-code-point
      // CJK effort label renders 14 columns wide and would push the row
      // past its budget if length were the measure.
      const cell = (value: string, width: number): string => {
        if (strWidth(value) <= width) return value
        // Reserve one column for the ellipsis; walk whole code points so a
        // wide char is never cut in half.
        let used = 0
        let out = ""
        for (const char of value) {
          const w = charWidth(char.codePointAt(0)!)
          if (used + w > width - 1) break
          out += char
          used += w
        }
        return `${out}…`
      }
      // The pads match cell's measure, so a truncated wide cell and its
      // padding land on the same column arithmetic (padEnd keeps the
      // prices' flush right edges — see below).
      const padEndW = (value: string, width: number): string =>
        value + " ".repeat(Math.max(0, width - strWidth(value)))
      const padStartW = (value: string, width: number): string =>
        " ".repeat(Math.max(0, width - strWidth(value))) + value
      // Prices use padEnd (not padStart): padded to a common width the
      // right edges stay flush while the fixed 2-space gap between columns
      // stays exactly 2 (padStart pushed each value right by its slack).
      // The default dialog is 60 wide: 2 list insets + 6 row insets leave 52
      // for row content; the header shares that budget (plus its 3-indent).
      // Column caps keep the budget even for hostile strings: 5+13 plus the
      // two 2-char paddings and the 2-char row indent = 24, leaving plenty
      // for the name (the name column shrinks first for real content).
      const fixed = 2 + qualW + 2 + priceW
      const nameW = Math.max(6, Math.min(52 - fixed, Math.max(...labels.map(strWidth))))
      const trim = (label: string): string => cell(label, nameW)
      const headerLine =
        "   " +
        " ".repeat(nameW) +
        "  " +
        "qual".padStart(qualW) +
        "  " +
        "$ in/out".padEnd(priceW)
      // Catalog v6 calls this the effort the quality was measured at: the
      // best measured selectable depth, so there is no higher selectable
      // alternative to advertise. The alternative label survives only in the
      // /model-compare text report, for an explicit-effort v6 document served
      // by a user-pointed catalogURL. OpenCode calls the selectable option a
      // VARIANT, so the TUI says "variant" to match the model picker. An
      // unscored model's missing effort renders as "-".
      const statusOf = (entry: ReportEntry): string =>
        `variant: ${cell(entry.effort || "-", effortW)}`
      const rows: ListRow[] = [{ label: "", headerLine }]
      for (const priority of PRIORITIES) {
        const section = data.entries.filter((entry) => entry.priority === priority)
        if (section.length === 0) continue
        rows.push({ heading: priority, label: "" })
        for (const entry of section) {
          rows.push({
            label: padEndW(trim(labelOf.get(entry) ?? ""), nameW),
            columns:
              "  " +
              padStartW(cell(entry.quality, qualW), qualW) +
              "  " +
              padEndW(cell(entry.price, priceW), priceW),
            status: statusOf(entry),
            // F-20 id split: the row DISPLAYS the sanitized id (in `label`)
            // but picks `value`, the raw catalog id switchToModel needs. The
            // variant is the gateway-valid effort the status line advertises;
            // a blank effort and the catalog's "reasoning" sentinel are not
            // OpenCode variants.
            value: entry.value,
            variant: gatewayEffort(entry.effort) ?? undefined,
            selected: entry.current ? entry.value : undefined,
          })
        }
      }
      // The report dialog's footer (design §Decisions, option C): the
      // steering note ABOVE the last-response line, both omitted when their
      // data is absent — never a placeholder line.
      const footerLines: string[] = []
      if (data.steeringNote !== null) footerLines.push(data.steeringNote)
      const lastResponse = lastResponseLine(data.capture)
      if (lastResponse !== null) footerLines.push(lastResponse)
      showListDialog(
        `Model Compare — top 5 (data age: ${data.age ?? "unknown"})`,
        rows,
        (row) => {
          const sessionID = data.sessionID
          if (sessionID !== null) {
            void switchToModel(sessionID, row.value, row.variant)
            return
          }
          // The opening screen: the pick becomes a NEW session's model —
          // the same concrete model AND variant the in-session path
          // switches to.
          void createSessionOnModel(
            {
              providerID: ALIAS_PROVIDER,
              id: row.value,
              ...(row.variant === undefined ? {} : { variant: row.variant }),
            },
            `switched to openrouter/${sanitizeCatalogText(row.value)}`,
          )
        },
        footerLines,
      )
    }

    // The report dialog rides the /model-compare command's RPC event: ONE
    // command serves both worlds — headless gets the transcript notice, the
    // TUI gets this instant selectable dialog. Filtered to this plugin's
    // location and the currently viewed session, so a headless run's report
    // never pops a dialog over an unrelated session.
    const offReportEvent = context.data.listen(({ details }) => {
      const event = details as {
        type?: unknown
        location?: { directory?: unknown }
        data?: {
          sessionID?: unknown
          age?: unknown
          entries?: unknown
          capture?: unknown
          steeringNote?: unknown
        }
      }
      if (event.type !== REPORT_EVENT) return
      if (
        typeof event.location?.directory === "string" &&
        here !== undefined &&
        event.location.directory !== here
      )
        return
      const data = event.data
      if (typeof data?.sessionID !== "string" || data.sessionID !== currentSessionID()) return
      if (!Array.isArray(data.entries)) return
      const entries = toReportEntries(data.entries)
      const eventSessionID = data.sessionID
      // Ownerless callback: park the report on the signal — the app slot's
      // in-tree effect opens the dialog (see pendingReport above). The
      // footer's fields ride the payload like the entries (defensively
      // normalized at this trust boundary).
      setPendingReport({
        sessionID: eventSessionID,
        age: typeof data.age === "string" ? data.age : null,
        entries,
        capture: toCapture(data.capture),
        steeringNote: toSteeringNote(data.steeringNote),
      })
    })

    // The cannot-steer fallback (Task 6): the runtime hook emits this event
    // once per session when a steerable alias request finds no steering data
    // (no catalog source). The TUI surfaces it as a toast with the exact
    // fallback copy; headless shows nothing — like every TUI-coupled surface.
    // Scoped exactly like the report listener: a foreign directory's session
    // is never viewable here, and only the CURRENTLY viewed session toasts.
    // Trade-off: a cannotSteer notice for a same-project background session
    // (or a session the user isn't currently viewing) is dropped forever —
    // the emit is once-per-session — but noise from unopened sessions is the
    // worse failure; the notice is about the session the user interacts with.
    const offCannotSteerEvent = context.data.listen(({ details }) => {
      const event = details as {
        type?: unknown
        location?: { directory?: unknown }
        data?: { sessionID?: unknown }
      }
      if (event.type !== CANNOT_STEER_EVENT) return
      if (
        typeof event.location?.directory === "string" &&
        here !== undefined &&
        event.location.directory !== here
      )
        return
      const data = event.data
      if (typeof data?.sessionID !== "string" || data.sessionID !== currentSessionID()) return
      notify(CANNOT_STEER_COPY)
    })

    createRoot((dispose) => {
      disposeRoot = dispose

      // Keep the data layer fresh: a belt-and-braces re-sync, since the
      // registry also updates reactively. Cleared on unload below.
      void context.data.location.model.sync(location)
      resyncTimer = setInterval(() => {
        void context.data.location.model.sync(location).catch(() => {})
      }, RESYNC_MS)

      // The status line in both footers, in the theme's text color (read
      // inside the render, so a theme switch re-renders).
      disposePromptFooter = context.ui.slot({
        append: "prompt.footer.status",
        render: () => <StatusLine line={line} fg={context.theme.text.base} />,
      })
      disposeHomeFooter = context.ui.slot({
        append: "home.footer.status",
        render: () => <StatusLine line={line} fg={context.theme.text.base} />,
      })

      // Toast when a pick flips. A real per-priority diff over the pick ids
      // — the previous pick string or null per priority — so only the
      // priorities whose pick ACTUALLY changed toast: a "(fallback)"
      // name-marker change with the same pick is not a flip, and going
      // disabled (enabled→disabled, pick → null) is never toasted. The first
      // observation after load only seeds the map (a load is not a change);
      // when several flips land in one reload, each changed priority gets
      // its own toast.
      const previousPicks = new Map<Priority, string | null>()
      createEffect(() => {
        const byPriority = new Map<Priority, AliasView>(
          aliases().map((view) => [view.priority, view]),
        )
        for (const p of PRIORITIES) {
          const view = byPriority.get(p)
          // The pick IDENTITY: the "(fallback)" marker is a name decoration,
          // not part of the pick — compare and toast without it. No
          // observable pick (disabled, or a name with no arrow and no
          // modelID) reads as null.
          const pick =
            view === undefined || view.enabled === false
              ? null
              : ((view.modelID ?? pickFromName(view.name))?.replace(/ \(fallback\)$/, "") ?? null)
          const seen = previousPicks.has(p)
          const before = previousPicks.get(p) ?? null
          previousPicks.set(p, pick)
          if (!seen || pick === null || pick === before) continue
          // F-20: the pick is catalog-derived — flattened for the toast.
          notify(`Model Compare: ${p} → ${sanitizeCatalogText(pick)}`)
        }
      })
    })

    // The keymap layers. They CANNOT be registered from setup's scope: the
    // host's layer bridge wraps registration in a createRoot attached to the
    // calling owner, and Solid context does not flow through a created root
    // — `Keymap.createLayer`'s context lookup fails ("Keymap.Provider is
    // missing") whether the call sits inside our own createRoot (v1, the
    // failed load) or at setup scope (v2, silently swallowed: plugin console
    // output reaches no log). The documented pattern is an "app" slot whose
    // render registers the layers — the render runs INSIDE the mounted
    // provider tree, mounts once, and lives for the whole TUI session. Each
    // layer registers in its own try/catch whose failure surfaces as a
    // toast: a registration failure must be visible, and one layer's failure
    // must not take the others down.
    const layerFailure = (what: string, error: unknown) => {
      notify(`${what} failed to register: ${error instanceof Error ? error.message : String(error)}`, "error")
    }

    // The picks dialog's command. No slash: /use-best already covers the
    // switching surface (the server command is slash-routable; the TUI's
    // duplicate of it was removed for exactly that reason). The dialog opens
    // everywhere — with no session it shows the current picks, and only
    // picking one creates a session bound to it (switchToPriority).
    const picksCommand: KeymapCommand = {
      id: "model-compare.picks",
      title: "Model-compare top picks",
      group: "Model Compare",
      bind: "alt+m",
      palette: true,
      run: () => showPicksDialog(),
    }

    // The report command: with a session open it posts the server's
    // /model-compare command, whose RPC event opens the selectable report
    // dialog here (and the transcript keeps the notice). With no session
    // (the opening screen) there is nothing to post to, so the report is
    // fetched straight from the plugin's report RPC — same builder, same
    // entries — and picking a model creates a session bound to it (there is
    // no composer-model setter to change instead; verified against the
    // pinned runtime). The refusal-free opening also keeps the footer's
    // status line honest: the shortcuts always DO something.
    const reportCommand: KeymapCommand = {
      id: "model-compare.report",
      title: "Model-compare report",
      group: "Model Compare",
      bind: "alt+shift+m",
      palette: true,
      run: async () => {
        const sessionID = currentSessionID()
        if (sessionID !== null) {
          try {
            await context.client.session.command({ sessionID, name: "model-compare", text: "" })
          } catch (error) {
            notify(`report failed: ${error instanceof Error ? error.message : String(error)}`, "error")
          }
          return
        }
        try {
          const report: unknown = await context.client.rpc(ModelCompare).report(
            {},
            here === undefined ? undefined : { location: { directory: here } },
          )
          const data = report as
            | { age?: unknown; entries?: unknown; capture?: unknown; steeringNote?: unknown }
            | undefined
          showReportDialog({
            sessionID: null,
            age: typeof data?.age === "string" ? data.age : null,
            entries: toReportEntries(data?.entries),
            capture: toCapture(data?.capture),
            steeringNote: toSteeringNote(data?.steeringNote),
          })
        } catch (error) {
          notify(`report failed: ${error instanceof Error ? error.message : String(error)}`, "error")
        }
      },
    }

    // The served-endpoint toast (design §Steering visibility): alt+e toasts
    // the CURRENT session's last response's served endpoint, looked up
    // through the report RPC's footer fields (the capture record rides the
    // established report payload path). The copy is exact — normal:
    // "last response served by <endpoint>"; downgrade (the served provider
    // matched none of the applied steering order): "! served by <endpoint> —
    // not in steering order"; nothing toasts when nothing was captured for
    // the session (and with no session open there is nothing to look up).
    const endpointCommand: KeymapCommand = {
      id: "model-compare.endpoint",
      title: "Last served endpoint",
      group: "Model Compare",
      bind: "alt+e",
      palette: true,
      run: async () => {
        const sessionID = currentSessionID()
        if (sessionID === null) return
        try {
          const report: unknown = await context.client.rpc(ModelCompare).report(
            { sessionID },
            here === undefined ? undefined : { location: { directory: here } },
          )
          const capture = toCapture((report as { capture?: unknown } | undefined)?.capture)
          if (capture === null) return
          // F-20: the endpoint is response data — flattened for the toast.
          notify(
            capture.downgrade
              ? `! served by ${sanitizeCatalogText(capture.endpoint)} — not in steering order`
              : `last response served by ${sanitizeCatalogText(capture.endpoint)}`,
          )
        } catch (error) {
          notify(
            `endpoint lookup failed: ${error instanceof Error ? error.message : String(error)}`,
            "error",
          )
        }
      },
    }

    // The palette-only use-best: the immediate-toast variant. The SLASH
    // surface is left to the server command (one entry everywhere); the
    // palette is TUI-layer territory, where this variant's instant feedback
    // lives.
    const useBestCommand: KeymapCommand = {
      id: "model-compare.use-best",
      title: "Use best model",
      group: "Model Compare",
      palette: true,
      run: async (input: string | undefined) => {
        const decision = useBestDecision({
          argument: input ?? "",
          defaultPriority: await readDefaultPriority(),
          enabled: (p) => aliases().some((view) => view.priority === p && view.enabled),
        })
        if (!decision.ok) {
          notify(decision.message, "error")
          return
        }
        await switchToPriority(decision.priority)
      },
    }

    disposeAppSlot = context.ui.slot({
      append: "app",
      render: () => {
        // The in-tree effect that opens the report dialog when the
        // /model-compare event parks data on pendingReport (see the signal
        // above): dialogs mounted from inside the tree get their keyboard;
        // ownerless mounts do not (observed live, 2026-10-11).
        createEffect(() => {
          const pending = pendingReport()
          if (pending === null) return
          setPendingReport(null)
          showReportDialog(pending)
        })
        // The list dialogs' modal keymap layer (see showListDialog):
        // registered HERE, inside the tree, while a list dialog is open —
        // the render closure is context-less, so registration from there
        // throws "Keymap.Provider is missing" (observed live 2026-10-11).
        createEffect(() => {
          const keys = listKeys()
          try {
            if (keys === null) return
            context.keymap.layer(() => ({
              mode: "modal",
              commands: [
                {
                  id: "model-compare.list.down",
                  title: "Next row",
                  group: "Dialog",
                  bind: "down",
                  run: () => keys.move(1),
                },
                {
                  id: "model-compare.list.up",
                  title: "Previous row",
                  group: "Dialog",
                  bind: "up",
                  run: () => keys.move(-1),
                },
                {
                  id: "model-compare.list.pick",
                  title: "Select",
                  group: "Dialog",
                  bind: "return",
                  run: () => keys.pick(),
                },
              ],
            }))
          } catch (error) {
            setListKeys(null)
            layerFailure("the list dialog keymap layer", error)
          }
        })
        // The event callbacks (data.listen) run ownerless; the layer
        // registration below carries its own failure toast.
        try {
          context.keymap.layer(() => ({
            mode: "global",
            commands: [useBestCommand, picksCommand, reportCommand, endpointCommand],
          }))
        } catch (error) {
          layerFailure("the model-compare keymap layer", error)
        }
        return null
      },
    })

    return () => {
      // Disarm whatever dialog is still armed FIRST: its pending frame
      // reveal and modal keyboard must not outlive the plugin (the
      // module-scope armedClose/armedReveal survive setup's cleanup
      // otherwise).
      armedClose?.()
      if (resyncTimer !== undefined) clearInterval(resyncTimer)
      context.renderer.off("resize", onRendererResize)
      offReportEvent()
      offCannotSteerEvent()
      disposeRoot()
      disposeAppSlot()
      disposeHomeFooter()
      disposePromptFooter()
    }
  },
})

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
//     as the server command;
//   * the report dialog (alt+shift+m): the /model-compare command emits its
//     structured report as an RPC event, and this half opens it as a
//     selectable dialog (selecting a ranked model switches straight to it) —
//     one command serves both worlds, so no TUI duplicate of the server
//     command exists;
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
import { TextAttributes, RGBA } from "@opentui/core"
// The OpenTUI JSX element types (<text fg>, <box>): a type-only import loads
// the package's solid-js JSX augmentation without a runtime import — the TUI
// host already provides the runtime side.
import type { JSX } from "@opentui/solid"
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
import { sanitizeCatalogText } from "./opencode/commands"

const TOAST_MS = 6_000
const RESYNC_MS = 30_000

// The plugin package name fragment this entry shares state with: the config
// lookup matches `plugins[].package` entries against it to read the runtime
// plugin's options (defaultPriority) through the client's config API.
const PACKAGE_FRAGMENT = "model-compare-opencode-plugin"
// The RPC event the /model-compare command emits (see src/rpc.ts; the wire
// name is prefixed with the RPC's id).
const REPORT_EVENT = "rpc.model-compare.report"

// The list dialogs' lifecycle token (see showListDialog): a module-scope
// generation counter, bumped every time a dialog is armed, plus the armed
// dialog's close. A dialog's close() tears down the shared state (the modal
// keymap layer, the host dialog) only while that dialog is STILL the armed
// one — a stale close must not clear a newer dialog's keyboard and surface —
// and arming a new dialog closes whatever is still armed first.
let dialogGeneration = 0
let armedClose: (() => void) | null = null

function StatusLine(props: { line: () => string; fg?: string }) {
  return <text fg={props.fg}>{props.line()}</text>
}

export default Plugin.define({
  id: "model-compare-tui",
  async setup(context) {
    const location = context.location ?? context.data.location.default()
    const here = (location as { directory?: string } | undefined)?.directory

    const notify = (message: string, variant: "success" | "error" = "success") =>
      context.ui.toast.show({ title: "model-compare", message, variant, duration: TOAST_MS })

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

    // Switch the current session to one of the plugin's aliases — the shared
    // decision chain behind /use-best, the palette command and the picks
    // dialog's selection.
    async function switchToPriority(priority: Priority): Promise<void> {
      const sessionID = currentSessionID()
      if (sessionID === null) {
        notify("Open a session first", "error")
        return
      }
      try {
        const views = aliases()
        if (!views.some((view) => view.priority === priority && view.enabled)) {
          notify(useBestRefusal(priority), "error")
          return
        }
        await context.client.session.switchModel({
          sessionID,
          model: { providerID: ALIAS_PROVIDER, id: aliasId(priority) },
        })
        const view = views.find((item) => item.priority === priority)
        notify(useBestNotice(priority, view?.modelID ?? pickFromName(view?.name ?? "")))
      } catch (error) {
        notify(`use-best failed: ${error instanceof Error ? error.message : String(error)}`, "error")
      }
    }

    // Switch the current session straight to a concrete model (the report
    // dialog's selection).
    async function switchToModel(sessionID: string, id: string): Promise<void> {
      try {
        await context.client.session.switchModel({
          sessionID,
          model: { providerID: ALIAS_PROVIDER, id },
        })
        // F-20: `id` here is the raw catalog id (the switch needs it) — the
        // toast shows the flattened form so it cannot be line-injected.
        notify(`switched to openrouter/${sanitizeCatalogText(id)}`)
      } catch (error) {
        notify(`switch failed: ${error instanceof Error ? error.message : String(error)}`, "error")
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
      selected?: string
      value?: string
      dim?: boolean
    }

    // The keymap layer hand-off (see showListDialog): set while a list
    // dialog is open, cleared on close; the app slot's in-tree effect maps
    // it to a modal layer.
    const [listKeys, setListKeys] = createSignal<{
      move: (delta: number) => void
      pick: () => void
    } | null>(null)

    function showListDialog(title: string, rows: ListRow[], onPick: (value: string) => void): void {
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
      const close = () => {
        if (!alive) return
        alive = false
        // A newer dialog was armed since this one: its own close owns the
        // shared state (the keymap layer, the host dialog) now — clearing
        // here would kill ITS keyboard and surface.
        if (generation !== dialogGeneration) return
        armedClose = null
        setListKeys(null)
        context.ui.dialog.clear()
      }
      // move(±1) walks the SELECTABLE rows only; heading rows never take
      // the cursor. Wraps: one past the last is the first, one before the
      // first is the last (the command palette's behavior).
      const move = (delta: number) => {
        setCursor((cursor() + delta + selectable.length) % selectable.length)
      }
      const pick = () => {
        const row = selectable[cursor()]
        close()
        onPick(row.value!)
      }

      // Arm the modal layer via the app slot's in-tree effect (see the app
      // slot below); it registers on the next reactive run. This dialog is
      // now the armed one (the lifecycle token above).
      armedClose = close
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
            <box paddingLeft={1} paddingRight={1} flexDirection="column">
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
                    // blank line above every heading but the first. Flush
                    // with the title: 1 (list inset) + 3 = 4.
                    headings += 1
                    return (
                      <box paddingTop={headings > 1 ? 1 : 0} paddingLeft={3}>
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
            </box>
            <box paddingLeft={4}>
              <text fg={muted}>Details: https://canonical.github.io/model-compare</text>
            </box>
          </box>
        ),
        close,
      )
    }

    // The picks dialog: the three priorities, one cursor, palette styling.
    // A snapshot at open time; unavailable priorities are dimmed — the
    // cursor still reaches them, and choosing one is refused with a toast
    // (switchToPriority's guard). Choosing an available priority switches
    // the session to it.
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
      showListDialog("Model Compare — current picks", rows, (priority) => {
        void switchToPriority(priority as Priority)
      })
    }

    // The report dialog: the ranked entries under bold-ish priority
    // headings (palette category color, blank line above each — headings
    // are skipped by the cursor), one cursor over all of them; choosing a
    // model switches straight to it. Empty entries mean the command had no
    // ranking data.
    function showReportDialog(data: {
      sessionID: string
      age: string | null
      entries: ReportEntry[]
    }): void {
      if (data.entries.length === 0) {
        notify("no ranking data available yet", "error")
        return
      }
      // The approved table: one dim column header at the top (directly above
      // the first section), section headings with a blank line above all but
      // the first, and right-justified quality/price columns. No score
      // column — the transcript's text report keeps it. Column widths are
      // clamped (qual ≤ 8, $ in/out ≤ 16) and oversized cells are truncated
      // to their clamped width, so with the name clamp below the row budget
      // holds even for hostile/absurd column strings: what the clamp
      // guarantees is that a row and the header stay within the dialog's
      // fixed 52-char content width (hostile values get truncated rather
      // than pushed into wrapping — the 40-char rankless fallback label did
      // exactly that before the name clamp).
      const labels = data.entries.map(
        (entry) =>
          `${entry.rank === null ? "·" : entry.rank}. ${entry.id}${
            entry.fromFallback ? " (fallback)" : ""
          }`,
      )
      const labelOf = new Map(data.entries.map((entry, index) => [entry, labels[index]]))
      const colW = (values: string[], floor: number, cap: number): number =>
        Math.min(cap, Math.max(floor, ...values.map((value) => value.length)))
      const qualW = colW(data.entries.map((entry) => entry.quality), "qual".length, 8)
      const priceW = colW(data.entries.map((entry) => entry.price), "$ in/out".length, 16)
      // A cell wider than its clamped column is truncated to fit.
      const cell = (value: string, width: number): string =>
        value.length > width ? value.slice(0, width - 1) + "…" : value
      // Prices use padEnd (not padStart): padded to a common width the
      // right edges stay flush while the fixed 2-space gap between columns
      // stays exactly 2 (padStart pushed each value right by its slack).
      // The default dialog is 60 wide: 2 list insets + 6 row insets leave 52
      // for row content; the header shares that budget (plus its 3-indent).
      const fixed = 2 + qualW + 2 + priceW
      const nameW = Math.max(8, Math.min(52 - fixed, Math.max(...labels.map((label) => label.length))))
      const trim = (label: string): string =>
        label.length > nameW ? label.slice(0, nameW - 1) + "…" : label
      const headerLine =
        "   " +
        " ".repeat(nameW) +
        "  " +
        "qual".padStart(qualW) +
        "  " +
        "$ in/out".padEnd(priceW)
      const rows: ListRow[] = [{ label: "", headerLine }]
      for (const priority of PRIORITIES) {
        const section = data.entries.filter((entry) => entry.priority === priority)
        if (section.length === 0) continue
        rows.push({ heading: priority, label: "" })
        for (const entry of section) {
          rows.push({
            label: trim(labelOf.get(entry) ?? "").padEnd(nameW),
            columns:
              "  " +
              cell(entry.quality, qualW).padStart(qualW) +
              "  " +
              cell(entry.price, priceW).padEnd(priceW),
            // F-20 id split: the row DISPLAYS the sanitized id (in `label`)
            // but picks `value`, the raw catalog id switchToModel needs.
            value: entry.value,
            selected: entry.current ? entry.value : undefined,
          })
        }
      }
      showListDialog(
        `Model Compare — top 5 (data age: ${data.age ?? "unknown"})`,
        rows,
        (id) => void switchToModel(data.sessionID, id),
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
        data?: { sessionID?: unknown; age?: unknown; entries?: unknown }
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
      const entries = data.entries.flatMap((raw): ReportEntry[] => {
        const entry = raw as Partial<ReportEntry>
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
            price: typeof entry.price === "string" ? entry.price : "-",
            current: entry.current === true,
            fromFallback: entry.fromFallback === true,
          },
        ]
      })
      const eventSessionID = data.sessionID
      // Ownerless callback: park the report on the signal — the app slot's
      // in-tree effect opens the dialog (see pendingReport above).
      setPendingReport({
        sessionID: eventSessionID,
        age: typeof data.age === "string" ? data.age : null,
        entries,
      })
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
    // duplicate of it was removed for exactly that reason).
    const picksCommand: KeymapCommand = {
      id: "model-compare.picks",
      title: "Model-compare top picks",
      group: "Model Compare",
      bind: "alt+m",
      palette: true,
      run: () => {
        if (currentSessionID() === null) {
          notify("no session yet — submit any prompt to create one; picking a priority switches that session", "error")
          return
        }
        showPicksDialog()
      },
    }

    // The report command: posts the server's /model-compare command, whose
    // RPC event opens the selectable report dialog here (and the transcript
    // keeps the notice). A session is required: the dialog's whole point is
    // switching a session's model, and with no session open there is
    // nothing to switch — the pinned runtime (2.0.16) exposes no composer-
    // model setter to plugins, so there is nothing to change either. The
    // refusal says why and how.
    const reportCommand: KeymapCommand = {
      id: "model-compare.report",
      title: "Model-compare report",
      group: "Model Compare",
      bind: "alt+shift+m",
      palette: true,
      run: async () => {
        const sessionID = currentSessionID()
        if (sessionID === null) {
          notify("no session yet — submit any prompt to create one; a report pick switches that session", "error")
          return
        }
        try {
          await context.client.session.command({ sessionID, name: "model-compare", text: "" })
        } catch (error) {
          notify(`report failed: ${error instanceof Error ? error.message : String(error)}`, "error")
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
            commands: [useBestCommand, picksCommand, reportCommand],
          }))
        } catch (error) {
          layerFailure("the model-compare keymap layer", error)
        }
        return null
      },
    })

    return () => {
      if (resyncTimer !== undefined) clearInterval(resyncTimer)
      offReportEvent()
      disposeRoot()
      disposeAppSlot()
      disposeHomeFooter()
      disposePromptFooter()
    }
  },
})

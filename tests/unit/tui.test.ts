// tests/unit/tui.test.ts
// The TUI half's shortcuts (design §10; "shortcuts work from the opening
// screen"): alt+m (picks) and alt+shift+m (report) open their dialogs
// EVERYWHERE — including the opening screen, where no session exists yet.
// Opening a dialog never creates a session; picking a row with none open
// creates one already bound to the chosen priority alias (picks dialog) or
// concrete model (report dialog) and opens it. With a session open, a pick
// switches that session as before; the no-session report is fetched straight
// from the plugin's report RPC instead of the session command; a disabled
// alias refuses before anything is created.
//
// The tests activate the REAL plugin definition (Plugin.define is a
// passthrough, so importing src/tui runs no host code) with a mocked TUI
// context — the same shape as wiring.test.ts for the server half: every
// registration is captured, dialogs are driven through the modal keymap
// layer's commands, and assertions go to the host calls the plugin makes
// (session.create/switchModel/command, router.navigate, toasts, dialogs).
import { createRoot } from "solid-js"
import { afterEach, describe, expect, test, vi } from "vitest"
import { ModelCompare } from "../../src/rpc"
import { aliasId, useBestNotice, useBestRefusal } from "../../src/opencode/usebest"
import tuiPlugin, { cappedRowsHeight } from "../../src/tui"

type TuiDef = { setup: (ctx: unknown) => Promise<() => void> }
const def = tuiPlugin as unknown as TuiDef

// A command as the keymap layer's factory reports it: id plus run.
type Command = { id: string; run: (input?: unknown) => unknown }

// The theme slice showListDialog reads when it opens a dialog.
const THEME = {
  text: { base: "base", muted: "muted", action: { primary: { focused: "hi-fg" } } },
  hue: { accent: { 200: "accent" } },
  background: { action: { primary: { focused: "hi-bg" } } },
}

// A report payload as the plugin's report RPC returns it (structured entries;
// the TUI normalizes them at the trust boundary). The first entry is the
// current pick, so the report dialog's cursor opens on it.
const ENTRIES = [
  {
    priority: "balanced",
    rank: 1,
    id: "acme/alpha",
    value: "acme/alpha",
    score: "0.500",
    quality: "8.0",
    price: "$1/$2",
    current: true,
    fromFallback: false,
  },
  {
    priority: "balanced",
    rank: 2,
    id: "acme/beta",
    value: "acme/beta",
    score: "0.400",
    quality: "7.0",
    price: "$3/$4",
    current: false,
    fromFallback: false,
  },
  {
    priority: "quality",
    rank: 1,
    id: "acme/alpha",
    value: "acme/alpha",
    score: "0.900",
    quality: "9.0",
    price: "$1/$2",
    current: false,
    fromFallback: false,
  },
]

// Alias entries as the model registry reports them (the runtime plugin keeps
// the display names current; readAliasViews picks the plugin's own out).
function aliasEntries(): Array<{ id: string; name: string; enabled: boolean; modelID: string | null }> {
  return [
    { id: "model-compare/balanced", name: "Model Compare: balanced → acme/alpha", enabled: true, modelID: "acme/alpha" },
    { id: "model-compare/price", name: "Model Compare: price → acme/alpha", enabled: true, modelID: "acme/alpha" },
    { id: "model-compare/quality", name: "Model Compare: quality → acme/alpha", enabled: true, modelID: "acme/alpha" },
  ]
}

// Lets Solid's scheduled effect runs (the modal keymap layer, the report
// hand-off) and the plugin's awaited mocks settle.
async function drain(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

// A mocked TUI plugin context. `state.route` is the router's current route —
// undefined is the opening screen (no session); a session route carries its
// id. Every host surface the TUI touches is a vi.fn() the tests assert on.
function makeHarness() {
  const state: { route: unknown } = { route: undefined }
  const toasts: Array<{ message: string; variant: string }> = []
  const slots: Array<{ append: string; render: () => unknown }> = []
  const layerFactories: Array<() => unknown> = []
  const dialogRenders: Array<() => unknown> = []
  const dialogSets: Array<unknown> = []
  // The host dialog's close callbacks, in show() order: a dialog's close()
  // tears down ITS keyboard and surface (the modal keymap layer, the host
  // dialog), and the tests need to drive it to disarm a dialog without
  // picking — see the afterEach note on the module-scope armedClose.
  const closes: Array<() => void> = []
  const listenCallbacks: Array<(event: unknown) => void> = []
  const entries = aliasEntries()
  const reportPayload: { age?: unknown; entries?: unknown } = {}

  const session = {
    create: vi.fn(async (_input: { model: { providerID: string; id: string } }) => ({ id: "new-session-1" })),
    switchModel: vi.fn(async (_input: { sessionID: string; model: { providerID: string; id: string } }) => {}),
    command: vi.fn(async (_input: { sessionID: string; name: string; text: string }) => ({})),
  }
  const report = vi.fn(async (_input: unknown, _options: unknown) => reportPayload)
  const rpc = vi.fn((_rpcClass: unknown) => ({ report }))
  const navigate = vi.fn((_route: unknown) => {})

  const ctx = {
    location: { directory: "/repo" },
    client: { session, config: { get: vi.fn(async () => []) }, rpc },
    ui: {
      toast: {
        show: vi.fn((input: { message: string; variant?: string }) => {
          toasts.push({ message: input.message, variant: input.variant ?? "success" })
        }),
      },
      router: { current: vi.fn(() => state.route), navigate },
      slot: vi.fn((config: { append: string; render: () => unknown }) => {
        slots.push(config)
        return () => {}
      }),
      dialog: {
        show: vi.fn((render: () => unknown, close: () => void) => {
          dialogRenders.push(render)
          closes.push(close)
        }),
        set: vi.fn((options: unknown) => {
          dialogSets.push(options)
        }),
        clear: vi.fn(),
      },
    },
    theme: { surface: vi.fn(() => THEME) },
    // The host's live renderer: the TUI entry tracks its resize events for
    // the dialogs' viewport caps (CliRenderEvents.RESIZE passes the fresh
    // dimensions as arguments).
    renderer: {
      width: 80,
      height: 24,
      on: vi.fn(),
      off: vi.fn(),
      once: vi.fn(),
      requestRender: vi.fn(),
    },
    keymap: {
      layer: vi.fn((factory: () => unknown) => {
        layerFactories.push(factory)
        return () => {}
      }),
    },
    data: {
      listen: vi.fn((cb: (event: unknown) => void) => {
        listenCallbacks.push(cb)
        return () => {}
      }),
      location: { model: { list: vi.fn(() => entries), sync: vi.fn(async () => {}) } },
    },
  }

  return { state, toasts, slots, layerFactories, dialogRenders, dialogSets, closes, listenCallbacks, session, report, rpc, navigate, entries, reportPayload, ctx }
}

type Harness = ReturnType<typeof makeHarness> & {
  cleanup: Awaited<ReturnType<TuiDef["setup"]>>
  disposeRender: () => void
  command: (id: string) => Command
  modalCommands: () => Promise<Command[] | null>
}

// Activates the real plugin definition: setup runs against the mocks, then
// the app slot's render registers the keymap layers exactly once (in the host
// it runs inside the mounted provider tree; here inside a plain reactive
// owner — the layers are captured, never rendered). Pass a prepared harness
// to seed state BEFORE setup: the aliases memo computes once at activation
// and the mock registry is not reactive, so later mutations are invisible.
async function activate(harness = makeHarness()): Promise<Harness> {
  const cleanup = await def.setup(harness.ctx)
  const appSlot = harness.slots.find((slot) => slot.append === "app")
  if (appSlot === undefined) throw new Error("the app slot was never claimed")
  let disposeRender = () => {}
  createRoot((dispose) => {
    disposeRender = dispose
    appSlot.render()
  })
  const globalCount = harness.layerFactories.length
  if (globalCount === 0) throw new Error("the global keymap layer was never registered")

  const globalCommands = (): Command[] =>
    (harness.layerFactories[globalCount - 1]!() as { commands: Command[] }).commands
  const command = (id: string): Command => {
    const found = globalCommands().find((item) => item.id === id)
    if (found === undefined) throw new Error(`keymap command ${id} is not registered`)
    return found
  }
  // The modal list-dialog layer appears only once a dialog has opened (the
  // in-tree effect registers it on a scheduled run; the drain flushes it).
  const modalCommands = async (): Promise<Command[] | null> => {
    await drain()
    const modal = harness.layerFactories.slice(globalCount).at(-1)
    if (modal === undefined) return null
    return (modal() as { commands: Command[] }).commands
  }

  return { ...harness, cleanup, disposeRender, command, modalCommands }
}

// The dialog's pick command (the modal layer's "return" binding).
async function modalPick(active: Harness): Promise<Command | null> {
  const modal = await active.modalCommands()
  if (modal === null) return null
  return modal.find((item) => item.id === "model-compare.list.pick") ?? null
}

let active: Harness | undefined
afterEach(async () => {
  if (active !== undefined) {
    // Disarm any dialog the test left open BEFORE teardown. src/tui.tsx's
    // module-scope armedClose survives setup's cleanup and would otherwise
    // leak into the next test: arming a dialog there runs this test's stale
    // close against the dead harness (its dialog.clear, its disposed
    // signals). Closing here keeps the armed state per-test.
    const close = active.closes.at(-1)
    if (close !== undefined) close()
    await active.cleanup()
    active.disposeRender()
  }
  active = undefined
})

// ---- the opening screen (no session) ---------------------------------------

describe("the shortcuts from the opening screen (no session)", () => {
  test("alt+m opens the picks dialog and creates nothing", async () => {
    active = await activate()

    await active.command("model-compare.picks").run()

    await drain()
    expect(active.dialogRenders).toHaveLength(1)
    expect(active.session.create).not.toHaveBeenCalled()
    expect(active.navigate).not.toHaveBeenCalled()
    expect(active.toasts).toEqual([]) // the old refusal toast is gone
  })

  test("picking a priority creates a session bound to that alias and opens it", async () => {
    active = await activate()
    await active.command("model-compare.picks").run()
    const pick = await modalPick(active)
    expect(pick).not.toBeNull()

    pick!.run()
    await drain()

    expect(active.session.create).toHaveBeenCalledTimes(1)
    expect(active.session.create).toHaveBeenCalledWith({
      model: { providerID: "openrouter", id: aliasId("balanced") },
    })
    expect(active.navigate).toHaveBeenCalledWith({ type: "session", sessionID: "new-session-1" })
    expect(active.session.switchModel).not.toHaveBeenCalled()
    expect(active.toasts).toEqual([
      { message: useBestNotice("balanced", "acme/alpha"), variant: "success" },
    ])
  })

  test("a failed session create toasts the error and leaves no half-open session", async () => {
    active = await activate()
    active.session.create.mockRejectedValueOnce(new Error("quota"))
    await active.command("model-compare.picks").run()
    const pick = await modalPick(active)
    expect(pick).not.toBeNull()

    pick!.run()
    await drain()

    expect(active.session.create).toHaveBeenCalledTimes(1)
    expect(active.toasts).toEqual([
      { message: "could not open a session: quota", variant: "error" },
    ])
    // The catch's contract: no navigation into a session that never came up,
    // and no fallback switch attempt.
    expect(active.navigate).not.toHaveBeenCalled()
    expect(active.session.switchModel).not.toHaveBeenCalled()
  })

  test("a disabled priority refuses BEFORE anything is created", async () => {
    // Seeded BEFORE activation: the aliases memo computes once at setup and
    // the mock registry is not reactive — the real host's data layer is.
    const harness = makeHarness()
    harness.entries[2]!.enabled = false // quality
    active = await activate(harness)
    await active.command("model-compare.picks").run()
    const modal = await active.modalCommands()
    expect(modal).not.toBeNull()
    const down = modal!.find((item) => item.id === "model-compare.list.down")
    const pick = modal!.find((item) => item.id === "model-compare.list.pick")
    expect(down).not.toBeNull()
    expect(pick).not.toBeNull()

    down!.run() // balanced → price
    down!.run() // price → quality (disabled, dimmed — the cursor still reaches it)
    pick!.run()
    await drain()

    expect(active.session.create).not.toHaveBeenCalled()
    expect(active.navigate).not.toHaveBeenCalled()
    expect(active.toasts).toEqual([{ message: useBestRefusal("quality"), variant: "error" }])
  })

  test("alt+shift+m fetches the report straight from the plugin's RPC — no session command, no session created", async () => {
    active = await activate()
    active.reportPayload.age = "2h"
    active.reportPayload.entries = ENTRIES

    await active.command("model-compare.report").run()
    await drain()

    expect(active.rpc).toHaveBeenCalledTimes(1)
    expect(active.rpc.mock.calls[0]![0]).toBe(ModelCompare)
    expect(active.report).toHaveBeenCalledWith({}, { location: { directory: "/repo" } })
    expect(active.session.command).not.toHaveBeenCalled()
    expect(active.session.create).not.toHaveBeenCalled()
    expect(active.dialogRenders).toHaveLength(1)
  })

  test("picking a report row creates a session bound to that concrete model", async () => {
    active = await activate()
    active.reportPayload.age = "2h"
    active.reportPayload.entries = ENTRIES // cursor positioning per `current` is covered by the dedicated test below
    await active.command("model-compare.report").run()
    const pick = await modalPick(active)
    expect(pick).not.toBeNull()

    pick!.run()
    await drain()

    expect(active.session.create).toHaveBeenCalledTimes(1)
    expect(active.session.create).toHaveBeenCalledWith({
      model: { providerID: "openrouter", id: "acme/alpha" },
    })
    expect(active.navigate).toHaveBeenCalledWith({ type: "session", sessionID: "new-session-1" })
    expect(active.session.switchModel).not.toHaveBeenCalled()
    expect(active.toasts).toEqual([{ message: "switched to openrouter/acme/alpha", variant: "success" }])
  })

  test("the report dialog opens with the cursor on the current entry, not the first", async () => {
    active = await activate()
    active.reportPayload.age = "2h"
    // A DEDICATED fixture with `current` on a NON-first row: the shared
    // ENTRIES keep current on row 0, where honoring it and ignoring it are
    // indistinguishable. If the cursor ignored `current` here it would open
    // on row 0 and the pick would bind acme/alpha.
    active.reportPayload.entries = [
      { priority: "balanced", rank: 1, id: "acme/alpha", value: "acme/alpha", score: "0.500", quality: "8.0", price: "$1/$2", current: false, fromFallback: false },
      { priority: "balanced", rank: 2, id: "acme/beta", value: "acme/beta", score: "0.400", quality: "7.0", price: "$3/$4", current: true, fromFallback: false },
      { priority: "balanced", rank: 3, id: "acme/gamma", value: "acme/gamma", score: "0.300", quality: "6.0", price: "$5/$6", current: false, fromFallback: false },
    ]
    await active.command("model-compare.report").run()
    const pick = await modalPick(active)
    expect(pick).not.toBeNull()

    pick!.run() // cursor opens on the current entry (row 1), not row 0
    await drain()

    expect(active.session.create).toHaveBeenCalledTimes(1)
    expect(active.session.create).toHaveBeenCalledWith({
      model: { providerID: "openrouter", id: "acme/beta" },
    })
  })

  test("malformed report entries are dropped before they can become picks", async () => {
    active = await activate()
    active.reportPayload.age = "2h"
    active.reportPayload.entries = [
      // No `id`: dropped by the trust-boundary normalization. Unlike an
      // entry with no `value` (which showListDialog's selectable filter
      // would drop from the cursor ANYWHERE), this one carries a value — if
      // the identity guard failed to drop it, it would be selectable and the
      // cursor's row 0 would bind `acme/wrong` instead.
      { priority: "balanced", rank: 1, value: "acme/wrong", score: "0.9", quality: "9.0", price: "$1/$2", current: false, fromFallback: false },
      { priority: "balanced", rank: 2, id: "acme/beta", value: "acme/beta", score: "0.4", quality: "7.0", price: "$3/$4", current: false, fromFallback: false },
      { priority: "balanced", rank: 3, id: "acme/alpha", value: "acme/alpha", score: "0.5", quality: "8.0", price: "$1/$2", current: false, fromFallback: false },
    ]
    await active.command("model-compare.report").run()
    const pick = await modalPick(active)
    expect(pick).not.toBeNull()

    pick!.run() // cursor 0: the first entry the identity guard let through
    await drain()

    expect(active.session.create).toHaveBeenCalledTimes(1)
    expect(active.session.create).toHaveBeenCalledWith({
      model: { providerID: "openrouter", id: "acme/beta" },
    })
    expect(active.session.create).not.toHaveBeenCalledWith({
      model: { providerID: "openrouter", id: "acme/wrong" },
    })
  })

  test("a report payload with no valid entries degrades to a toast — no dialog, no session", async () => {
    active = await activate()
    active.reportPayload.age = "1h"
    active.reportPayload.entries = [{ priority: "balanced", rank: 1, id: "acme/broken" }]

    await active.command("model-compare.report").run()
    await drain()

    expect(active.dialogRenders).toHaveLength(0)
    expect(active.session.create).not.toHaveBeenCalled()
    expect(active.toasts).toEqual([{ message: "no ranking data available yet", variant: "error" }])
  })

  test("the palette use-best also opens a bound session from the opening screen", async () => {
    active = await activate()

    await active.command("model-compare.use-best").run("price")
    await drain()

    expect(active.session.create).toHaveBeenCalledWith({
      model: { providerID: "openrouter", id: aliasId("price") },
    })
    expect(active.navigate).toHaveBeenCalledWith({ type: "session", sessionID: "new-session-1" })
  })

  test("the palette use-best with an unknown priority refuses without creating anything", async () => {
    active = await activate()

    await active.command("model-compare.use-best").run("bogus")
    await drain()

    // The parse refusal wired through to the TUI command (the decision logic
    // itself is pinned in tests/unit/usebest.test.ts).
    expect(active.toasts).toEqual([
      {
        message: 'model-compare: unknown priority "bogus"; valid priorities: balanced, price, quality',
        variant: "error",
      },
    ])
    expect(active.session.create).not.toHaveBeenCalled()
    expect(active.navigate).not.toHaveBeenCalled()
    expect(active.dialogRenders).toHaveLength(0)
  })
})

// ---- the dialog close paths (no pick) --------------------------------------

describe("a dialog closes without picking (the host's close callback)", () => {
  test("closing without picking disarms the dialog — nothing is created", async () => {
    active = await activate()
    await active.command("model-compare.picks").run()
    await drain()
    expect(active.dialogRenders).toHaveLength(1)
    const close = active.closes.at(-1)
    expect(close).toBeDefined()

    close!()
    await drain()

    expect(active.ctx.ui.dialog.clear).toHaveBeenCalledTimes(1)
    expect(active.session.create).not.toHaveBeenCalled()
    expect(active.session.switchModel).not.toHaveBeenCalled()
    expect(active.navigate).not.toHaveBeenCalled()
    expect(active.toasts).toEqual([])

    // Already disarmed: re-invoking the close is a no-op.
    close!()
    await drain()
    expect(active.ctx.ui.dialog.clear).toHaveBeenCalledTimes(1)
  })

  test("a stale close cannot tear down a newer dialog", async () => {
    active = await activate()
    await active.command("model-compare.picks").run() // dialog A
    await drain()
    const closeA = active.closes.at(-1)
    expect(closeA).toBeDefined()
    closeA!()
    await drain()
    expect(active.ctx.ui.dialog.clear).toHaveBeenCalledTimes(1)

    await active.command("model-compare.picks").run() // dialog B
    await drain()
    expect(active.dialogRenders).toHaveLength(2)
    // Arming B left the surface alone: A was already closed and disarmed.
    expect(active.ctx.ui.dialog.clear).toHaveBeenCalledTimes(1)

    // A's stale close, arriving after B is armed, must not clear B's surface
    // or keyboard. (The generation counter's branch is not reachable through
    // this surface — arming closes the previous dialog first — so only the
    // observable property is tested here.)
    closeA!()
    await drain()
    expect(active.ctx.ui.dialog.clear).toHaveBeenCalledTimes(1)

    // B is still armed: its pick still works and clears its own surface.
    const pick = await modalPick(active)
    expect(pick).not.toBeNull()
    pick!.run()
    await drain()
    expect(active.session.create).toHaveBeenCalledTimes(1)
    expect(active.ctx.ui.dialog.clear).toHaveBeenCalledTimes(2)
  })
})

// ---- with a session open, the shortcuts switch it (unchanged) --------------

describe("with a session open, the shortcuts switch it (unchanged)", () => {
  test("a picks pick switches the session to the alias — nothing is created", async () => {
    active = await activate()
    active.state.route = { type: "session", sessionID: "s1" }
    await active.command("model-compare.picks").run()
    const pick = await modalPick(active)
    expect(pick).not.toBeNull()

    pick!.run()
    await drain()

    expect(active.session.switchModel).toHaveBeenCalledWith({
      sessionID: "s1",
      model: { providerID: "openrouter", id: aliasId("balanced") },
    })
    expect(active.session.create).not.toHaveBeenCalled()
    expect(active.navigate).not.toHaveBeenCalled()
  })

  test("a failed switch on the picks path toasts 'use-best failed'", async () => {
    active = await activate()
    active.state.route = { type: "session", sessionID: "s1" }
    active.session.switchModel.mockRejectedValueOnce(new Error("quota"))
    await active.command("model-compare.picks").run()
    const pick = await modalPick(active)
    expect(pick).not.toBeNull()

    pick!.run()
    await drain()

    expect(active.toasts).toEqual([{ message: "use-best failed: quota", variant: "error" }])
    expect(active.session.create).not.toHaveBeenCalled()
    expect(active.navigate).not.toHaveBeenCalled()
  })

  test("alt+shift+m posts the session command — no direct RPC", async () => {
    active = await activate()
    active.state.route = { type: "session", sessionID: "s1" }

    await active.command("model-compare.report").run()
    await drain()

    expect(active.session.command).toHaveBeenCalledWith({ sessionID: "s1", name: "model-compare", text: "" })
    expect(active.rpc).not.toHaveBeenCalled()
    expect(active.dialogRenders).toHaveLength(0) // the dialog rides the event, not this command
  })

  test("a failed session command toasts 'report failed' — no dialog, no RPC fallback", async () => {
    active = await activate()
    active.state.route = { type: "session", sessionID: "s1" }
    active.session.command.mockRejectedValueOnce(new Error("quota"))

    await active.command("model-compare.report").run()
    await drain()

    expect(active.toasts).toEqual([{ message: "report failed: quota", variant: "error" }])
    expect(active.dialogRenders).toHaveLength(0)
    expect(active.rpc).not.toHaveBeenCalled()
    expect(active.session.create).not.toHaveBeenCalled()
  })

  test("a report pick switches the session to the concrete model (the event path)", async () => {
    active = await activate()
    active.state.route = { type: "session", sessionID: "s1" }
    active.listenCallbacks[0]({
      details: {
        type: "rpc.model-compare.report",
        location: { directory: "/repo" },
        data: { sessionID: "s1", age: "3h", entries: ENTRIES },
      },
    })
    await drain()
    expect(active.dialogRenders).toHaveLength(1)
    const pick = await modalPick(active)
    expect(pick).not.toBeNull()

    pick!.run()
    await drain()

    expect(active.session.switchModel).toHaveBeenCalledWith({
      sessionID: "s1",
      model: { providerID: "openrouter", id: "acme/alpha" },
    })
    expect(active.session.create).not.toHaveBeenCalled()
  })

  test("a failed switch on the report-dialog path toasts 'switch failed'", async () => {
    active = await activate()
    active.state.route = { type: "session", sessionID: "s1" }
    active.session.switchModel.mockRejectedValueOnce(new Error("quota"))
    active.listenCallbacks[0]({
      details: {
        type: "rpc.model-compare.report",
        location: { directory: "/repo" },
        data: { sessionID: "s1", age: "3h", entries: ENTRIES },
      },
    })
    await drain()
    const pick = await modalPick(active)
    expect(pick).not.toBeNull()

    pick!.run()
    await drain()

    expect(active.toasts).toEqual([{ message: "switch failed: quota", variant: "error" }])
    expect(active.session.create).not.toHaveBeenCalled()
    expect(active.navigate).not.toHaveBeenCalled()
  })
})

// ---- dialog presentation and viewport fitting (the palette's behavior) -----

describe("dialog presentation and viewport fitting", () => {
  test("the dialogs open centered at the medium size, like the palette", async () => {
    active = await activate()

    await active.command("model-compare.picks").run()
    await drain()

    // The host's dialog layer anchors UNcentered dialogs at a quarter of the
    // viewport height, and dialog size/centered state persists across dialogs
    // — without an explicit set() a large-font viewport clips the dialog's
    // bottom and a host dialog's stale xlarge width leaks in.
    expect(active.dialogSets).toEqual([{ size: "medium", centered: true }])
  })

  test("alt+shift+m sets the same presentation on the report dialog", async () => {
    active = await activate()
    active.reportPayload.age = "2h"
    active.reportPayload.entries = ENTRIES

    await active.command("model-compare.report").run()
    await drain()

    expect(active.dialogSets).toEqual([{ size: "medium", centered: true }])
  })
})

describe("cappedRowsHeight (the palette's list cap)", () => {
  test("caps the row area at half the viewport minus six rows", () => {
    expect(cappedRowsHeight(50, 40)).toBe(14)
  })

  test("short lists keep their natural height", () => {
    expect(cappedRowsHeight(3, 40)).toBe(3)
  })

  test("a tiny viewport still shows one row", () => {
    expect(cappedRowsHeight(50, 13)).toBe(1)
  })

  test("no rows means no height", () => {
    expect(cappedRowsHeight(0, 40)).toBe(0)
  })
})

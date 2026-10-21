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

// ---- the dialog JSX's fake element model -----------------------------------
// src/tui.tsx is Solid JSX: the transform compiles it to @opentui/solid's
// universal runtime (createElement/insertNode/setProp/insert/use/...), whose
// real element creation demands a live RenderContext this unit rig has no
// business spinning up. The mock below is that runtime's whole surface for
// the compiled dialog tree: plain nodes carrying props and children, and a
// scrollbox node that is exactly what showListDialog's ref captures — its
// geometry (height/scrollHeight/scrollTop) is TEST-DRIVEN and scrollTo is
// recorded, so the reveal arithmetic can be asserted line by line. Effects
// (the universal runtime's reactive expressions) run once at render and are
// replayable: `rerenderEffects` stands in for Solid re-evaluating them on a
// signal change such as a resize.
type FakeNode = {
  tag: string
  props: Record<string, unknown>
  children: FakeNode[]
  height: number
  scrollHeight: number
  scrollTop: number
  scrollCalls: number[]
  scrollTo: (position: number) => void
}

const solidRuntime = vi.hoisted((): {
  makeNode: (tag: string) => FakeNode
  effects: Array<() => void>
} => {
  const effects: Array<() => void> = []
  const makeNode = (tag: string): FakeNode => {
    const node: FakeNode = {
      tag,
      props: {},
      children: [],
      height: 0,
      scrollHeight: 0,
      scrollTop: 0,
      scrollCalls: [],
      // The real scrollTo clamps through the scrollbar ([0, scrollHeight -
      // height]); the reveal clamps first anyway, so recording the call and
      // applying the same clamp keeps multi-move sequences faithful.
      scrollTo(position: number) {
        node.scrollCalls.push(position)
        node.scrollTop = Math.max(0, Math.min(position, Math.max(0, node.scrollHeight - node.height)))
      },
    }
    return node
  }
  return { makeNode, effects }
})

vi.mock("@opentui/solid", () => {
  const { makeNode, effects } = solidRuntime
  const textNode = (value: unknown): FakeNode => {
    const node = makeNode("#text")
    node.props.text = value
    return node
  }
  return {
    createElement: (tag: string) => makeNode(tag),
    createTextNode: textNode,
    insertNode: (parent: FakeNode, child: FakeNode) => {
      parent.children.push(child)
      return child
    },
    insert: (parent: FakeNode, accessor: unknown) => {
      const value = typeof accessor === "function" ? (accessor as () => unknown)() : accessor
      for (const child of Array.isArray(value) ? value : [value]) {
        if (child === undefined || child === null || child === false) continue
        parent.children.push(typeof child === "object" ? (child as FakeNode) : textNode(child))
      }
      return value
    },
    setProp: (node: FakeNode, name: string, value: unknown) => {
      node.props[name] = value
      return value
    },
    // The JSX ref: the real runtime applies it to the created element — how
    // showListDialog captures its scrollbox.
    use: (fn: (node: FakeNode) => void, node: FakeNode) => fn(node),
    createComponent: (type: unknown, props: Record<string, unknown>) =>
      typeof type === "function"
        ? (type as (input: Record<string, unknown>) => unknown)(props)
        : makeNode(String(type)),
    memo: (fn: () => unknown) => () => fn(),
    effect: (fn: (prev: Record<string, unknown>) => unknown, init?: Record<string, unknown>) => {
      const state = init ?? {}
      const out = fn(state)
      const prev = typeof out === "object" && out !== null ? (out as Record<string, unknown>) : state
      effects.push(() => fn(prev))
    },
  }
})

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

  // The renderer's captured listeners and the test-side event trigger.
  type RendererListener = (...args: unknown[]) => void
  const rendererListeners = new Map<string, Map<RendererListener, boolean>>()
  const listen = (event: string, fn: RendererListener, once: boolean) => {
    const byFn = rendererListeners.get(event) ?? new Map<RendererListener, boolean>()
    byFn.set(fn, once)
    rendererListeners.set(event, byFn)
  }
  const fireRenderer = (event: string, ...args: unknown[]) => {
    const byFn = rendererListeners.get(event)
    if (byFn === undefined) return
    for (const [fn, once] of [...byFn.entries()]) {
      if (once) byFn.delete(fn)
      fn(...args)
    }
  }

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
    // dimensions as arguments) and the dialogs' frame-deferred reveals ride
    // CliRenderEvents.FRAME. The listeners are captured here so tests can
    // fire them — including "once" semantics (a once listener is dropped
    // before it runs, and off() removes by the ORIGINAL callback, which is
    // what showListDialog's cancellation passes).
    renderer: {
      width: 80,
      height: 24,
      on: vi.fn((event: string, fn: RendererListener) => listen(event, fn, false)),
      off: vi.fn((event: string, fn: RendererListener) => {
        rendererListeners.get(event)?.delete(fn)
      }),
      once: vi.fn((event: string, fn: RendererListener) => listen(event, fn, true)),
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

  return { state, toasts, slots, layerFactories, dialogRenders, dialogSets, closes, listenCallbacks, session, report, rpc, navigate, entries, reportPayload, fireRenderer, rendererListeners, ctx }
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

// ---- the scroll fixture and the fake-tree render rig ------------------------
// THREE sections × two entries: 10 rows (1 column header, 3 headings, 6
// entries) whose content is 12 LINES — every heading after the first carries
// a blank line above it (the palette recipe), so the selectable entries sit
// at content lines 2, 3, 6, 7, 10, 11 and the content's maximum scroll is
// 12 - height.
const SCROLL_TOPS = [2, 3, 6, 7, 10, 11]
const SCROLL_LINES = 12

function scrollEntries(current?: string): Array<Record<string, unknown>> {
  const entries: Array<Record<string, unknown>> = []
  for (const priority of ["balanced", "price", "quality"]) {
    for (const rank of [1, 2]) {
      const value = `acme/${priority}${rank}`
      entries.push({
        priority,
        rank,
        id: value,
        value,
        score: "0.5",
        quality: "8.0",
        price: "$1/$2",
        current: value === current,
        fromFallback: false,
      })
    }
  }
  return entries
}

function findNode(node: FakeNode, tag: string): FakeNode | undefined {
  if (node.tag === tag) return node
  for (const child of node.children) {
    const found = findNode(child, tag)
    if (found !== undefined) return found
  }
  return undefined
}

// Renders a captured dialog tree against the fake JSX runtime: the ref lands
// on the fake scrollbox during the render (exactly as the host's does), and
// the render's reactive expressions come back replayable.
function renderDialog(harness: Harness): { scrollbox: FakeNode; rerenderEffects: () => void } {
  const tree = harness.dialogRenders.at(-1)!() as FakeNode
  const effects = solidRuntime.effects.splice(0)
  const scrollbox = findNode(tree, "scrollbox")
  if (scrollbox === undefined) throw new Error("the dialog tree carries no scrollbox")
  return { scrollbox, rerenderEffects: () => effects.forEach((run) => run()) }
}

// Opens the report dialog over `entries`, renders its tree, stages the
// scrollbox geometry the tests drive and hands back the modal movement
// commands plus the frame trigger the reveal rides.
async function openReportScroll(
  entries: ReturnType<typeof scrollEntries>,
  geometry: { height: number; scrollHeight?: number; terminal?: { width: number; height: number } },
): Promise<{
  scrollbox: FakeNode
  down: Command
  up: Command
  frame: () => void
  rerenderEffects: () => void
}> {
  const harness = makeHarness()
  if (geometry.terminal !== undefined) {
    harness.ctx.renderer.width = geometry.terminal.width
    harness.ctx.renderer.height = geometry.terminal.height
  }
  active = await activate(harness)
  const open = active
  open.reportPayload.age = "1h"
  open.reportPayload.entries = entries
  await open.command("model-compare.report").run()
  await drain()
  const { scrollbox, rerenderEffects } = renderDialog(open)
  scrollbox.height = geometry.height
  scrollbox.scrollHeight = geometry.scrollHeight ?? SCROLL_LINES
  const modal = await open.modalCommands()
  const down = modal?.find((item) => item.id === "model-compare.list.down")
  const up = modal?.find((item) => item.id === "model-compare.list.up")
  if (down === undefined || up === undefined) {
    throw new Error("the list dialog movement commands were never registered")
  }
  return {
    scrollbox,
    down,
    up,
    frame: () => harness.fireRenderer("frame", { frameId: 1 }),
    rerenderEffects,
  }
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

// ---- the dialogs' viewport scroll (the reveal arithmetic and lifecycle) ----

describe("the dialogs' viewport scroll", () => {
  test.each([1, 2, 3, 4, 5, 6, 7, 8])(
    "the reveal keeps the cursor row visible at viewport height %i",
    async (height) => {
      const { scrollbox, down, up, frame } = await openReportScroll(scrollEntries(), { height })
      // A walk that touches both edges and wraps both ways: seven downs
      // (last → first), then seven ups (first → last).
      let cursor = 0
      for (const delta of [1, 1, 1, 1, 1, 1, 1, -1, -1, -1, -1, -1, -1, -1]) {
        cursor = (cursor + delta + SCROLL_TOPS.length) % SCROLL_TOPS.length
        ;(delta > 0 ? down : up).run()
        frame()
        const top = SCROLL_TOPS[cursor]!
        expect(
          top >= scrollbox.scrollTop && top <= scrollbox.scrollTop + height - 1,
          `height ${height}: row line ${top} left the window [${scrollbox.scrollTop}, ${
            scrollbox.scrollTop + height - 1
          }]`,
        ).toBe(true)
      }
    },
  )

  test("the look-ahead places the row three lines off the edge (height 6)", async () => {
    const { scrollbox, down, up, frame } = await openReportScroll(scrollEntries(), { height: 6 })
    down.run() // cursor 0 → 1 (row line 3): rel 3 > 2 → scrolls to 1
    frame()
    down.run() // cursor 1 → 2 (row line 6): rel 5 > 2 → scrolls to 4
    frame()
    up.run() // cursor 2 → 1 (row line 3): rel -1 < 3 → scrolls to 0
    frame()
    expect(scrollbox.scrollCalls).toEqual([1, 4, 0])
  })

  test("a one-row window pins the row exactly (the degenerate band)", async () => {
    const { scrollbox, down, up, frame } = await openReportScroll(scrollEntries(), { height: 1 })
    down.run() // cursor 0 → 1 (row line 3): the row IS the window at 3
    frame()
    up.run() // cursor 1 → 0 (row line 2)
    frame()
    // The unclamped look-ahead overshot by 4 - height and scrolled the row
    // OUT of a tiny viewport on every move.
    expect(scrollbox.scrollCalls).toEqual([3, 2])
  })

  test("wrap-around scrolls the list to the wrapped-to row", async () => {
    const { scrollbox, down, up, frame } = await openReportScroll(scrollEntries(), { height: 6 })
    for (let step = 0; step < 5; step++) {
      down.run()
      frame()
    }
    down.run() // last → first (row line 2): rel -4 → up-branch → clamps to 0
    frame()
    up.run() // first → last (row line 11): rel 11 → clamps to the maximum 6
    frame()
    expect(scrollbox.scrollCalls).toEqual([1, 4, 5, 6, 6, 0, 6])
    expect(scrollbox.scrollTop).toBe(6)
  })

  test.each<[string, string, number[]]>([
    ["near the top", "acme/balanced2", [0]],
    ["mid-list", "acme/price1", [3]],
    ["near the bottom", "acme/quality2", [6]],
  ])("the preselected row opens centered (%s), clamped to the scroll range", async (_case, current, expected) => {
    const { scrollbox, frame } = await openReportScroll(scrollEntries(current), { height: 6 })
    frame()
    // Center of a 6-row window is 3 rows up; both ends clamp to the range.
    expect(scrollbox.scrollCalls).toEqual(expected)
  })

  test("a cursor move before the first frame defers its reveal and cancels the open-time centering", async () => {
    // The preselected row (line 6) would open centered at 3.
    const { scrollbox, down, frame } = await openReportScroll(scrollEntries("acme/price1"), { height: 6 })
    down.run() // cursor 2 → 3 (row line 7) BEFORE any frame
    expect(scrollbox.scrollCalls).toEqual([]) // nothing races the layout
    frame()
    // ONE reveal, at the look-ahead offset 5 — not the centering's 3, and
    // not a stale second call after the move.
    expect(scrollbox.scrollCalls).toEqual([5])
  })

  test("a pending frame reveal is cancelled on close — and the alive guard backs it up", async () => {
    const { scrollbox, frame } = await openReportScroll(scrollEntries("acme/price1"), { height: 6 })
    // The ref scheduled the preselected row's centering on the next frame.
    const pending = [...(active!.rendererListeners.get("frame")?.keys() ?? [])]
    expect(pending.length).toBe(1)

    active!.closes.at(-1)!()
    expect(active!.ctx.renderer.off).toHaveBeenCalledWith("frame", pending[0])
    frame()
    expect(scrollbox.scrollCalls).toEqual([])
    // The !alive guard alone: even a listener that HAD survived the off()
    // must not scroll a dead dialog.
    pending[0]!()
    expect(scrollbox.scrollCalls).toEqual([])
  })

  test("a resize re-reveals the cursor and re-caps the row area", async () => {
    const { scrollbox, frame, rerenderEffects } = await openReportScroll(scrollEntries("acme/price1"), {
      height: 6,
    })
    // Terminal 24: the cap is 6 (floor(24/2) - 6) — under the fixture's 12
    // content lines.
    expect(scrollbox.props.maxHeight).toBe(6)

    active!.fireRenderer("resize", 80, 40) // the cap rises to 14
    rerenderEffects() // Solid's reactive re-run of the cap expression
    expect(scrollbox.props.maxHeight).toBe(12) // the LINES count, not the 10 rows

    frame()
    // The resize's reveal cancelled the pending centering and scrolled by
    // the look-ahead rule: row line 6 at rel 6 > 2 → 4 (centering would be 3).
    expect(scrollbox.scrollCalls).toEqual([4])
  })

  test("the plugin's cleanup closes an armed dialog and its pending reveal", async () => {
    const { scrollbox, frame } = await openReportScroll(scrollEntries("acme/price1"), { height: 6 })
    await active!.cleanup()
    expect(active!.ctx.ui.dialog.clear).toHaveBeenCalledTimes(1)
    frame()
    expect(scrollbox.scrollCalls).toEqual([])
  })
})

describe("the row-area cap measures content LINES", () => {
  test("a report list's cap counts its heading blanks (3 headings, 12 lines, 10 rows)", async () => {
    // Terminal 40: the cap is 14 — above the row count but not the line
    // count. Measured in rows the cap would clip the tail entries behind
    // the hidden scrollbar; measured in lines the dialog shows them all.
    const { scrollbox } = await openReportScroll(scrollEntries(), {
      height: 6,
      terminal: { width: 80, height: 40 },
    })
    expect(scrollbox.props.maxHeight).toBe(12)
  })

  test("a heading-free list's cap is its row count (rows == lines)", async () => {
    active = await activate()
    await active.command("model-compare.picks").run()
    await drain()
    const { scrollbox } = renderDialog(active)
    // The picks dialog: 3 rows, no heading blanks — min(3, cap 6 at
    // terminal 24).
    expect(scrollbox.props.maxHeight).toBe(3)
  })
})

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
import { createRoot, onCleanup } from "solid-js"
import { afterEach, describe, expect, test, vi } from "vitest"
import { ModelCompare } from "../../src/rpc"
import { aliasId, useBestNotice, useBestRefusal } from "../../src/opencode/usebest"
import tuiPlugin, {
  bindableVariant,
  cappedRowsHeight,
  pickNotice,
  registryVariants,
  strWidth,
} from "../../src/tui"

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
    effort: "high",
    alternative: "max 56.0",
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
    effort: "medium",
    alternative: "",
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
    effort: "max",
    alternative: "",
    price: "$1/$2",
    current: false,
    fromFallback: false,
  },
]

// Alias entries as the model registry reports them (the runtime plugin keeps
// the display names current; readAliasViews picks the plugin's own out).
function aliasEntries(): Array<Record<string, unknown>> {
  return [
    { id: "model-compare/balanced", name: "Model Compare: balanced → acme/alpha", enabled: true, modelID: "acme/alpha" },
    { id: "model-compare/price", name: "Model Compare: price → acme/alpha", enabled: true, modelID: "acme/alpha" },
    { id: "model-compare/quality", name: "Model Compare: quality → acme/alpha", enabled: true, modelID: "acme/alpha" },
    // The concrete models behind the picks: the registry's own variant space
    // (models.dev-derived), which the report pick is checked against. The
    // alias views ignore these (readAliasViews keeps the model-compare/
    // prefix only). beta exposes no variants, like a non-reasoning model.
    { id: "acme/alpha", modelID: "acme/alpha", enabled: true, variants: [{ id: "high" }, { id: "max" }, { id: "medium" }] },
    { id: "acme/beta", modelID: "acme/beta", enabled: true, variants: [] },
  ]
}

// Lets Solid's scheduled effect runs (the modal keymap layer, the report
// hand-off) and the plugin's awaited mocks settle.
async function drain(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

// A real-time wait for the warning check's settle loop (it polls the data
// layer for the committed session model before judging the prompt).
async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

// A mocked TUI plugin context. `state.route` is the router's current route —
// undefined is the opening screen (no session); a session route carries its
// id. Every host surface the TUI touches is a vi.fn() the tests assert on.
function makeHarness() {
  const state: { route: unknown } = { route: undefined }
  const toasts: Array<{ message: string; variant: string }> = []
  const slots: Array<{ append: string; render: () => unknown }> = []
  const layerFactories: Array<() => unknown> = []
  const activeLayers = new Set<() => unknown>()
  const dialogRenders: Array<() => unknown> = []
  const dialogSets: Array<unknown> = []
  // The host dialog's close callbacks, in show() order: a dialog's close()
  // tears down ITS keyboard and surface (the modal keymap layer, the host
  // dialog), and the tests need to drive it to disarm a dialog without
  // picking — see the afterEach note on the module-scope armedClose.
  const closes: Array<() => void> = []
  const listenCallbacks: Array<(event: unknown) => void> = []
  const entries = aliasEntries()
  // The data layer's session cache (`data.session.get`), by directory: s1
  // lives in the plugin's own /repo; s2 is deliberately ABSENT — an unknown
  // session reads as unknown location and the TUI falls back to the
  // plugin's own (pinned by the alt+e stale-lookup test). Tests re-seed s1
  // to a worktree directory to pin cross-location routing.
  const sessions = new Map<string, string>([["s1", "/repo"]])
  // The data layer's session MODEL (`data.session.get(...).model`), updated
  // by switchModel the way the host's session.model.selected event updates
  // it. Undefined means the session has no model yet.
  const sessionModels = new Map<string, { providerID: string; id: string }>()
  // The prompt's selected model (`ui.model.current`): the TUI's own state,
  // deliberately SEPARATE from the session model — that separation is the
  // OpenCode bug the warning dialog works around.
  const promptModel: {
    current: { providerID: string; modelID: string; variant?: string } | undefined
  } = { current: { providerID: "openrouter", modelID: aliasId("balanced") } }
  // The durable "Don't show again" preference (context.storage.store): one
  // mutable object the plugin and the tests share. Starts empty so unseeded
  // tests hydrate from options.initial, while pre-mutated tests keep their
  // seeded value on the same object reference.
  const preferences = {} as { warnMaskedSwitch: boolean }
  // The model registry PER DIRECTORY: the plugin's own /repo serves the
  // shared alias entries (with the concrete models' variant spaces); any
  // other directory is a location this instance has never synced, so list()
  // returns undefined — the TUI reads UNKNOWN. Tests seed a foreign
  // directory's registry to pin WHICH registry a cross-location pick
  // validates its advertised variant against.
  const modelRegistries = new Map<string, Array<Record<string, unknown>>>([["/repo", entries]])
  const reportPayload: {
    age?: unknown
    entries?: unknown
    capture?: unknown
    endpointInfo?: unknown
    steeringNote?: unknown
  } = {}

  const session = {
    create: vi.fn(
      async (_input: { model: { providerID: string; id: string; variant?: string } }) => ({
        id: "new-session-1",
      }),
    ),
    switchModel: vi.fn(
      async (input: {
        sessionID: string
        model: { providerID: string; id: string; variant?: string }
      }) => {
        // The host commits the switch and publishes session.model.selected;
        // this fake applies that commit synchronously, so a warning check
        // that waits for the session model sees it on its first read.
        sessionModels.set(input.sessionID, {
          providerID: input.model.providerID,
          id: input.model.id,
        })
      },
    ),
    command: vi.fn(async (_input: { sessionID: string; name: string; text: string }) => ({})),
  }
  // The report RPC, OPTIONS INCLUDED: where a call ROUTES is half its
  // contract (the options pick the location's plugin instance that answers),
  // and the old mock that discarded its second argument hid exactly that
  // half. Every call is recorded so tests can assert the routing.
  const reportCalls: Array<{ input: unknown; options: unknown }> = []
  const report = vi.fn(async (input: unknown, options: unknown) => {
    reportCalls.push({ input, options })
    return reportPayload
  })
  const rpc = vi.fn((_rpcClass: unknown) => ({ report }))
  const navigate = vi.fn((_route: unknown) => {})
  // The server's package-plugin update check. Defaults to "nothing to
  // report"; the update-notice tests seed an outdated package entry.
  const pluginCheck = vi.fn(async (_input?: unknown) => ({
    location: { directory: "/repo" },
    data: [] as Array<Record<string, unknown>>,
  }))

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
    client: { session, config: { get: vi.fn(async () => []) }, rpc, plugin: { check: pluginCheck } },
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
      model: {
        current: vi.fn(() => promptModel.current),
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
        activeLayers.add(factory)
        onCleanup(() => {
          activeLayers.delete(factory)
        })
        return () => {}
      }),
      dispatch: vi.fn((_id: string) => {}),
    },
    // The durable TUI storage (the "Don't show again" preference). The
    // fake store hydrates options.initial in-place when unseeded and hands
    // the plugin the same mutable object the tests inspect; mutations are
    // applied synchronously.
    storage: {
      store: vi.fn(
        (
          key: string,
          options: { initial: { warnMaskedSwitch: boolean } },
        ): readonly [
          { warnMaskedSwitch: boolean },
          (mutation: (draft: { warnMaskedSwitch: boolean }) => void) => Promise<void>,
        ] => {
          expect(key).toBe("preferences")
          if (Object.keys(preferences).length === 0) {
            Object.assign(preferences, options.initial)
          }
          return [
            preferences,
            async (mutation) => {
              mutation(preferences)
            },
          ]
        },
      ),
      memory: vi.fn(),
    },
    data: {
      listen: vi.fn((cb: (event: unknown) => void) => {
        listenCallbacks.push(cb)
        return () => {}
      }),
      session: {
        get: vi.fn((sessionID: string) => {
          const directory = sessions.get(sessionID)
          if (directory === undefined) return undefined
          const model = sessionModels.get(sessionID)
          return { location: { directory }, ...(model === undefined ? {} : { model }) }
        }),
        sync: vi.fn(async (_sessionID: string) => {}),
      },
      location: {
        model: {
          // Location-aware: the shared entries answer the plugin's own /repo
          // (or an unaddressed call), and a foreign directory answers only
          // what the test seeded for it (undefined = never synced, UNKNOWN).
          list: vi.fn((loc?: { directory?: string }) => {
            const directory = loc?.directory
            return directory === undefined ? entries : modelRegistries.get(directory)
          }),
          sync: vi.fn(async (_loc?: { directory?: string }) => {}),
        },
      },
    },
  }

  return { state, toasts, slots, layerFactories, activeLayers, dialogRenders, dialogSets, closes, listenCallbacks, session, report, reportCalls, rpc, navigate, entries, sessions, sessionModels, promptModel, preferences, modelRegistries, reportPayload, fireRenderer, rendererListeners, pluginCheck, ctx }
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
  // Active modal dialog layer: registered by an in-tree effect while a dialog
  // is open and removed via Solid onCleanup when disarmed. More than one
  // active modal layer at a time is a lifecycle bug (conflicting bindings).
  const modalCommands = async (): Promise<Command[] | null> => {
    await drain()
    const modals = [...harness.activeLayers]
      .map((factory) => factory() as { mode?: string; commands: Command[] })
      .filter((layer) => layer.mode === "modal")
    if (modals.length > 1) {
      throw new Error(`expected at most one active modal layer, got ${modals.length}`)
    }
    return modals[0]?.commands ?? null
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

// Every text node's content, in tree order — the dialog's rendered lines,
// including the footer's. (The mock's text nodes are `#text` nodes whose
// `props.text` carries the string.)
function treeTexts(node: FakeNode): string[] {
  const texts: string[] = []
  const walk = (n: FakeNode): void => {
    if (n.tag === "#text" && typeof n.props.text === "string") texts.push(n.props.text)
    for (const child of n.children) walk(child)
  }
  walk(node)
  return texts
}

// Renders a captured dialog tree against the fake JSX runtime: the ref lands
// on the fake scrollbox during the render (exactly as the host's does), and
// the render's reactive expressions come back replayable.
function renderDialog(harness: Harness): { scrollbox: FakeNode; rerenderEffects: () => void; tree: FakeNode } {
  const tree = harness.dialogRenders.at(-1)!() as FakeNode
  const effects = solidRuntime.effects.splice(0)
  const scrollbox = findNode(tree, "scrollbox")
  if (scrollbox === undefined) throw new Error("the dialog tree carries no scrollbox")
  return { scrollbox, rerenderEffects: () => effects.forEach((run) => run()), tree }
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
  home: Command | undefined
  end: Command | undefined
  pageup: Command | undefined
  pagedown: Command | undefined
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
  const home = modal?.find((item) => item.id === "model-compare.list.home")
  const end = modal?.find((item) => item.id === "model-compare.list.end")
  const pageup = modal?.find((item) => item.id === "model-compare.list.pageup")
  const pagedown = modal?.find((item) => item.id === "model-compare.list.pagedown")
  if (down === undefined || up === undefined) {
    throw new Error("the list dialog movement commands were never registered")
  }
  return {
    scrollbox,
    down,
    up,
    home,
    end,
    pageup,
    pagedown,
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
    // The status line advertises `variant: high` for the highlighted row, so
    // the new session must bind that variant, not the model's default depth.
    expect(active.session.create).toHaveBeenCalledWith({
      model: { providerID: "openrouter", id: "acme/alpha", variant: "high" },
    })
    expect(active.navigate).toHaveBeenCalledWith({ type: "session", sessionID: "new-session-1" })
    expect(active.session.switchModel).not.toHaveBeenCalled()
    expect(active.toasts).toEqual([{ message: "switched to openrouter/acme/alpha#high", variant: "success" }])
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

// ---- the alt+u keybind (issue #9) ------------------------------------------

describe("the alt+u keybind", () => {
  test("binds the use-best command and switches to the default priority", async () => {
    const harness = makeHarness()
    harness.state.route = { type: "session", sessionID: "s1" }
    active = await activate(harness)

    const command = active.command("model-compare.use-best") as Command & { bind?: string }
    expect(command.bind).toBe("alt+u")

    await command.run()
    await drain()

    expect(active.session.switchModel).toHaveBeenCalledWith({
      sessionID: "s1",
      model: { providerID: "openrouter", id: aliasId("balanced") },
    })
    expect(active.toasts).toEqual([
      { message: useBestNotice("balanced", "acme/alpha"), variant: "success" },
    ])
  })
})

// ---- the masked-switch warning dialog --------------------------------------
// OpenCode bug #57771: a plugin's session.switchModel updates the session,
// but the TUI's prompt selection is its own state and keeps the previous
// model, so the next submit silently sends there. The TUI half detects the
// divergence after the switch lands and explains how to complete it from the
// Select model picker. The dialog is styled (italic quoted phrases, a
// clickable bug link) and carries a durable "Don't show again" preference.
const BUG_URL = "https://github.com/anomalyco/opencode/issues/57771"

// The warning dialog's rendered content: every text fragment in order, the
// italic spans (the quoted phrases) and the links.
function warningView(active: Harness): {
  tree: FakeNode
  text: string
  texts: string[]
  italics: string[]
  links: Array<{ href: string; text: string }>
} {
  const tree = active.dialogRenders.at(-1)!() as FakeNode
  const texts = treeTexts(tree)
  const ofTag = (tag: string): FakeNode[] => {
    const found: FakeNode[] = []
    const walk = (node: FakeNode): void => {
      if (node.tag === tag) found.push(node)
      for (const child of node.children) walk(child)
    }
    walk(tree)
    return found
  }
  return {
    tree,
    text: texts.join(""),
    texts,
    italics: ofTag("i").map((node) => treeTexts(node).join("")),
    links: ofTag("a").map((node) => ({
      href: String(node.props.href),
      text: treeTexts(node).join(""),
    })),
  }
}

// A session whose TUI prompt still selects a concrete model: the state the
// bug produces after a plugin switch.
function maskedSwitchHarness(): ReturnType<typeof makeHarness> {
  const harness = makeHarness()
  harness.state.route = { type: "session", sessionID: "s1" }
  harness.promptModel.current = { providerID: "openrouter", modelID: "acme/alpha" }
  return harness
}

describe("the masked-switch warning", () => {
  test("alt+u warns when the prompt selection did not follow the switch", async () => {
    active = await activate(maskedSwitchHarness())

    await active.command("model-compare.use-best").run()
    await drain()

    // The switch itself still succeeded and toasted; the warning explains
    // why the prompt will not use it.
    expect(active.session.switchModel).toHaveBeenCalledWith({
      sessionID: "s1",
      model: { providerID: "openrouter", id: aliasId("balanced") },
    })
    expect(active.toasts).toEqual([
      { message: useBestNotice("balanced", "acme/alpha"), variant: "success" },
    ])
    expect(active.dialogRenders).toHaveLength(1)
    expect(active.dialogSets).toEqual([{ size: "medium", centered: true }])

    const view = warningView(active)
    expect(view.texts).toContain("Model Compare: switch not applied")
    expect(view.text).toContain(
      "To switch to 'Model Compare: balanced', select it from the 'Select model' picker (ctrl+x m).",
    )
    expect(view.text).toContain(`See OpenCode bug #57771: ${BUG_URL}`)
    expect(view.italics).toEqual(["Model Compare: balanced", "Select model"])
    expect(view.links).toEqual([{ href: BUG_URL, text: BUG_URL }])
    expect(view.text).toContain("enter: select model")
    expect(view.text).toContain("d: don't show again")

    // Layout: single 4-col horizontal inset on the body column, the message
    // line, then a blank line before the bug block (paddingTop 1) holding the
    // label and its URL (no nested padded row box squishing the 50-col URL),
    // and a wrapping footer row.
    const [, bodyBox, footerBox] = view.tree.children
    expect(bodyBox?.props).toMatchObject({
      paddingLeft: 4,
      paddingRight: 4,
      flexDirection: "column",
    })
    expect(bodyBox?.children.map((child) => child.tag)).toEqual(["text", "box"])
    const bugBox = bodyBox?.children[1]
    expect(bugBox?.props).toMatchObject({ paddingTop: 1, flexDirection: "column" })
    expect(bugBox?.children.map((child) => child.tag)).toEqual(["text", "text"])
    expect(footerBox?.props).toMatchObject({
      paddingLeft: 4,
      paddingRight: 4,
      flexDirection: "row",
      flexWrap: "wrap",
      columnGap: 2,
      rowGap: 0,
    })
    expect(footerBox?.children.map((child) => child.tag)).toEqual(["text", "text"])
    // The header's clickable "esc" is the only dismissal hint; repeating it
    // in the footer is noise.
    expect(treeTexts(footerBox!)).toEqual(["enter: select model", "d: don't show again"])
  })

  test("no warning when the prompt already selects the target identity", async () => {
    const harness = makeHarness()
    harness.state.route = { type: "session", sessionID: "s1" }
    harness.promptModel.current = { providerID: "openrouter", modelID: aliasId("balanced") }
    active = await activate(harness)

    await active.command("model-compare.use-best").run()
    await drain()

    expect(active.dialogRenders).toHaveLength(0)
  })

  test("no warning when the prompt model is undefined", async () => {
    const harness = maskedSwitchHarness()
    harness.promptModel.current = undefined
    active = await activate(harness)

    await active.command("model-compare.use-best").run()
    await drain()

    expect(active.dialogRenders).toHaveLength(0)
  })

  test("a provider mismatch with the same modelID still warns", async () => {
    const harness = maskedSwitchHarness()
    harness.promptModel.current = { providerID: "anthropic", modelID: aliasId("balanced") }
    active = await activate(harness)

    await active.command("model-compare.use-best").run()
    await drain()

    expect(active.dialogRenders).toHaveLength(1)
  })

  test("a variant-only difference is not a warning", async () => {
    const harness = makeHarness()
    harness.state.route = { type: "session", sessionID: "s1" }
    harness.promptModel.current = {
      providerID: "openrouter",
      modelID: aliasId("balanced"),
      variant: "high",
    }
    active = await activate(harness)

    await active.command("model-compare.use-best").run()
    await drain()

    expect(active.dialogRenders).toHaveLength(0)
  })

  test("no warning when the session never confirms the switch", async () => {
    const harness = maskedSwitchHarness()
    // The switch resolves but the session data never publishes the new
    // model: the divergence cannot be confirmed, so the warning stays silent
    // rather than guessing.
    harness.session.switchModel.mockImplementationOnce(async () => {})
    active = await activate(harness)

    await active.command("model-compare.use-best").run()
    await sleep(250) // the settle loop's full budget

    expect(active.dialogRenders).toHaveLength(0)
  })

  test("delayed async session confirmation warns once the session model settles", async () => {
    const harness = maskedSwitchHarness()
    harness.session.switchModel.mockImplementationOnce(async (input) => {
      setTimeout(() => {
        harness.sessionModels.set(input.sessionID, {
          providerID: input.model.providerID,
          id: input.model.id,
        })
      }, 25)
    })
    active = await activate(harness)

    await active.command("model-compare.use-best").run("quality")
    await sleep(60)
    await drain()

    expect(active.dialogRenders).toHaveLength(1)
    expect(warningView(active).text).toContain("Model Compare: quality")
  })

  test("a cold session triggers data.session.sync once and warns when synced", async () => {
    const harness = maskedSwitchHarness()
    harness.sessions.delete("s1")
    harness.ctx.data.session.sync.mockImplementationOnce(async (sessionID: string) => {
      await sleep(15)
      harness.sessions.set(sessionID, "/repo")
      harness.sessionModels.set(sessionID, {
        providerID: "openrouter",
        id: aliasId("balanced"),
      })
    })
    active = await activate(harness)

    await active.command("model-compare.use-best").run()
    await sleep(45)
    await drain()

    expect(active.ctx.data.session.sync).toHaveBeenCalledTimes(1)
    expect(active.ctx.data.session.sync).toHaveBeenCalledWith("s1")
    expect(active.dialogRenders).toHaveLength(1)
  })

  test("route changes mid-poll or superseding concrete switches suppress stale warnings", async () => {
    const harness = maskedSwitchHarness()
    // Diverges from balanced, price, and the picked concrete model acme/alpha.
    harness.promptModel.current = { providerID: "openrouter", modelID: "acme/beta" }
    // 1. Navigating to another session mid-poll drops the warning.
    harness.session.switchModel.mockImplementationOnce(async (input) => {
      setTimeout(() => {
        harness.sessionModels.set(input.sessionID, {
          providerID: input.model.providerID,
          id: input.model.id,
        })
      }, 25)
    })
    active = await activate(harness)

    await active.command("model-compare.use-best").run()
    active.state.route = { type: "session", sessionID: "s2" }
    await sleep(50)
    await drain()
    expect(active.dialogRenders).toHaveLength(0) // 0: route change to s2 dropped the balanced warning

    // 2. Switching back to s1 and superseding an in-flight alias check with a
    // report-dialog concrete-model switch cancels the alias warning, leaving
    // only the warning for the picked concrete model.
    active.state.route = { type: "session", sessionID: "s1" }
    active.sessionModels.clear()
    harness.session.switchModel.mockImplementationOnce(async (input) => {
      setTimeout(() => {
        harness.sessionModels.set(input.sessionID, {
          providerID: input.model.providerID,
          id: input.model.id,
        })
      }, 30)
    })
    await active.command("model-compare.use-best").run("price")

    active.listenCallbacks[0]({
      details: {
        type: "rpc.model-compare.report",
        data: { sessionID: "s1", age: "1h", entries: ENTRIES },
      },
    })
    await drain()
    expect(active.dialogRenders).toHaveLength(1) // 1: the report dialog itself
    const pick = await modalPick(active)
    pick!.run() // switchToModel("s1", "acme/alpha") supersedes the pending price check
    await sleep(55)
    await drain()

    // 1: report dialog, 2: acme/alpha warning (prompt acme/beta diverges from
    // acme/alpha); the superseded price check stayed silent after its 30ms commit.
    expect(active.dialogRenders).toHaveLength(2)
    const text = warningView(active).text
    expect(text).toContain("acme/alpha")
    expect(text).not.toContain("Model Compare: price")
  })

  test("an empty report does not cancel an in-flight masked-switch check", async () => {
    const harness = maskedSwitchHarness()
    harness.promptModel.current = { providerID: "openrouter", modelID: aliasId("balanced") }
    harness.session.switchModel.mockImplementationOnce(async (input) => {
      setTimeout(() => {
        harness.sessionModels.set(input.sessionID, {
          providerID: input.model.providerID,
          id: input.model.id,
        })
      }, 25)
    })
    active = await activate(harness)

    await active.command("model-compare.use-best").run("price")
    active.listenCallbacks[0]({
      details: {
        type: "rpc.model-compare.report",
        data: { sessionID: "s1", age: "1h", entries: [] },
      },
    })
    await sleep(60)
    await drain()

    expect(active.toasts).toContainEqual({
      message: "no ranking data available yet",
      variant: "error",
    })
    // An empty report opens no dialog and must not cancel the in-flight check:
    // the only dialog render is the masked-switch warning for price.
    expect(active.dialogRenders).toHaveLength(1)
    expect(warningView(active).text).toContain("Model Compare: price")
  })

  test("the picks dialog path warns too", async () => {
    active = await activate(maskedSwitchHarness())

    await active.command("model-compare.picks").run()
    const pick = await modalPick(active)
    expect(pick).not.toBeNull()
    pick!.run()
    await drain()

    expect(active.dialogRenders).toHaveLength(2) // the picks dialog + the warning
    expect(warningView(active).text).toContain(
      "To switch to 'Model Compare: balanced', select it from the 'Select model' picker (ctrl+x m).",
    )
  })

  test("a report-dialog pick warns when the prompt selection did not follow", async () => {
    // The report dialog switches to a CONCRETE model, not an alias — the same
    // masked-switch bug applies (the session moves, the prompt does not), so
    // the check must run on this path too and name the model the row showed.
    // The prompt still selects the alias here: the state the bug leaves behind
    // after a plugin-initiated concrete switch.
    const harness = maskedSwitchHarness()
    harness.promptModel.current = { providerID: "openrouter", modelID: aliasId("balanced") }
    active = await activate(harness)
    active.listenCallbacks[0]({
      details: {
        type: "rpc.model-compare.report",
        data: { sessionID: "s1", age: "1h", entries: ENTRIES },
      },
    })
    await drain()
    const pick = await modalPick(active)
    expect(pick).not.toBeNull()

    pick!.run()
    await drain()

    expect(active.session.switchModel).toHaveBeenCalledWith({
      sessionID: "s1",
      model: { providerID: "openrouter", id: "acme/alpha", variant: "high" },
    })
    expect(active.dialogRenders).toHaveLength(2) // the report dialog + the warning
    expect(warningView(active).text).toContain(
      "To switch to 'acme/alpha', select it from the 'Select model' picker (ctrl+x m).",
    )
  })

  test("a report-dialog pick stays silent when the prompt already selects that model", async () => {
    // maskedSwitchHarness's prompt selects acme/alpha already — the pick that
    // lands on the same identity must not warn (nothing was masked).
    active = await activate(maskedSwitchHarness())
    active.listenCallbacks[0]({
      details: {
        type: "rpc.model-compare.report",
        data: { sessionID: "s1", age: "1h", entries: ENTRIES },
      },
    })
    await drain()
    const pick = await modalPick(active)
    expect(pick).not.toBeNull()

    pick!.run()
    await drain()

    expect(active.dialogRenders).toHaveLength(1) // the report dialog only
  })

  test("a report-dialog pick stays silent on a variant-only difference", async () => {
    // Variant differences are deliberately not warnings: the prompt selects
    // acme/alpha#medium while the report pick binds acme/alpha#high (ENTRIES[0]).
    const harness = maskedSwitchHarness()
    harness.promptModel.current = {
      providerID: "openrouter",
      modelID: "acme/alpha",
      variant: "medium",
    }
    active = await activate(harness)
    active.listenCallbacks[0]({
      details: {
        type: "rpc.model-compare.report",
        data: { sessionID: "s1", age: "1h", entries: ENTRIES },
      },
    })
    await drain()
    const pick = await modalPick(active)
    expect(pick).not.toBeNull()

    pick!.run()
    await drain()

    expect(active.session.switchModel).toHaveBeenCalledWith({
      sessionID: "s1",
      model: { providerID: "openrouter", id: "acme/alpha", variant: "high" },
    })
    expect(active.dialogRenders).toHaveLength(1) // the report dialog only
  })

  test("a report pick cancels a check started AFTER the report dialog already opened", async () => {
    // Starting /use-best price AFTER the report dialog is already open means
    // showReportDialog's open-time bump already ran; only switchToModel's own
    // ++switchCheckSeq cancels the price check.
    const harness = maskedSwitchHarness()
    harness.promptModel.current = { providerID: "openrouter", modelID: "acme/beta" }
    active = await activate(harness)

    active.listenCallbacks[0]({
      details: {
        type: "rpc.model-compare.report",
        data: { sessionID: "s1", age: "1h", entries: ENTRIES },
      },
    })
    await drain()
    expect(active.dialogRenders).toHaveLength(1) // 1: report dialog
    const pick = await modalPick(active)
    expect(pick).not.toBeNull()

    // Start a delayed /use-best price check while the report dialog is open
    // (switchModel resolves without committing sessionModels yet, keeping the
    // price check polling inside its 200 ms window).
    harness.session.switchModel.mockImplementationOnce(async () => {})
    await active.command("model-compare.use-best").run("price")

    pick!.run()
    await drain()

    // Simulate the earlier price switch's session confirmation landing late:
    // without switchToModel's own bump, the price check would now warn.
    active.sessionModels.set("s1", { providerID: "openrouter", id: aliasId("price") })
    await sleep(45)
    await drain()

    expect(active.dialogRenders).toHaveLength(2) // 1: report dialog, 2: acme/alpha warning only
    const text = warningView(active).text
    expect(text).toContain("acme/alpha")
    expect(text).not.toContain("Model Compare: price")
  })

  test("a report-dialog pick's warning flattens the raw catalog id it names", async () => {
    // The pick needs the RAW id (the switch), but the warning only displays
    // it: control characters and line breaks must not reach the styled text
    // (F-20), the same rule the pick toast follows.
    const harness = maskedSwitchHarness()
    harness.promptModel.current = { providerID: "openrouter", modelID: aliasId("balanced") }
    active = await activate(harness)
    active.listenCallbacks[0]({
      details: {
        type: "rpc.model-compare.report",
        data: {
          sessionID: "s1",
          age: "1h",
          entries: [{ ...ENTRIES[0], id: "acme/evil", value: "acme/evil\n\u001b[31mX" }],
        },
      },
    })
    await drain()
    const pick = await modalPick(active)
    expect(pick).not.toBeNull()

    pick!.run()
    await drain()

    const text = warningView(active).text
    expect(text).toContain("To switch to 'acme/evil [31mX', select it from the")
    expect(text).not.toContain("\n")
    expect(text).not.toContain("\u001b")
  })

  test("the /use-best event warns with the priority the server switched to", async () => {
    const harness = maskedSwitchHarness()
    active = await activate(harness)
    // The server command already committed the switch; only the session data
    // has the target, while the prompt still selects the concrete model.
    active.sessionModels.set("s1", { providerID: "openrouter", id: aliasId("price") })

    active.listenCallbacks[2]({
      details: {
        type: "rpc.model-compare.useBest",
        data: {
          sessionID: "s1",
          message: "model-compare: switched to openrouter/model-compare/price (currently acme/alpha)",
          ok: true,
          priority: "price",
        },
      },
    })
    await drain()

    expect(active.dialogRenders).toHaveLength(1)
    expect(warningView(active).text).toContain(
      "To switch to 'Model Compare: price', select it from the 'Select model' picker (ctrl+x m).",
    )
  })

  test("/use-best refusal or priority-less event stays silent even when sessionModels holds an alias", async () => {
    const harness = maskedSwitchHarness()
    active = await activate(harness)
    active.sessionModels.set("s1", { providerID: "openrouter", id: aliasId("balanced") })

    active.listenCallbacks[2]({
      details: {
        type: "rpc.model-compare.useBest",
        data: {
          sessionID: "s1",
          message: useBestRefusal("balanced"),
          ok: false,
          priority: "balanced",
        },
      },
    })
    active.listenCallbacks[2]({
      details: {
        type: "rpc.model-compare.useBest",
        data: {
          sessionID: "s1",
          message: "model-compare: switched to openrouter/model-compare/balanced (currently acme/alpha)",
          ok: true,
        },
      },
    })
    await drain()

    expect(active.dialogRenders).toHaveLength(0)
  })

  test("Select model closes the warning and opens the host's picker", async () => {
    active = await activate(maskedSwitchHarness())
    await active.command("model-compare.use-best").run()
    await drain()

    const modal = await active.modalCommands()
    const select = modal?.find((item) => item.id === "model-compare.warning.select")
    expect(select).toBeDefined()
    select!.run()
    select!.run() // idempotent once disarmed
    expect(await active.modalCommands()).toBeNull()
    await sleep(0)

    expect(active.ctx.ui.dialog.clear).toHaveBeenCalledTimes(1)
    expect(active.ctx.keymap.dispatch).toHaveBeenCalledTimes(1)
    expect(active.ctx.keymap.dispatch).toHaveBeenCalledWith("model.list")
  })

  test("plugin cleanup cancels a pending Select model dispatch and in-flight poll", async () => {
    const harness = maskedSwitchHarness()
    active = await activate(harness)
    await active.command("model-compare.use-best").run()
    await drain()

    const modal = await active.modalCommands()
    modal?.find((item) => item.id === "model-compare.warning.select")!.run()

    // Also start a slow in-flight switch check before unloading the plugin.
    harness.session.switchModel.mockImplementationOnce(async (input) => {
      setTimeout(() => {
        harness.sessionModels.set(input.sessionID, {
          providerID: input.model.providerID,
          id: input.model.id,
        })
      }, 15)
    })
    await active.command("model-compare.use-best").run("price")

    await active.cleanup()
    await sleep(35)
    await drain()

    expect(active.ctx.keymap.dispatch).not.toHaveBeenCalled()
    expect(active.dialogRenders).toHaveLength(1)
  })

  test("Dismiss (escape and mouse-up) closes without mutating preferences or dispatching model.list", async () => {
    active = await activate(maskedSwitchHarness())
    await active.command("model-compare.use-best").run()
    await drain()
    expect(active.dialogRenders).toHaveLength(1)

    const modal = await active.modalCommands()
    const dismiss = modal?.find((item) => item.id === "model-compare.warning.dismiss")
    expect(dismiss).toBeDefined()
    dismiss!.run()
    expect(await active.modalCommands()).toBeNull()
    await sleep(0)

    expect(active.preferences.warnMaskedSwitch).toBe(true)
    expect(active.ctx.keymap.dispatch).not.toHaveBeenCalled()
    expect(active.ctx.ui.dialog.clear).toHaveBeenCalledTimes(1)

    // Subsequent masked switches warn again; the header "esc" mouse-up closes
    // cleanly, and the footer keeps only its two action labels (the header is
    // the sole dismissal hint).
    await active.command("model-compare.use-best").run()
    await drain()
    expect(active.dialogRenders).toHaveLength(2)
    const headerEsc = warningView(active).tree.children[0]!.children[1]!
    ;(headerEsc.props.onMouseUp as () => void)()
    expect(await active.modalCommands()).toBeNull()

    await active.command("model-compare.use-best").run()
    await drain()
    expect(active.dialogRenders).toHaveLength(3)
    const footerBox = warningView(active).tree.children[2]!
    expect(footerBox.children).toHaveLength(2)
    expect(typeof footerBox.children[0]!.props.onMouseUp).toBe("function")
    expect(typeof footerBox.children[1]!.props.onMouseUp).toBe("function")
    expect(active.preferences.warnMaskedSwitch).toBe(true)
    expect(active.ctx.keymap.dispatch).not.toHaveBeenCalled()
  })

  test("Don't show again persists the preference and suppresses later warnings", async () => {
    active = await activate(maskedSwitchHarness())
    await active.command("model-compare.use-best").run()
    await drain()
    expect(active.dialogRenders).toHaveLength(1)

    const modal = await active.modalCommands()
    const suppress = modal?.find((item) => item.id === "model-compare.warning.suppress")
    expect(suppress).toBeDefined()
    suppress!.run()
    expect(await active.modalCommands()).toBeNull()

    expect(active.preferences.warnMaskedSwitch).toBe(false)
    expect(active.ctx.ui.dialog.clear).toHaveBeenCalled()

    // A later masked switch is silent: the dialog count does not grow.
    await active.command("model-compare.use-best").run()
    await drain()
    expect(active.dialogRenders).toHaveLength(1)
  })

  test("a stored Don't show again preference suppresses from the start, while a missing key defaults to enabled", async () => {
    const harness = maskedSwitchHarness()
    harness.preferences.warnMaskedSwitch = false
    active = await activate(harness)

    await active.command("model-compare.use-best").run()
    await drain()

    expect(active.dialogRenders).toHaveLength(0)

    // If persisted preferences exist without warnMaskedSwitch (undefined), warnings stay enabled.
    delete (active.preferences as { warnMaskedSwitch?: boolean }).warnMaskedSwitch
    await active.command("model-compare.use-best").run()
    await drain()
    expect(active.dialogRenders).toHaveLength(1)
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

  test("a report event from another directory opens the dialog (worktree session)", async () => {
    active = await activate()
    active.state.route = { type: "session", sessionID: "s1" }

    active.listenCallbacks[0]({
      details: {
        type: "rpc.model-compare.report",
        location: { directory: "/elsewhere" },
        data: { sessionID: "s1", age: "3h", entries: ENTRIES },
      },
    })
    await drain()

    expect(active.dialogRenders).toHaveLength(1)
    expect(treeTexts(renderDialog(active).tree).some((text) => text.includes("acme/alpha"))).toBe(true)
  })

  test("a cross-location pick validates the variant against the SESSION's registry (worktree)", async () => {
    // s1 lives in /wt (a worktree tab) while the plugin runs in /repo, and
    // the two registries DISAGREE on acme/alpha's variant space: /repo
    // offers high/max/medium, /wt only max. The switch resolves the model
    // against /wt's registry, so the advertised "high" must be checked THERE
    // and downgraded to the bare model — checking /repo's registry (the bug
    // this pins) would bind "high" and fail model resolution for every later
    // request in the session. The warm-up sync must also target /wt.
    active = await activate()
    active.state.route = { type: "session", sessionID: "s1" }
    active.sessions.set("s1", "/wt")
    active.modelRegistries.set("/wt", [
      { id: "acme/alpha", modelID: "acme/alpha", enabled: true, variants: [{ id: "max" }] },
    ])
    active.listenCallbacks[0]({
      details: {
        type: "rpc.model-compare.report",
        location: { directory: "/wt" },
        data: { sessionID: "s1", age: "3h", entries: [{ ...ENTRIES[0], effort: "high" }] },
      },
    })
    await drain()
    const pick = await modalPick(active)
    expect(pick).not.toBeNull()
    pick!.run()
    await drain()

    // Downgraded: no `variant` key at all — /wt's registry refused "high".
    expect(active.session.switchModel).toHaveBeenCalledWith({
      sessionID: "s1",
      model: { providerID: "openrouter", id: "acme/alpha" },
    })
    expect(active.session.switchModel.mock.calls[0]![0].model).not.toHaveProperty("variant")
    expect(active.toasts).toEqual([
      { message: "switched to openrouter/acme/alpha (variant high unavailable)", variant: "success" },
    ])
    // The dialog data prep warmed the SESSION's registry, not this
    // location's (whose resync already covers it).
    expect(active.ctx.data.location.model.sync).toHaveBeenCalledWith({ directory: "/wt" })
  })

  test("a report pick switches the session to the concrete model (the event path)", async () => {
    // Also the same-location mirror of the cross-location test above: s1
    // lives in the plugin's OWN /repo, where the registry carries the
    // advertised "high" — the pick binds it.
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
      model: { providerID: "openrouter", id: "acme/alpha", variant: "high" },
    })
    // The toast confirms the bound variant — the thing the status line
    // advertised and the pick applied.
    expect(active.toasts).toEqual([{ message: "switched to openrouter/acme/alpha#high", variant: "success" }])
    expect(active.session.create).not.toHaveBeenCalled()
  })

  test("a report pick with no scored effort switches the bare model (no variant key)", async () => {
    active = await activate()
    active.state.route = { type: "session", sessionID: "s1" }
    active.listenCallbacks[0]({
      details: {
        type: "rpc.model-compare.report",
        location: { directory: "/repo" },
        data: {
          sessionID: "s1",
          age: "3h",
          entries: [{ ...ENTRIES[0], effort: "" }],
        },
      },
    })
    await drain()
    const pick = await modalPick(active)
    expect(pick).not.toBeNull()
    pick!.run()
    await drain()
    expect(active.session.switchModel).toHaveBeenCalledWith({
      sessionID: "s1",
      model: { providerID: "openrouter", id: "acme/alpha" },
    })
  })

  test("a report pick never sends the catalog's non-gateway 'reasoning' sentinel as a variant", async () => {
    active = await activate()
    active.state.route = { type: "session", sessionID: "s1" }
    active.listenCallbacks[0]({
      details: {
        type: "rpc.model-compare.report",
        location: { directory: "/repo" },
        data: {
          sessionID: "s1",
          age: "3h",
          entries: [{ ...ENTRIES[0], effort: "reasoning" }],
        },
      },
    })
    await drain()
    const pick = await modalPick(active)
    expect(pick).not.toBeNull()
    pick!.run()
    await drain()
    expect(active.session.switchModel).toHaveBeenCalledWith({
      sessionID: "s1",
      model: { providerID: "openrouter", id: "acme/alpha" },
    })
  })

  test("the pick binds THIS row's variant (the same model under two priorities carries different efforts)", async () => {
    // ENTRIES lists acme/alpha under balanced (effort high) AND under
    // quality (effort max). Two downs walk the cursor from the preselected
    // balanced row to the quality-section row; the pick must use THAT row's
    // effort — not the first entry sharing the value.
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
    const modal = await active.modalCommands()
    expect(modal).not.toBeNull()
    const down = modal!.find((item) => item.id === "model-compare.list.down")
    const pick = modal!.find((item) => item.id === "model-compare.list.pick")
    expect(down).not.toBeNull()
    expect(pick).not.toBeNull()

    down!.run() // acme/alpha (balanced, high) → acme/beta (medium)
    down!.run() // acme/beta → acme/alpha (quality: max)
    pick!.run()
    await drain()

    expect(active.session.switchModel).toHaveBeenCalledWith({
      sessionID: "s1",
      model: { providerID: "openrouter", id: "acme/alpha", variant: "max" },
    })
  })

  test("a pick whose advertised variant the registry does not offer binds the bare model and says so", async () => {
    active = await activate()
    active.state.route = { type: "session", sessionID: "s1" }
    // acme/alpha's registry variants are high/max/medium — xhigh is real on
    // OpenRouter-style data but absent from the host's own variant space, the
    // divergence class that fails model resolution for every later request.
    active.listenCallbacks[0]({
      details: {
        type: "rpc.model-compare.report",
        location: { directory: "/repo" },
        data: { sessionID: "s1", age: "3h", entries: [{ ...ENTRIES[0], effort: "xhigh" }] },
      },
    })
    await drain()
    const pick = await modalPick(active)
    expect(pick).not.toBeNull()
    pick!.run()
    await drain()
    expect(active.session.switchModel).toHaveBeenCalledWith({
      sessionID: "s1",
      model: { providerID: "openrouter", id: "acme/alpha" },
    })
    expect(active.toasts).toEqual([
      { message: "switched to openrouter/acme/alpha (variant xhigh unavailable)", variant: "success" },
    ])
  })

  test("a pick for a model the registry does not list keeps the advertised variant (fail open)", async () => {
    active = await activate()
    active.state.route = { type: "session", sessionID: "s1" }
    active.listenCallbacks[0]({
      details: {
        type: "rpc.model-compare.report",
        location: { directory: "/repo" },
        data: {
          sessionID: "s1",
          age: "3h",
          entries: [{ ...ENTRIES[0], id: "gone/model", value: "gone/model", effort: "high" }],
        },
      },
    })
    await drain()
    const pick = await modalPick(active)
    expect(pick).not.toBeNull()
    pick!.run()
    await drain()
    expect(active.session.switchModel).toHaveBeenCalledWith({
      sessionID: "s1",
      model: { providerID: "openrouter", id: "gone/model", variant: "high" },
    })
  })

  test("a model with NO registry variants never binds one (empty list is a known answer)", async () => {
    active = await activate()
    active.state.route = { type: "session", sessionID: "s1" }
    // acme/beta's registry entry lists no variants, like a non-reasoning model.
    const beta = ENTRIES[1]! // balanced rank 2: acme/beta, effort medium
    active.listenCallbacks[0]({
      details: {
        type: "rpc.model-compare.report",
        location: { directory: "/repo" },
        data: { sessionID: "s1", age: "3h", entries: [beta] },
      },
    })
    await drain()
    const pick = await modalPick(active)
    expect(pick).not.toBeNull()
    pick!.run()
    await drain()
    expect(active.session.switchModel).toHaveBeenCalledWith({
      sessionID: "s1",
      model: { providerID: "openrouter", id: "acme/beta" },
    })
    expect(active.toasts).toEqual([
      { message: "switched to openrouter/acme/beta (variant medium unavailable)", variant: "success" },
    ])
  })

  test("a failed switch on the report-dialog path toasts 'switch failed'", async () => {
    active = await activate()
    active.state.route = { type: "session", sessionID: "s1" }
    // Seed sessionModels with the target while the prompt still holds the
    // balanced alias: an unconditional check outside the try block would warn.
    active.sessionModels.set("s1", { providerID: "openrouter", id: "acme/alpha" })
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
    expect(active.dialogRenders).toHaveLength(1) // report dialog only — failed switch must not warn
    expect(active.session.create).not.toHaveBeenCalled()
    expect(active.navigate).not.toHaveBeenCalled()
  })

  // The Q2 fallback (Task 6): the server hook's once-per-session cannot-steer
  // event surfaces as a toast with the exact fallback copy, but ONLY for the
  // user's current session — the event's location is irrelevant, because a
  // session opened in a tab can live in another directory (a worktree). A
  // session the user isn't currently viewing drops its notice — the emit is
  // once-per-session, so that notice is lost forever (the accepted
  // trade-off: noise from unopened sessions is the worse failure).
  test("the cannot-steer event toasts the fallback message", async () => {
    active = await activate()
    active.state.route = { type: "session", sessionID: "s1" }
    expect(active.listenCallbacks).toHaveLength(3) // the report, cannot-steer and use-best listeners

    active.listenCallbacks[1]({
      details: {
        type: "rpc.model-compare.cannotSteer",
        location: { directory: "/repo" },
        data: { sessionID: "s1" },
      },
    })

    expect(active.toasts).toEqual([
      { message: "cannot steer this session; OpenRouter default routing applies", variant: "success" },
    ])
    // No dialog was opened by this event.
    expect(active.dialogRenders).toHaveLength(0)
  })

  test("a cannot-steer event from another directory still toasts (worktree session)", async () => {
    active = await activate()
    active.state.route = { type: "session", sessionID: "s1" }

    active.listenCallbacks[1]({
      details: {
        type: "rpc.model-compare.cannotSteer",
        location: { directory: "/elsewhere" },
        data: { sessionID: "s1" },
      },
    })

    expect(active.toasts).toEqual([
      { message: "cannot steer this session; OpenRouter default routing applies", variant: "success" },
    ])
  })

  test("a cannot-steer event for a non-current session is ignored", async () => {
    active = await activate()
    active.state.route = { type: "session", sessionID: "s1" }

    active.listenCallbacks[1]({
      details: {
        type: "rpc.model-compare.cannotSteer",
        location: { directory: "/repo" },
        data: { sessionID: "s2" },
      },
    })

    expect(active.toasts).toEqual([])
  })

  test("a non-cannot-steer event is ignored by the cannot-steer listener", async () => {
    active = await activate()
    active.listenCallbacks[1]({
      details: { type: "rpc.model-compare.report", data: { sessionID: "s1" } },
    })
    expect(active.toasts).toEqual([])
  })
})

// ---- the /use-best toast (the server command's event) ----------------------
// The slash command is server-side: it switches the session and writes a
// synthetic transcript notice that only surfaces at the next turn. The TUI
// half owns the immediate feedback, so the command emits a useBest event and
// this listener toasts it for the CURRENT session (the same session scope as
// the report and cannot-steer listeners; the event's location is irrelevant).
describe("the /use-best toast (the server command's event)", () => {
  test("the useBest event toasts the server's success message", async () => {
    active = await activate()
    active.state.route = { type: "session", sessionID: "s1" }

    active.listenCallbacks[2]({
      details: {
        type: "rpc.model-compare.useBest",
        location: { directory: "/elsewhere" },
        data: {
          sessionID: "s1",
          message: "model-compare: switched to openrouter/model-compare/price (currently acme/alpha)",
          ok: true,
        },
      },
    })

    expect(active.toasts).toEqual([
      {
        message: "model-compare: switched to openrouter/model-compare/price (currently acme/alpha)",
        variant: "success",
      },
    ])
  })

  test("a refusal event toasts the error variant", async () => {
    active = await activate()
    active.state.route = { type: "session", sessionID: "s1" }

    active.listenCallbacks[2]({
      details: {
        type: "rpc.model-compare.useBest",
        data: {
          sessionID: "s1",
          message:
            "model-compare: openrouter/model-compare/balanced is currently disabled (no ranking data); not switching",
          ok: false,
        },
      },
    })

    expect(active.toasts).toEqual([
      {
        message:
          "model-compare: openrouter/model-compare/balanced is currently disabled (no ranking data); not switching",
        variant: "error",
      },
    ])
  })

  test("a useBest event for a non-current session is ignored", async () => {
    active = await activate()
    active.state.route = { type: "session", sessionID: "s1" }

    active.listenCallbacks[2]({
      details: {
        type: "rpc.model-compare.useBest",
        data: { sessionID: "s2", message: "model-compare: switched", ok: true },
      },
    })

    expect(active.toasts).toEqual([])
  })

  test("a useBest event with no message is ignored", async () => {
    active = await activate()
    active.state.route = { type: "session", sessionID: "s1" }

    active.listenCallbacks[2]({
      details: {
        type: "rpc.model-compare.useBest",
        data: { sessionID: "s1", ok: true },
      },
    })

    expect(active.toasts).toEqual([])
  })

  test("the listener flattens and caps the bridged message (F-20)", async () => {
    active = await activate()
    active.state.route = { type: "session", sessionID: "s1" }

    // The refusal copy embeds the raw slash argument, so it can carry a
    // newline and unbounded length across the data bridge. The transcript
    // keeps the exact copy; the toast must be the flattened, capped form.
    active.listenCallbacks[2]({
      details: {
        type: "rpc.model-compare.useBest",
        data: {
          sessionID: "s1",
          message:
            'model-compare: unknown priority "a\nb"; valid priorities: balanced, price, quality' +
            "x".repeat(80),
          ok: false,
        },
      },
    })

    expect(active.toasts).toEqual([
      {
        message:
          'model-compare: unknown priority "a b"; valid priorities: balanced, price, quality' +
          "x".repeat(38) +
          "…",
        variant: "error",
      },
    ])
    expect(active.toasts[0]!.message).not.toContain("\n")
    expect(active.toasts[0]!.message.length).toBe(120)
  })
})

// ---- the alt+e toast (the served endpoint) ----------------------------------
// The alt+e toast: the session's last primary reply (provider, endpoint or
// unknown, optional quantization/effort, and tri-state steering).
describe("the alt+e toast (last reply)", () => {
  test("alt+e toasts the served endpoint from the current session's capture (in-order)", async () => {
    active = await activate()
    active.state.route = { type: "session", sessionID: "s1" }
    active.sessions.set("s1", "/wt")
    active.reportPayload.capture = {
      provider: "openrouter",
      endpoint: "Novita",
      model: "acme/alpha",
      steering: "in-order",
    }
    await drain()

    await active.command("model-compare.endpoint").run()
    await drain()

    expect(active.toasts).toEqual([
      {
        message: "last response: acme/alpha\nprovider: openrouter\nendpoint: Novita\nsteering: in order",
        variant: "success",
      },
    ])
    expect(active.reportCalls.at(-1)).toEqual({
      input: { sessionID: "s1" },
      options: { location: { directory: "/wt" } },
    })
  })

  test("alt+e toasts the endpoint's quantization and effort attributes", async () => {
    active = await activate()
    active.state.route = { type: "session", sessionID: "s1" }
    active.reportPayload.capture = {
      provider: "openrouter",
      endpoint: "Novita",
      model: "acme/alpha",
      steering: "in-order",
    }
    active.reportPayload.endpointInfo = {
      quantization: { value: "fp8", relation: "default", default: "fp8" },
      effort: { value: "max", relation: "above-default", default: "high" },
    }
    await drain()

    await active.command("model-compare.endpoint").run()
    await drain()

    expect(active.toasts).toEqual([
      {
        message:
          "last response: acme/alpha\nprovider: openrouter\nendpoint: Novita\nquantization: fp8 (default)\neffort: max (above default high)\nsteering: in order",
        variant: "success",
      },
    ])
  })

  test("alt+e names a sub-default quantization and its model default", async () => {
    active = await activate()
    active.state.route = { type: "session", sessionID: "s1" }
    active.reportPayload.capture = {
      provider: "openrouter",
      endpoint: "OpenInference",
      model: "acme/alpha",
      steering: "not-in-order",
    }
    active.reportPayload.endpointInfo = {
      quantization: { value: "fp4", relation: "sub-default", default: "fp8" },
      effort: { value: "high", relation: "default", default: "high" },
    }
    await drain()

    await active.command("model-compare.endpoint").run()
    await drain()

    expect(active.toasts).toEqual([
      {
        message:
          "last response: acme/alpha\nprovider: openrouter\nendpoint: OpenInference\nquantization: fp4 (sub-default; model default fp8)\neffort: high (default)\nsteering: ! NOT in order",
        variant: "success",
      },
    ])
  })

  test("alt+e ignores malformed or control-only endpointInfo attributes", async () => {
    active = await activate()
    active.state.route = { type: "session", sessionID: "s1" }
    active.reportPayload.capture = {
      provider: "openrouter",
      endpoint: "Novita",
      model: "acme/alpha",
      steering: "in-order",
    }
    active.reportPayload.endpointInfo = {
      quantization: { value: "\u0000\n ", relation: "default", default: "fp8" },
      effort: { value: "max", relation: "sub-default", default: "\u0007 " },
    }
    await drain()

    await active.command("model-compare.endpoint").run()
    await drain()

    // Control-only quantization value is dropped; control-only default degrades
    // to null so `(sub-default)` renders without a blank `model default ` slot.
    expect(active.toasts).toEqual([
      {
        message:
          "last response: acme/alpha\nprovider: openrouter\nendpoint: Novita\neffort: max (sub-default)\nsteering: in order",
        variant: "success",
      },
    ])
  })

  test("alt+e renders a mixed quantization", async () => {
    active = await activate()
    active.state.route = { type: "session", sessionID: "s1" }
    active.reportPayload.capture = {
      provider: "openrouter",
      endpoint: "Mixed",
      model: "acme/alpha",
      steering: "in-order",
    }
    active.reportPayload.endpointInfo = {
      quantization: { value: "fp4/fp8", relation: "mixed", default: "fp8" },
      effort: null,
    }
    await drain()

    await active.command("model-compare.endpoint").run()
    await drain()

    expect(active.toasts).toEqual([
      {
        message:
          "last response: acme/alpha\nprovider: openrouter\nendpoint: Mixed\nquantization: fp4/fp8 (mixed)\nsteering: in order",
        variant: "success",
      },
    ])
  })

  test("alt+e renders above-default with no published default", async () => {
    active = await activate()
    active.state.route = { type: "session", sessionID: "s1" }
    active.reportPayload.capture = {
      provider: "openrouter",
      endpoint: "HighPrecision",
      model: "acme/alpha",
      steering: "in-order",
    }
    active.reportPayload.endpointInfo = {
      quantization: { value: "bf16", relation: "above-default", default: null },
      effort: null,
    }
    await drain()

    await active.command("model-compare.endpoint").run()
    await drain()

    expect(active.toasts).toEqual([
      {
        message:
          "last response: acme/alpha\nprovider: openrouter\nendpoint: HighPrecision\nquantization: bf16 (above default)\nsteering: in order",
        variant: "success",
      },
    ])
  })

  test("alt+e renders sub-default with no published default", async () => {
    active = await activate()
    active.state.route = { type: "session", sessionID: "s1" }
    active.reportPayload.capture = {
      provider: "openrouter",
      endpoint: "OpenInference",
      model: "acme/alpha",
      steering: "in-order",
    }
    active.reportPayload.endpointInfo = {
      quantization: { value: "fp4", relation: "sub-default", default: null },
      effort: null,
    }
    await drain()

    await active.command("model-compare.endpoint").run()
    await drain()

    expect(active.toasts).toEqual([
      {
        message:
          "last response: acme/alpha\nprovider: openrouter\nendpoint: OpenInference\nquantization: fp4 (sub-default)\nsteering: in order",
        variant: "success",
      },
    ])
  })

  test("alt+e flattens control characters in provider, model, endpoint, and attribute values", async () => {
    active = await activate()
    active.state.route = { type: "session", sessionID: "s1" }
    active.reportPayload.capture = {
      provider: "openrouter\n### INJECT",
      endpoint: "Novita\u0007\nEdge",
      model: "acme/alpha\r\nbeta",
      steering: "in-order",
    }
    active.reportPayload.endpointInfo = {
      quantization: { value: "fp8\nfp4", relation: "default", default: "fp8" },
      effort: null,
    }
    await drain()

    await active.command("model-compare.endpoint").run()
    await drain()

    expect(active.toasts).toEqual([
      {
        message:
          "last response: acme/alpha beta\nprovider: openrouter ### INJECT\nendpoint: Novita Edge\nquantization: fp8 fp4 (default)\nsteering: in order",
        variant: "success",
      },
    ])
  })

  test("alt+e renders endpoint: unknown, steering: unknown, and known effort for non-OpenRouter replies", async () => {
    active = await activate()
    active.state.route = { type: "session", sessionID: "s1" }
    active.reportPayload.capture = {
      provider: "anthropic",
      endpoint: null,
      model: "claude-sonnet-4-5",
      steering: "unknown",
    }
    active.reportPayload.endpointInfo = {
      quantization: null,
      effort: { value: "high", relation: "unknown", default: null },
    }
    await drain()

    await active.command("model-compare.endpoint").run()
    await drain()

    expect(active.toasts).toEqual([
      {
        message:
          "last response: claude-sonnet-4-5\nprovider: anthropic\nendpoint: unknown\neffort: high\nsteering: unknown",
        variant: "success",
      },
    ])
  })

  test("alt+e normalizes whitespace/control-only endpoint to unknown and bogus steering to unknown", async () => {
    active = await activate()
    active.state.route = { type: "session", sessionID: "s1" }
    active.reportPayload.capture = {
      provider: "openai",
      endpoint: "\u0000 \n ",
      model: "gpt-5",
      steering: "not-a-valid-verdict",
    }
    await drain()

    await active.command("model-compare.endpoint").run()
    await drain()

    expect(active.toasts).toEqual([
      {
        message: "last response: gpt-5\nprovider: openai\nendpoint: unknown\nsteering: unknown",
        variant: "success",
      },
    ])
  })

  test("alt+e rejects captures with missing or control-only provider or model", async () => {
    active = await activate()
    active.state.route = { type: "session", sessionID: "s1" }
    for (const bad of [
      null,
      { provider: "", endpoint: "Novita", model: "acme/alpha", steering: "in-order" },
      { provider: "\u0000\n", endpoint: "Novita", model: "acme/alpha", steering: "in-order" },
      { provider: "openrouter", endpoint: "Novita", model: "\u0007 ", steering: "in-order" },
      { endpoint: "Novita", model: "acme/alpha", steering: "in-order" },
    ]) {
      active.reportPayload.capture = bad
      await active.command("model-compare.endpoint").run()
      await drain()
    }

    expect(active.toasts).toEqual([])
  })

  test("alt+e with no session open fetches nothing and toasts nothing", async () => {
    active = await activate()
    active.state.route = undefined // the opening screen: no session to look up
    await drain()

    await active.command("model-compare.endpoint").run()
    await drain()

    expect(active.report).not.toHaveBeenCalled()
    expect(active.toasts).toEqual([])
  })

  test("alt+e looks up the CURRENT session's capture, not a stale one", async () => {
    active = await activate()
    active.state.route = { type: "session", sessionID: "s1" }
    active.reportPayload.capture = {
      provider: "openrouter",
      endpoint: "Novita",
      model: "acme/alpha",
      steering: "in-order",
    }
    await drain()

    await active.command("model-compare.endpoint").run()
    await drain()
    expect(active.toasts).toEqual([
      {
        message: "last response: acme/alpha\nprovider: openrouter\nendpoint: Novita\nsteering: in order",
        variant: "success",
      },
    ])

    active.state.route = { type: "session", sessionID: "s2" }
    active.reportPayload.capture = {
      provider: "openrouter",
      endpoint: "DeepInfra",
      model: "acme/beta",
      steering: "not-in-order",
    }
    await active.command("model-compare.endpoint").run()
    await drain()
    expect(active.toasts).toEqual([
      {
        message: "last response: acme/alpha\nprovider: openrouter\nendpoint: Novita\nsteering: in order",
        variant: "success",
      },
      {
        message:
          "last response: acme/beta\nprovider: openrouter\nendpoint: DeepInfra\nsteering: ! NOT in order",
        variant: "success",
      },
    ])
    expect(active.report).toHaveBeenLastCalledWith(
      { sessionID: "s2" },
      { location: { directory: "/repo" } },
    )
  })
})

// ---- the report table's columns --------------------------------------------
// The report table carries the model name, quality, variant and price. The
// variant is inline (the old cursor-following status line is gone); the TUI
// says "variant" to match OpenCode even though the catalog calls it effort.
describe("the report table's columns", () => {
  test("the table has model, qual, variant and price columns", async () => {
    active = await activate()
    active.reportPayload.age = "1h"
    active.reportPayload.entries = ENTRIES

    await active.command("model-compare.report").run()
    await drain()
    const { tree } = renderDialog(active)
    const texts = treeTexts(tree)
    const header = texts.find((text) => text.includes("qual") && text.includes("$ in/out"))

    expect(header).toBeDefined()
    expect(header).toContain("variant")
    expect(header).not.toContain("effort")
    expect(header).not.toContain("alt")

    // The row's trailing columns carry quality, variant and price.
    const rowColumns = texts.find((text) => text.includes("8.0") && text.includes("$1/$2"))
    expect(rowColumns).toBeDefined()
    expect(rowColumns).toContain("high")
    expect(rowColumns).not.toContain("max 56.0")
  })

  test("the header line fits the dialog budget in both layouts", async () => {
    // Medium (default 80-col terminal): the header includes the 3-space indent
    // and must fit the 58-column scrollbox content (60-wide dialog − 2 insets).
    active = await activate()
    active.reportPayload.age = "1h"
    active.reportPayload.entries = ENTRIES
    await active.command("model-compare.report").run()
    await drain()
    const mediumHeader = treeTexts(renderDialog(active).tree).find(
      (text) => text.includes("qual") && text.includes("$ in/out"),
    )
    expect(mediumHeader).toBeDefined()
    expect(strWidth(mediumHeader!)).toBeLessThanOrEqual(58)

    // Large (120-col terminal): the 88-wide dialog leaves 86 columns of content.
    const harness = makeHarness()
    harness.ctx.renderer.width = 120
    active = await activate(harness)
    active.reportPayload.age = "1h"
    active.reportPayload.entries = ENTRIES
    await active.command("model-compare.report").run()
    await drain()
    const largeHeader = treeTexts(renderDialog(active).tree).find(
      (text) => text.includes("qual") && text.includes("$ in/out"),
    )
    expect(largeHeader).toBeDefined()
    expect(strWidth(largeHeader!)).toBeLessThanOrEqual(86)
  })

  test("the variant column shows each row's effort", async () => {
    active = await activate()
    active.reportPayload.age = "1h"
    active.reportPayload.entries = ENTRIES

    await active.command("model-compare.report").run()
    await drain()
    const texts = treeTexts(renderDialog(active).tree)

    expect(texts.find((text) => text.includes("$1/$2") && text.includes("high"))).toBeDefined()
    expect(texts.find((text) => text.includes("$3/$4") && text.includes("medium"))).toBeDefined()
    expect(texts.find((text) => text.includes("$1/$2") && text.includes("max"))).toBeDefined()
  })

  test("an unscored model's empty effort renders as a dash", async () => {
    active = await activate()
    active.reportPayload.age = "1h"
    active.reportPayload.entries = [{ ...ENTRIES[0], effort: "" }]
    await active.command("model-compare.report").run()
    await drain()
    const columns = treeTexts(renderDialog(active).tree).find((text) => text.includes("$1/$2"))
    expect(columns).toBeDefined()
    expect(columns).toContain("-")
  })

  test("an unscored model's pick toast carries no variant suffix (the no-advertisement branch)", async () => {
    active = await activate()
    active.state.route = { type: "session", sessionID: "s1" }
    active.listenCallbacks[0]({
      details: {
        type: "rpc.model-compare.report",
        location: { directory: "/repo" },
        data: { sessionID: "s1", age: "3h", entries: [{ ...ENTRIES[0], effort: "" }] },
      },
    })
    await drain()
    const pick = await modalPick(active)
    expect(pick).not.toBeNull()
    pick!.run()
    await drain()
    expect(active.session.switchModel).toHaveBeenCalledWith({
      sessionID: "s1",
      model: { providerID: "openrouter", id: "acme/alpha" },
    })
    expect(active.toasts).toEqual([{ message: "switched to openrouter/acme/alpha", variant: "success" }])
  })

  test("the variant column clamps wide characters by display columns, not string length", async () => {
    active = await activate()
    active.reportPayload.age = "1h"
    // 深 (U+6DF1) is East Asian Wide: 2 terminal columns each. The effort is
    // 8 code points (16 columns) — a length-based clamp would cut it to 7
    // LENGTH units, which still render 14 columns wide and push the row past
    // its budget.
    active.reportPayload.entries = [{ ...ENTRIES[0], effort: "深度深度深度深度" }]

    await active.command("model-compare.report").run()
    await drain()
    const columns = treeTexts(renderDialog(active).tree).find((text) => text.includes("$1/$2"))
    expect(columns).toBeDefined()
    // Truncated to 6 display columns (3 wide chars) + the ellipsis = 7
    // columns — exactly the variant cap. No mid-character cut.
    expect(columns).toContain("深度深…")
    expect(strWidth(columns!)).toBeLessThanOrEqual(26)
  })

  test("a table row clamps wide cells by display columns and keeps the row budget", async () => {
    active = await activate()
    active.reportPayload.age = "1h"
    // A 20-code-point wide-char id (40 columns) and a wide quality cell: the
    // old length-based clamps rendered this row 60 columns against a
    // 52-column budget (the name column measured 20 length units, so it was
    // never trimmed, and the quality cell was padded to 5 length units =
    // 8 columns).
    active.reportPayload.entries = [
      {
        ...ENTRIES[0],
        id: "深度深度深度深度深度深度深度深度深度深度",
        value: "acme/alpha",
        quality: "深度深度深度",
      },
    ]

    await active.command("model-compare.report").run()
    await drain()
    const texts = treeTexts(renderDialog(active).tree)
    // The quality cell clamps to its 5-column cap ("深度" + ellipsis); the
    // columns segment (quality + variant + price) keeps its exact fixed
    // widths.
    const columns = texts.find((text) => text.includes("$1/$2") && text.includes("深度"))
    expect(columns).toBeDefined()
    expect(columns).toContain("深度…")
    expect(columns).toContain("high")
    expect(strWidth(columns!)).toBeLessThanOrEqual(27)
    // The name column truncates at its 25-column clamp (the medium layout's
    // budget) instead of rendering 40+.
    const label = texts.find((text) => text.startsWith("1. 深度"))
    expect(label).toBeDefined()
    expect(label!.includes("…")).toBe(true)
    expect(strWidth(label!)).toBeLessThanOrEqual(26)
    // Together the row lands exactly on the 52-char content budget.
    expect(strWidth(label!) + strWidth(columns!)).toBeLessThanOrEqual(52)
  })

  test("the variant column clamps emoji by display columns too (transport, dingbat)", async () => {
    active = await activate()
    active.reportPayload.age = "1h"
    // 🚀 (U+1F680, transport) renders 2 columns but sits OUTSIDE the East
    // Asian Wide blocks — the ranges a naive CJK-only width table covers.
    // Five rockets are 10 columns (2 UTF-16 units each) — past the cap.
    active.reportPayload.entries = [{ ...ENTRIES[0], effort: "🚀🚀🚀🚀🚀" }]

    await active.command("model-compare.report").run()
    await drain()
    const columns = treeTexts(renderDialog(active).tree).find((text) => text.includes("$1/$2"))
    expect(columns).toBeDefined()
    // 3 rockets (6 columns) + ellipsis = the 7-column variant cap.
    expect(columns).toContain("🚀🚀🚀…")
    expect(strWidth(columns!)).toBeLessThanOrEqual(26)
  })

  test("report table rows sanitize display fields (F-20) while picking the raw value", async () => {
    active = await activate()
    active.state.route = { type: "session", sessionID: "s1" }
    active.listenCallbacks[0]({
      details: {
        type: "rpc.model-compare.report",
        location: { directory: "/repo" },
        data: {
          sessionID: "s1",
          age: "1h",
          entries: [
            {
              ...ENTRIES[0],
              id: "acme/evil",
              value: "acme/evil\n\u001b[31mX",
              quality: "8.0\n\u001b[31m",
              effort: "high\n\u001b",
              price: "$1/$2\n\u001b[31m",
            },
            {
              ...ENTRIES[1],
              id: "acme/other\n\u001b[31m",
              value: "acme/other",
            },
          ],
        },
      },
    })
    await drain()

    const texts = treeTexts(renderDialog(active).tree)
    for (const text of texts) {
      expect(text).not.toContain("\n")
      expect(text).not.toContain("\u001b")
    }
    expect(texts.some((text) => text.includes("acme/other [31m"))).toBe(true)

    const pick = await modalPick(active)
    expect(pick).not.toBeNull()
    pick!.run()
    await drain()

    // Raw value is preserved for the switch, while raw invalid effort ("high\n\u001b")
    // is NOT pre-sanitized into a valid variant before gatewayEffort() checks it.
    expect(active.session.switchModel).toHaveBeenCalledWith({
      sessionID: "s1",
      model: { providerID: "openrouter", id: "acme/evil\n\u001b[31mX" },
    })
  })
})

// ---- the report dialog's footer --------------------------------------------
// The report dialog's footer carries the steering note only. The
// last-response line was removed: it overflowed the dialog's padding and made
// the picker too tall (the alt+e toast carries the same capture).
describe("the report dialog footer", () => {
  test("the footer renders the steering note and no last-response line", async () => {
    active = await activate()
    active.reportPayload.age = "1h"
    active.reportPayload.entries = ENTRIES
    active.reportPayload.capture = {
      provider: "openrouter",
      endpoint: "Novita",
      model: "acme/alpha",
      steering: "in-order",
    }
    active.reportPayload.steeringNote = "routing steered to fp8, fp4, fp16 endpoints (aliases only)"

    await active.command("model-compare.report").run()
    await drain()
    const { tree } = renderDialog(active)
    const texts = treeTexts(tree)

    expect(texts).toContain("routing steered to fp8, fp4, fp16 endpoints (aliases only)")
    expect(texts.some((text) => text.startsWith("last response:"))).toBe(false)
  })

  test("with no steering note the footer carries no capture line either", async () => {
    active = await activate()
    active.reportPayload.age = "1h"
    active.reportPayload.entries = ENTRIES
    active.reportPayload.capture = {
      provider: "openrouter",
      endpoint: "Novita",
      model: "acme/alpha",
      steering: "in-order",
    }
    active.reportPayload.steeringNote = null

    await active.command("model-compare.report").run()
    await drain()
    const { tree } = renderDialog(active)
    const texts = treeTexts(tree)

    expect(texts.some((text) => text.startsWith("last response:"))).toBe(false)
    expect(texts.some((text) => text.startsWith("routing steered"))).toBe(false)
  })

  test("the report event's steering note flows into the dialog and the capture is ignored", async () => {
    active = await activate()
    active.state.route = { type: "session", sessionID: "s1" }
    await drain()

    active.listenCallbacks[0]({
      details: {
        type: "rpc.model-compare.report",
        location: { directory: "/repo" },
        data: {
          sessionID: "s1",
          age: "2h",
          entries: ENTRIES,
          capture: {
            provider: "openrouter",
            endpoint: "DeepInfra",
            model: "acme/beta",
            steering: "not-in-order",
          },
          steeringNote: "routing steered to fp8 endpoints (aliases only)",
        },
      },
    })
    await drain()
    const { tree } = renderDialog(active)
    const texts = treeTexts(tree)

    expect(texts).toContain("routing steered to fp8 endpoints (aliases only)")
    expect(texts.some((text) => text.startsWith("last response:"))).toBe(false)
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

  test("the report dialog uses the large width on wide terminals and keeps full names", async () => {
    const harness = makeHarness()
    harness.ctx.renderer.width = 120
    active = await activate(harness)
    const longId = "deepseek/deepseek-v4.1-flash-1017"
    active.reportPayload.age = "2h"
    active.reportPayload.entries = [{ ...ENTRIES[0], id: longId, value: longId }]

    await active.command("model-compare.report").run()
    await drain()

    expect(active.dialogSets).toEqual([{ size: "large", centered: true }])
    const texts = treeTexts(renderDialog(active).tree)
    expect(texts.some((text) => text.startsWith(`1. ${longId}`))).toBe(true)
  })

  test("the report dialog falls back to medium and truncates long names on narrow terminals", async () => {
    const harness = makeHarness()
    harness.ctx.renderer.width = 80
    active = await activate(harness)
    const longId = "deepseek/deepseek-v4.1-flash-1017"
    active.reportPayload.age = "2h"
    active.reportPayload.entries = [{ ...ENTRIES[0], id: longId, value: longId }]

    await active.command("model-compare.report").run()
    await drain()

    expect(active.dialogSets).toEqual([{ size: "medium", centered: true }])
    const texts = treeTexts(renderDialog(active).tree)
    const label = texts.find((text) => text.startsWith("1. deepseek"))
    expect(label).toBeDefined()
    expect(label!.includes("…")).toBe(true)
    expect(strWidth(label!)).toBeLessThanOrEqual(27)
  })
})

describe("strWidth (the clamps' display-column measure)", () => {
  test("ASCII and CJK measure as before", () => {
    expect(strWidth("abc")).toBe(3)
    expect(strWidth("深度")).toBe(4) // East Asian Wide: 2 columns each
    expect(strWidth("…")).toBe(1) // the ellipsis stays narrow — the clamps reserve exactly one column for it
  })

  test("wide emoji count 2 columns across all the symbol planes", () => {
    expect(strWidth("🚀")).toBe(2) // U+1F680 transport — outside the CJK blocks
    expect(strWidth("✨")).toBe(2) // U+2728 dingbat
    expect(strWidth("🀄")).toBe(2) // U+1F004 mahjong (the range's head)
    expect(strWidth("🪛")).toBe(2) // U+1FA9B symbols extended-A (the range's tail)
    expect(strWidth("🛰")).toBe(2) // U+1F6F0 transport tail
  })

  test("emoji-presentation sequences (VS16) never count below 2 columns", () => {
    // ☺️ = U+263A + U+FE0F. The VS16 itself counts 1, so the pair totals 3 —
    // one column MORE than it renders, the safe direction for a clamp.
    expect(strWidth("☺️")).toBe(3)
    expect(strWidth("☺")).toBe(2) // the bare base is already covered
    // ⌨️ = U+2328 + U+FE0F: the base is OUTSIDE every wide block, so only
    // the VS16 rule keeps the pair at ≥ 2 — the no-undercount guarantee.
    expect(strWidth("\u2328\uFE0F")).toBe(2)
  })
})

describe("registryVariants / bindableVariant (the pick's registry check)", () => {
  const REGISTRY = [
    { id: "model-compare/balanced", modelID: "acme/alpha" }, // alias view, no variants
    { id: "acme/alpha", modelID: "acme/alpha", variants: [{ id: "high" }, { id: "max" }, { id: 42 }] },
    { id: "acme/plain", modelID: "acme/plain", variants: [] },
  ]

  test("returns the model's variant ids, matching an entry that carries them", () => {
    // The alias view comes first and has no variants; the concrete entry wins.
    expect(registryVariants(REGISTRY, "acme/alpha")).toEqual(["high", "max"])
  })

  test("a model with an empty variant list is KNOWN to have none", () => {
    expect(registryVariants(REGISTRY, "acme/plain")).toEqual([])
  })

  test("an absent model, a non-array registry or a malformed entry is UNKNOWN (null)", () => {
    expect(registryVariants(REGISTRY, "gone/model")).toBeNull()
    expect(registryVariants(undefined, "acme/alpha")).toBeNull()
    expect(registryVariants("nope", "acme/alpha")).toBeNull()
    expect(registryVariants({}, "acme/alpha")).toBeNull()
  })

  test("a known list keeps a listed variant, drops an unlisted one", () => {
    expect(bindableVariant("max", ["high", "max"])).toBe("max")
    expect(bindableVariant("xhigh", ["high", "max"])).toBeUndefined()
    expect(bindableVariant("none", [])).toBeUndefined()
  })

  test("an UNKNOWN registry lets the advertisement stand (fail open)", () => {
    expect(bindableVariant("max", null)).toBe("max")
  })

  test("no advertisement binds nothing, whatever the registry says", () => {
    expect(bindableVariant(undefined, ["high"])).toBeUndefined()
    expect(bindableVariant(undefined, null)).toBeUndefined()
  })
})

describe("pickNotice (the pick's success toast)", () => {
  test("a bound variant is confirmed after the model id", () => {
    expect(pickNotice("acme/alpha", "high", "high")).toBe("switched to openrouter/acme/alpha#high")
  })

  test("no advertised variant keeps the bare-model message", () => {
    expect(pickNotice("acme/alpha", undefined, undefined)).toBe("switched to openrouter/acme/alpha")
  })

  test("an advertised variant the registry does not offer is named as unavailable", () => {
    expect(pickNotice("acme/alpha", "max", undefined)).toBe(
      "switched to openrouter/acme/alpha (variant max unavailable)",
    )
  })

  test("the id is flattened onto one line (F-20); the variant is allowlisted", () => {
    expect(pickNotice("acme/alpha\nacme/beta", "low", "low")).toBe(
      "switched to openrouter/acme/alpha acme/beta#low",
    )
  })
})

describe("cappedRowsHeight (the palette's list cap)", () => {
  test("caps the row area at half the viewport minus three, within the viewport budget", () => {
    expect(cappedRowsHeight(50, 40)).toBe(17)
  })

  test("the viewport budget binds across the 14-17 growth band", () => {
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
    // Terminal 24: the cap is 9 (min(24/2 - 3, 24 - 12)) — under the
    // fixture's 12 content lines.
    expect(scrollbox.props.maxHeight).toBe(9)

    active!.fireRenderer("resize", 80, 40) // the cap rises to 17
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

describe("the list dialogs' jump and page navigation", () => {
  test("home and end jump to the first and last selectable rows", async () => {
    const { scrollbox, home, end, frame } = await openReportScroll(scrollEntries(), { height: 6 })
    expect(home).toBeDefined()
    expect(end).toBeDefined()

    end!.run()
    frame()
    expect(scrollbox.scrollCalls).toEqual([6]) // last row (line 11), clamped to the maximum

    home!.run()
    frame()
    expect(scrollbox.scrollCalls).toEqual([6, 0]) // first row (line 2)
  })

  test("pagedown moves by one screenful and clamps at the last row", async () => {
    const { scrollbox, pagedown, frame } = await openReportScroll(scrollEntries(), { height: 2 })
    expect(pagedown).toBeDefined()

    pagedown!.run() // cursor 0 → 2 (row line 6)
    frame()
    pagedown!.run() // cursor 2 → 4 (row line 10)
    frame()
    pagedown!.run() // cursor 4 → 5 (clamped at the last row, line 11)
    frame()
    expect(scrollbox.scrollCalls).toEqual([6, 10, 10])
  })

  test("pageup moves by one screenful and clamps at the first row", async () => {
    const { scrollbox, pagedown, pageup, frame } = await openReportScroll(scrollEntries(), { height: 2 })
    expect(pageup).toBeDefined()

    for (let step = 0; step < 3; step++) {
      pagedown!.run()
      frame()
    }
    pageup!.run() // cursor 5 → 3 (row line 7)
    frame()
    pageup!.run() // cursor 3 → 1 (row line 3)
    frame()
    pageup!.run() // cursor 1 → 0 (clamped at the first row, line 2)
    frame()
    expect(scrollbox.scrollCalls).toEqual([6, 10, 10, 6, 2, 1])
  })

  test("pagedown lands on the row at/after one screenful of CONTENT LINES (heading blanks included)", async () => {
    const { scrollbox, pagedown, frame } = await openReportScroll(scrollEntries(), { height: 4 })
    expect(pagedown).toBeDefined()

    // Cursor 0 sits at content line 2; one 4-line screenful is line 6, whose
    // first selectable row is index 2 (acme/price1). A ROW-based page would
    // count four selectable rows and land on index 4 (acme/quality1, line
    // 10), skipping the rows at lines 3 and 6 that this viewport displays.
    pagedown!.run()
    frame()
    expect(scrollbox.scrollCalls).toEqual([6]) // the cursor row (line 6) revealed

    const pick = await modalPick(active!)
    pick!.run()
    await drain()
    expect(active!.session.create).toHaveBeenCalledWith({
      model: { providerID: "openrouter", id: "acme/price1" },
    })
  })

  test("pageup lands on the row at/before one screenful (the line-based mirror)", async () => {
    const { scrollbox, pagedown, pageup, frame } = await openReportScroll(scrollEntries(), { height: 4 })
    expect(pageup).toBeDefined()

    pagedown!.run() // cursor 0 (line 2) → 2 (line 6)
    frame()
    pageup!.run() // target line 2: the last row at/before it is index 0 (line 2)
    frame()
    expect(scrollbox.scrollCalls).toEqual([6, 0])

    const pick = await modalPick(active!)
    pick!.run()
    await drain()
    expect(active!.session.create).toHaveBeenCalledWith({
      model: { providerID: "openrouter", id: "acme/balanced1" },
    })
  })
})

describe("the row-area cap measures content LINES", () => {
  test("a report list's cap counts its heading blanks (3 headings, 12 lines, 10 rows)", async () => {
    // Terminal 40: the cap is 17 — above the row count but not the line
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
    // The picks dialog: 3 rows, no heading blanks — min(3, cap 9 at
    // terminal 24).
    expect(scrollbox.props.maxHeight).toBe(3)
  })
})

// ---- the update notice -----------------------------------------------------
// The TUI half surfaces the server's package-plugin update check once, at
// startup, so the user does not have to open /plugins to learn about it.
// Local plugins are skipped: `plugin update` does not touch them.
describe("the update notice", () => {
  const checkResult = (source: Record<string, unknown>) => ({
    location: { directory: "/repo" },
    data: [
      {
        id: "model-compare",
        source,
        features: { server: true, tui: true },
        state: { status: "active" },
      },
    ],
  })

  test("toasts when the active package plugin is outdated", async () => {
    const harness = makeHarness()
    harness.pluginCheck.mockResolvedValueOnce(
      checkResult({
        type: "package",
        target: "model-compare-opencode-plugin",
        version: "0.7.0",
        outdated: true,
      }),
    )

    active = await activate(harness)
    await drain()

    expect(harness.pluginCheck).toHaveBeenCalledWith({
      location: { directory: "/repo" },
      target: "model-compare-opencode-plugin",
    })
    expect(active.toasts).toEqual([
      { message: "New version available - open /plugins to install", variant: "info" },
    ])
  })

  test("stays quiet when the package is current", async () => {
    const harness = makeHarness()
    harness.pluginCheck.mockResolvedValueOnce(
      checkResult({
        type: "package",
        target: "model-compare-opencode-plugin",
        version: "0.7.0",
      }),
    )

    active = await activate(harness)
    await drain()

    expect(active.toasts).toEqual([])
  })

  test("stays quiet when the active copy is local", async () => {
    const harness = makeHarness()
    harness.pluginCheck.mockResolvedValueOnce(checkResult({ type: "local", path: "/repo/src" }))

    active = await activate(harness)
    await drain()

    expect(active.toasts).toEqual([])
  })

  test("a failed check is ignored", async () => {
    const harness = makeHarness()
    harness.pluginCheck.mockRejectedValueOnce(new Error("server not ready"))

    active = await activate(harness)
    await drain()

    expect(active.toasts).toEqual([])
  })
})

// src/index.ts
// Plugin entrypoint (design §8–§10, §15 item 5): everything the earlier tasks
// built becomes a working OpenCode v2 plugin. setup parses options (§3:
// warn-and-default, never throws), seeds state from storage (§8's startup
// chain: pin → fallback → disabled) without ever blocking on fresh data,
// registers the alias transform — after seeding, so the registration-time
// application sees the seeded picks — then the guard hook, the steering
// injection hook and the two commands, kicks off the first refresh in the
// background, schedules the 30-minute refresh tick, and returns a cleanup
// that clears the timer.
//
// `wire` is the testable core — the same setup with injected seams (acquire,
// timer, clock). The default export hands OpenCode the real context; it is
// cast once at this boundary because the plugin keeps a structural, mockable
// view of the context (plain strings instead of OpenCode's branded ids).

import { Plugin } from "@opencode/plugin"
import { parseConfig } from "./config"
import { pinKey, type Pin } from "./core/pins"
import { effectiveWeights, rankModels } from "./core/rank"
import type { Catalog, EndpointCapture, ModelEntry, Priority, Sourced } from "./core/types"
import { captureEndpoint, injectSteering, steeringFor } from "./core/steering"
import { formatReport, humanizeAge, reportEntries } from "./opencode/commands"
import { ModelCompare } from "./rpc"
import { planAlias, type AliasTarget } from "./opencode/aliases"
import { guardDecision, parseAliasRef, type ModelRef } from "./opencode/guard"
import { readNewestCachedDoc, readRecord, type Storage } from "./opencode/storage"
import { acquire, cacheIdentities } from "./sources"
import {
  REFRESH_MS,
  adoptPlan,
  createTick,
  runnableSet,
  warnDisabledAliases,
} from "./opencode/refresh"
import { PRIORITIES, planPicks } from "./opencode/resolution"
import {
  ALIAS_PROVIDER,
  aliasId,
  useBestDecision,
  useBestNotice,
} from "./opencode/usebest"

const PROVIDER_PREFIX = "openrouter/"

// Mirrors core/pins.ts' bareModelId (kept private there; the config value
// looks like "openrouter/<id>", catalog ids are bare). Strip exactly one
// leading prefix — a bare id may itself contain slashes, so nothing beyond
// the prefix is touched.
function bareModelId(configValue: string): string {
  return configValue.startsWith(PROVIDER_PREFIX)
    ? configValue.slice(PROVIDER_PREFIX.length)
    : configValue
}

// The request body's `model` field when it is a string, else undefined — the
// gate steeringFor checks against the pick's id (the live alias-bound body
// carries the pick id verbatim, spike fact 1). Any non-object body reads as
// undefined; injectSteering rejects those on its own.
function bodyModelOf(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null) return undefined
  const model = (body as Record<string, unknown>).model
  return typeof model === "string" ? model : undefined
}

// ---- response capture helpers ----------------------------------------------

// The bounded peek (global constraint: never buffer or consume a response
// stream to inspect it — only a bounded first-chunk peek through a
// pass-through transform, the rest forwarding byte-for-byte). At most this
// many BYTES of a response stream are decoded for inspection; everything past
// the bound is untouched. Sized so a first SSE data chunk (a comment line
// plus one data event in the spike's observations) always fits.
const PEEK_MAX_BYTES = 4096

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

// A response field that must be a string, else null (a numeric/absent
// `provider` or `model` is nothing to capture).
function stringField(obj: Record<string, unknown>, key: string): string | null {
  const value = obj[key]
  return typeof value === "string" ? value : null
}

// The served `provider`/`model` pair carried by a response's first bytes, or
// null while the prefix is not yet conclusive (the peek keeps going). Two
// shapes the spike observed:
//   - SSE (streaming): data lines — the first parseable one decides, and
//     `data: [DONE]` concludes without a capture. Leading comment or blank
//     lines (`: OPENROUTER PROCESSING`, spike fact 5/warmup-B) carry neither,
//     so the peek simply continues to the next chunk rather than concluding
//     anything from them.
//   - plain JSON (non-streaming): the whole prefix parses to an object. A
//     prefix whose JSON is still truncated (e.g. the `provider` key beyond
//     the peek window) stays inconclusive — the body passes through
//     uncaptured rather than being buffered.
function extractServedFields(
  prefix: string,
): { provider: string | null; model: string | null } | null {
  let sawData = false
  for (const line of prefix.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed.startsWith("data:")) continue
    sawData = true
    const payload = trimmed.slice("data:".length).trim()
    if (payload === "[DONE]") return { provider: null, model: null }
    try {
      const parsed = JSON.parse(payload) as unknown
      if (isPlainObject(parsed)) {
        return { provider: stringField(parsed, "provider"), model: stringField(parsed, "model") }
      }
    } catch {
      // A line split across a chunk boundary — keep peeking.
    }
  }
  if (sawData) return null
  try {
    const parsed = JSON.parse(prefix) as unknown
    if (isPlainObject(parsed)) {
      return { provider: stringField(parsed, "provider"), model: stringField(parsed, "model") }
    }
  } catch {
    // Not (yet) JSON — keep peeking.
  }
  return null
}

// ---- the slice of the OpenCode v2 plugin context the plugin touches --------

type Registration = { dispose: () => Promise<void> }

// The rpc.register return: disposal plus the event emitter the command's
// execute publishes the report through.
type RpcRegistration = Registration & {
  events: { emit(name: string, data: unknown): Promise<void> }
}

// The editor slice the alias applier touches (§8): `get` returns the concrete
// model's immutable definition; `update` mutates (or creates) one model.
export type AliasEditor = {
  get(providerID: string, modelID: string): AliasConcrete | undefined
  update(providerID: string, modelID: string, update: (model: AliasModel) => void): void
}

type AliasConcrete = {
  capabilities: unknown
  limit: unknown
  cost: unknown
  variants: unknown
  time: unknown
  status: unknown
}

type AliasModel = AliasConcrete & {
  modelID?: string
  name: string
  enabled: boolean
}

export type CommandDefinition = {
  name: string
  description?: string
  execute: (input: { sessionID: string; prompt: { text: string } }) => Promise<void>
}

// The `http.request` / `http.response` event (§9): the guard keys on the
// requesting agent, not on event.model, which already shows the effective
// (fallback) reference. `response` is present only on http.response events
// (the real SDK carries both hook events' shapes; only the response's hook
// receives one) — and it must stay MUTABLE: the capture hook re-creates the
// Response around a pass-through stream and writes it back.
export type HttpEvent = {
  sessionID: string
  agent: string
  model: ModelRef
  kind: "primary" | "compaction" | "title" | "generate"
  request: unknown
  response?: Response
}

export type ModelListEntry = { id: string; providerID: string; enabled: boolean }

export type PluginCtx = {
  options: unknown
  app: { version: string }
  storage: Storage
  model: {
    transform(callback: (editor: AliasEditor) => void): Promise<Registration>
    // The real client returns a promise; a plain value is tolerated too.
    list():
      | Promise<{ location: unknown; data: ModelListEntry[] }>
      | { location: unknown; data: ModelListEntry[] }
    reload(): Promise<void>
  }
  provider: { reload(): Promise<void> }
  agent: {
    get(input: { agentID: string }): Promise<{ location: unknown; data: { model?: ModelRef } }>
    reload(): Promise<void>
  }
  session: {
    hook(
      name: "http.request" | "http.response",
      callback: (event: HttpEvent) => Promise<void> | void,
    ): Promise<Registration>
    switchModel(input: { sessionID: string; model: ModelRef }): Promise<void>
    // `resume: false` records the notice without scheduling a model turn.
    synthetic(input: { sessionID: string; text: string; resume?: boolean | null }): Promise<unknown>
  }
  command: {
    transform(
      callback: (editor: { add(definition: CommandDefinition): void }) => void,
    ): Promise<Registration>
  }
  rpc: {
    register(
      definition: { id: string },
      handlers: Record<string, (input: unknown) => Promise<unknown> | unknown>,
    ): Promise<RpcRegistration>
  }
}

export type WireDeps = {
  acquire?: typeof acquire
  setInterval?: (fn: () => void, ms: number) => () => void
  now?: () => number
  // Per-tick hard deadline (F-01); tests shrink it.
  deadlineMs?: number
  // State-observation seam (tests): hands the LIVE WireState object to the
  // caller once setup finishes wiring it — every later mutation (steering
  // records, endpoint captures) lands on the same object, so the holder sees
  // the updates in real time. Nothing in production passes it.
  onState?: (state: WireState) => void
}

// ---- captured state and small helpers --------------------------------------

// The picks and enabled flags a registry state is built from.
export type AliasPlan = {
  picks: Partial<Record<Priority, AliasTarget>>
  enabled: Partial<Record<Priority, boolean>>
}

// The mutable state the registrations capture (§8). Two views of the picks:
//   - `plan` is the DESIRED registry state: the alias transform reads it at
//     every replay, so a reload always serves the newest plan;
//   - `picks`/`enabled` are the APPLIED view — what the registry is known to
//     serve: the guard and the commands read it. The tick advances it only
//     after the reload chain succeeded, so a failed reload is never reported
//     to users as a change that happened (and is retried by the next tick).
// `registryDisabled[p]` records that the transform wanted alias p enabled but
// its concrete model was missing from the editor; the applied view then says
// disabled, whatever the plan wanted.
//
// `appliedSteering[sessionID]` records the steering order the request hook
// ACTUALLY injected into that session's most recent request: the order array
// when it injected (catalog-projected blocks always carry a non-empty order),
// null when it did not (non-alias ref, no steering data, a pre-existing body
// `provider`, or any failure — fail open). The response hook consumes it as
// captureEndpoint's `order`, so the `!` downgrade flag fires only when a
// non-empty order was really applied. Last request per session wins.
//
// `lastEndpoints[sessionID]` records the served-endpoint capture for that
// session's most recent primary response: the served `provider` string
// verbatim, the response's concrete `model` id, the downgrade verdict, and
// the wall-clock moment of the capture. Last-writer-wins WITHIN a session
// (hook invocations interleave concurrently — every write is per-event, from
// the event's own sessionID); stale entries for ended sessions are
// acceptable (no session-removal hook exists to prune them).
export type WireState = {
  sourced: Sourced | null
  pins: Partial<Record<Priority, Pin>>
  picks: Partial<Record<Priority, AliasTarget>>
  enabled: Partial<Record<Priority, boolean>>
  plan: AliasPlan
  registryDisabled: Partial<Record<Priority, boolean>>
  appliedSteering: Record<string, string[] | null>
  lastEndpoints: Record<string, EndpointCapture>
}

// readRecord only guarantees a v=1 object; the pin fields are checked so a
// garbage record warns and is ignored instead of poisoning resolution (§7.2).
// The id must be non-empty and `since` a FINITE number — JSON.parse("1e999")
// and hand-edited records can carry Infinity, which would make every
// pin-expiry comparison (now - since) NaN.
function isValidPin(value: Pin): boolean {
  return (
    typeof value.id === "string" &&
    value.id !== "" &&
    typeof value.since === "number" &&
    Number.isFinite(value.since)
  )
}

// ---- the alias transform (design §8) ---------------------------------------

// The applier: computes each alias's plan from the captured state and copies
// the concrete model's identity fields onto the alias. A missing pick or a
// pick whose model is gone from the editor DISABLES the alias with a warning —
// never silently skipped (§8). Deep-copies via structuredClone to avoid
// aliasing the concrete model's objects.
function applyAliases(state: WireState, editor: AliasEditor): void {
  for (const p of PRIORITIES) {
    const target: AliasTarget = state.plan.picks[p] ?? { id: null, fromFallback: false }
    // The editor's concrete definition doubles as the presence proof for the
    // plan: planAlias only checks for undefined (it never reads model
    // internals — the applier does, below).
    const source = target.id === null ? undefined : editor.get(ALIAS_PROVIDER, target.id)
    const plan = planAlias(p, target, source as unknown as ModelEntry | undefined)

    if (plan.enabled && plan.modelID !== null && source !== undefined) {
      editor.update(ALIAS_PROVIDER, aliasId(p), (model) => {
        model.modelID = plan.modelID as string
        model.name = plan.name
        model.enabled = true
        model.capabilities = structuredClone(source.capabilities)
        model.limit = structuredClone(source.limit)
        model.cost = structuredClone(source.cost)
        model.variants = structuredClone(source.variants)
        model.time = structuredClone(source.time)
        model.status = source.status
      })
      state.registryDisabled[p] = false
    } else {
      // The plan wanted this alias enabled but the concrete model is gone:
      // the registry now disables it, so the guard and /use-best must agree.
      const wanted = target.id !== null
      state.registryDisabled[p] = wanted
      if (wanted) state.enabled[p] = false
      editor.update(ALIAS_PROVIDER, aliasId(p), (model) => {
        // modelID stays as-is; only the display name and the flag change.
        model.enabled = false
        model.name = plan.name
      })
      for (const warning of plan.warnings) console.warn("[model-compare]", warning)
    }
  }
}

// ---- setup -----------------------------------------------------------------

export async function wire(ctx: PluginCtx, deps: WireDeps = {}): Promise<() => void> {
  const doAcquire = deps.acquire ?? acquire
  const now = deps.now ?? Date.now

  // §3: every option violation warns and defaults; parseConfig never throws.
  const { config, warnings } = parseConfig(ctx.options)
  for (const warning of warnings) console.warn("[model-compare]", warning)

  const state: WireState = {
    sourced: null,
    pins: {},
    picks: {},
    enabled: {},
    plan: { picks: {}, enabled: {} },
    registryDisabled: {},
    appliedSteering: {},
    lastEndpoints: {},
  }
  // Test seam: hand the live state object out BEFORE any registration can
  // mutate it — the reference never changes, only its contents do.
  deps.onState?.(state)

  // Seed state from storage (§8 startup) BEFORE registering the transform:
  // OpenCode applies transforms at registration time (design-spike-verified),
  // so the first application must already see the seeded picks. Registering
  // first would compute every alias from empty state, and a warm start whose
  // first tick resolves the same picks then never reloads — the registry's
  // aliases stay disabled while state.enabled says enabled. This needs only
  // storage + ctx.model.list(); acquire is NOT awaited here.
  //
  // The seed is the §9 chain WITHOUT a fresh catalog — the same resolution
  // the tick falls back to when a refresh fails (planPicks with doc: null):
  // stored pin if runnable → configured fallback if runnable → disabled.
  try {
    const cached = await readNewestCachedDoc(ctx.storage, cacheIdentities(config))
    if (cached !== null) {
      // Warm start: read the pins — keyed by the effective weights of the
      // cached document, since without fresh ranking the weights are
      // unknowable.
      state.sourced = cached
      for (const p of PRIORITIES) {
        const key = pinKey(p, effectiveWeights(cached.doc, p, config.weights[p]).weights)
        const record = await readRecord<Pin>(ctx.storage, key)
        if (record !== null && !isValidPin(record)) {
          console.warn("[model-compare]", `corrupt pin record for ${p} (${key}); ignoring it`)
          continue
        }
        if (record !== null) state.pins[p] = record
      }
    }
    // The runnable set is only needed when something could use it.
    const needsRunnable = Object.keys(state.pins).length > 0 || config.fallback !== null
    const runnable = needsRunnable ? await runnableSet(ctx) : new Set<string>()
    const plan = planPicks({ config, doc: null, runnable, pins: state.pins, now: now() })
    adoptPlan(state, plan, true)
    for (const notice of plan.notices) console.warn("[model-compare]", notice)

    if (cached !== null) {
      warnDisabledAliases(state.enabled, "startup")
    } else {
      // Cold start: the pin keys hash the effective weights of a catalog we
      // don't have, so the chain starts at the configured fallback. It is
      // never stored as a pin (§7.8).
      const bare = config.fallback === null ? null : bareModelId(config.fallback)
      if (bare !== null && state.enabled.balanced === true) {
        console.warn(
          "[model-compare]",
          `no cached ranking; aliases start on the configured fallback ${bare}`,
        )
      } else if (bare !== null) {
        console.warn(
          "[model-compare]",
          `no cached ranking; startup fallback ${bare} is not runnable; aliases disabled until first refresh`,
        )
      } else {
        console.warn("[model-compare]", "no cached ranking; aliases disabled until first refresh")
      }
    }
  } catch (error) {
    // Storage problems degrade to the disabled state, never break setup (§9).
    console.error("[model-compare]", error)
  }

  // Register the model transform (§8): aliases are computed inside the
  // transform from the captured state, so any replay applies the current pick.
  await ctx.model.transform((editor) => applyAliases(state, editor))

  // The guard (§9): a primary request whose agent is configured with a
  // DISABLED alias aborts with the exact error; everything else passes. The
  // agent lookup is wrapped — a missing agent must not break the request path.
  await ctx.session.hook("http.request", async (event) => {
    let agentModel: ModelRef | undefined
    try {
      const agent = await ctx.agent.get({ agentID: event.agent })
      agentModel = agent.data?.model
    } catch {
      agentModel = undefined
    }
    const decision = guardDecision(event.kind, agentModel, (p) => state.enabled[p] === true)
    if (decision.error !== undefined) throw new Error(decision.error)
  })

  // The steering injection (design §Steering injection; spike fact 2):
  // alias-scoped requests whose pick's catalog entry carries a steering block
  // get the block's provider sub-object injected into the JSON body and the
  // Request re-created. No kind filter — alias-bound refs arrive for primary
  // AND compaction (spike scoping), and a directly-picked ref is never an
  // alias ref, so it falls through untouched (the anti-goal). Every path
  // that does not inject leaves the original request untouched (fail open,
  // spec anti-goal) and nulls the session's appliedSteering record.
  await ctx.session.hook("http.request", async (event) => {
    try {
      // Cheap gate before any body read (the guard's parseAliasRef rule;
      // steeringFor re-checks variant-blind): concrete refs — title kinds,
      // direct picks, fallback-bound sessions — skip the body entirely.
      if (parseAliasRef(event.model) === null || state.sourced === null) {
        state.appliedSteering[event.sessionID] = null
        return
      }
      const request = event.request as Request
      let body: unknown
      try {
        body = JSON.parse(await request.clone().text())
      } catch {
        // No JSON body (or unreadable): untouched, fail open.
        state.appliedSteering[event.sessionID] = null
        return
      }
      const steering = steeringFor(
        event.model,
        bodyModelOf(body),
        state.picks,
        new Map(state.sourced.doc.models.map((entry): [string, ModelEntry] => [entry.id, entry])),
      )
      if (steering === null) {
        // No steering data for the pick: untouched, fail open.
        state.appliedSteering[event.sessionID] = null
        return
      }
      const modified = injectSteering(body, steering)
      if (modified === body) {
        // The body already carries a `provider` key (or is not an object):
        // never clobber routing the user or a provider configured.
        state.appliedSteering[event.sessionID] = null
        return
      }
      // Spike fact 2's verified recipe: re-create the Request around the
      // modified body, dropping the stale length/encoding headers (the
      // runtime re-derives content-length for the new body).
      const headers = new Headers(request.headers)
      headers.delete("content-length")
      headers.delete("content-encoding")
      event.request = new Request(request.url, {
        method: request.method,
        headers,
        body: JSON.stringify(modified),
      })
      // Record the order actually applied — the response hook reads it as
      // captureEndpoint's order (the `!` flag fires only on a non-empty one).
      state.appliedSteering[event.sessionID] = steering.order
    } catch {
      // Fail open: any error leaves the original request proceeding
      // untouched, and records that nothing was injected.
      state.appliedSteering[event.sessionID] = null
    }
  })

  // The response capture (design §Steering visibility): a primary response's
  // first few bytes are peeked THROUGH a pass-through transform (never
  // buffered or consumed — the peeked chunks are forwarded untouched, so the
  // rest of the body flows byte-for-byte) to read the served `provider` and
  // `model`, and the session's lastEndpoints record is written per-event from
  // the event's OWN sessionID (hook invocations interleave concurrently —
  // never write from a shared "current session"). Only primary responses
  // update the capture; any body the peek cannot parse passes through
  // unmodified, uncaptured; every error is swallowed — the capture is
  // best-effort and must never break the response itself.
  await ctx.session.hook("http.response", async (event) => {
    try {
      if (event.kind !== "primary") return
      const response = event.response
      if (response === undefined) return
      const body = response.body
      if (body === null) return

      // Read ONCE, per-event, from the event's own sessionID. Task 4's
      // last-wins-per-session sequencing assumption applies: this order is
      // the session's most recent REQUEST's order, assumed to precede its
      // response — a same-session response arriving after a NEWER request's
      // injection would read the newer order (accepted; the capture stays
      // best-effort, and non-injection paths null the record so a stale read
      // degrades to "no verdict", never a wrong downgrade).
      const order = state.appliedSteering[event.sessionID] ?? null

      const decoder = new TextDecoder()
      let captured = ""
      let peekedBytes = 0
      let done = false
      const record = (provider: string | null, model: string | null) => {
        done = true
        // Nothing to show (no provider at all, or a name with no provider
        // part): treat as no capture — captureEndpoint's endpoint === null
        // means exactly that.
        if (provider === null) return
        const verdict = captureEndpoint(provider, order)
        if (verdict.endpoint === null) return
        state.lastEndpoints[event.sessionID] = {
          sessionID: event.sessionID,
          endpoint: verdict.endpoint,
          // The spike established OpenRouter responses always carry `model`;
          // an outlier without one still records the endpoint (the capture's
          // point), with an empty id standing in for the missing field.
          model: model ?? "",
          downgrade: verdict.downgrade,
          at: now(),
        }
      }
      const inspect = () => {
        const peek = extractServedFields(captured)
        if (peek !== null) record(peek.provider, peek.model)
      }
      const transform = new TransformStream<Uint8Array, Uint8Array>({
        transform: (chunk, controller) => {
          try {
            if (!done) {
              // The peek is byte-bounded: only the first PEEK_MAX_BYTES
              // bytes of the stream are ever decoded for inspection — a
              // chunk that crosses the bound contributes only its head, and
              // the rest is never decoded (it still passes through
              // untouched, below).
              const take = Math.min(chunk.byteLength, PEEK_MAX_BYTES - peekedBytes)
              if (take > 0) captured += decoder.decode(chunk.subarray(0, take), { stream: true })
              peekedBytes += take
              // Extraction runs on every peeked chunk: a first chunk that is
              // only a comment line must not conclude anything — the data
              // line may arrive in a later chunk (spike fact 5).
              inspect()
              if (peekedBytes >= PEEK_MAX_BYTES) done = true
            }
          } catch {
            // Inspection never breaks the stream: give up on the peek, keep
            // forwarding.
            done = true
          }
          controller.enqueue(chunk)
        },
        flush: () => {
          try {
            if (!done) {
              // The stream ended before the bound: flush any held-back
              // multi-byte tail and make one final extraction attempt.
              captured += decoder.decode()
              inspect()
            }
          } catch {
            done = true
          }
        },
      })
      // Re-create the Response around the pass-through stream (mirror of the
      // request hook's re-creation): the original body is owned by the chain
      // and never consumed by the plugin.
      event.response = new Response(body.pipeThrough(transform), {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      })
    } catch {
      // Fail open: any error leaves the response untouched and uncaptured.
    }
  })

  // The RPC (V2 plugins RPC): the report method serves the SAME text the
  // /model-compare command synthesizes (one builder — the two can never
  // drift), and the registration carries the report EVENT the command emits
  // so the TUI half can open the report as an instant selectable dialog.
  // Registered BEFORE the commands: the command's execute emits through it.
  const rpcRegistration = await ctx.rpc.register(ModelCompare, {
    report: async () => {
      const ranks = reportRanks()
      if (state.sourced === null || ranks === null) {
        return { text: "model-compare: no ranking data available yet", age: null, entries: [] }
      }
      return {
        text: formatReport(state.sourced, ranks, { picks: state.picks, overrides: config.weights }),
        age: humanizeAge(Date.now() - state.sourced.acquiredAt),
        entries: reportEntries(state.sourced, ranks, { picks: state.picks, overrides: config.weights }),
      }
    },
  })

  // The report behind /model-compare: the text (transcript + the RPC's
  // report method) and the structured entries (the RPC's report method and
  // event — the TUI renders them as a selectable dialog). One ranking, so
  // the text, the entries and the picks can never disagree. Ranks under the
  // same weights overrides the aliases resolve with, so the report agrees
  // with the picks.
  const reportRanks = () => {
    if (state.sourced === null) return null
    const doc = state.sourced.doc
    return {
      balanced: rankModels(doc, "balanced", config.weights.balanced).ids,
      price: rankModels(doc, "price", config.weights.price).ids,
      quality: rankModels(doc, "quality", config.weights.quality).ids,
    }
  }

  // The commands (§10).
  await ctx.command.transform((editor) => {
    editor.add({
      name: "use-best",
      description: "Switch this session to a model-compare priority (balanced, price or quality)",
      execute: async ({ sessionID, prompt }) => {
        const decision = useBestDecision({
          argument: prompt.text,
          defaultPriority: config.defaultPriority,
          enabled: (p) => state.enabled[p] === true,
        })
        if (!decision.ok) {
          await ctx.session.synthetic({ sessionID, text: decision.message, resume: false })
          return
        }
        const p = decision.priority
        await ctx.session.switchModel({
          sessionID,
          model: { providerID: ALIAS_PROVIDER, id: aliasId(p) },
        })
        const pickId = state.picks[p]?.id ?? null
        try {
          await ctx.session.synthetic({
            sessionID,
            text: useBestNotice(p, pickId),
            resume: false,
          })
        } catch {
          // The switch already happened; the notice is best-effort.
        }
      },
    })
    editor.add({
      name: "model-compare",
      description: "Show the top 5 models per priority with scores and data age",
      execute: async ({ sessionID }) => {
        // Snapshot the catalog once, before anything awaits: the event
        // emission and the synthetic's admission leave gaps in which a
        // refresh can swap state.sourced, and the event's entries and the
        // transcript text must come from the SAME document.
        const sourced = state.sourced
        const ranks = reportRanks()
        // The EVENT goes first: the TUI's instant dialog must not wait behind
        // the synthetic's admission, which measures ~8 s in this build (the
        // transcript notice is the durable copy, not the fast path).
        if (sourced === null || ranks === null) {
          try {
            await rpcRegistration.events.emit("report", { sessionID, age: null, entries: [] })
          } catch {
            // Emission failures must not fail the command.
          }
          await ctx.session.synthetic({
            sessionID,
            text: "model-compare: no ranking data available yet",
            resume: false,
          })
          return
        }
        const context = { picks: state.picks, overrides: config.weights }
        try {
          await rpcRegistration.events.emit("report", {
            sessionID,
            age: humanizeAge(Date.now() - sourced.acquiredAt),
            entries: reportEntries(sourced, ranks, context),
          })
        } catch {
          // Emission failures must not fail the command.
        }
        await ctx.session.synthetic({
          sessionID,
          text: formatReport(sourced, ranks, context),
          resume: false,
        })
      },
    })
  })

  // The refresh tick (§8, §9), scheduled every 30 minutes — and, per §8, the
  // FIRST refresh starts right here in the background: a cold start with
  // working network must not wait 30 minutes for its aliases. Not awaited;
  // the tick's non-overlap guard keeps the kick-off and the timer from
  // colliding, and its catch-all keeps failures from escaping setup.
  const tick = createTick(ctx, config, state, {
    acquire: doAcquire,
    now,
    deadlineMs: deps.deadlineMs,
  })
  const cancelTimer =
    deps.setInterval !== undefined
      ? deps.setInterval(tick, REFRESH_MS)
      : (() => {
          const handle = setInterval(tick, REFRESH_MS)
          return () => clearInterval(handle)
        })()
  void tick()

  // Registrations are cleaned up by OpenCode on unload; only the timer is ours.
  return () => {
    cancelTimer()
  }
}

export default Plugin.define({
  id: "model-compare",
  async setup(ctx) {
    return wire(ctx as unknown as PluginCtx, {})
  },
})

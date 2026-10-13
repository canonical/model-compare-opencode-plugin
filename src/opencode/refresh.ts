// src/opencode/refresh.ts
// The 30-minute refresh tick (design §8, §9). One pass:
//   1. acquire fresh data; on failure keep going WITHOUT a catalog, so §9's
//      chain (stored pin if runnable → fallback if runnable → none) is
//      re-evaluated against what OpenRouter lists right now;
//   2. compute the next picks as a pure plan (resolution.ts) — nothing is
//      mutated yet;
//   3. persist pin records and the doc cache; a storage failure aborts the
//      pass with the state untouched, so the next pass redoes it;
//   4. publish the plan to the alias transform, replay it via the
//      spike-verified provider→model→agent reloads, and only THEN mark it as
//      applied. A reload that throws leaves the applied view (what the guard
//      and /use-best read) on the old picks, so the next tick sees a
//      difference and retries the reload.
// The tick never overlaps itself, is bounded by a hard deadline, and its
// errors are logged, never thrown: the timer must not die.

import type { Config } from "../config"
import type { Priority } from "../core/types"
import { writeCachedDoc, writeRecord } from "./storage"
import { PRIORITIES, planPicks, type PickPlan } from "./resolution"
import type { Acquired, acquire } from "../sources"
import type { PluginCtx, WireState } from "../index"

const ALIAS_PROVIDER = "openrouter"
export const REFRESH_MS = 1_800_000 // 30 minutes (design §8)
// Hard ceiling for one whole tick (F-01). It must outlast the legitimate worst
// case: the probe (10 s) + the script (60 s) + the provider→model→agent reload
// chain, which the integration harness measured at 90-105 s. Past it the tick
// is abandoned and the non-overlap guard is released.
export const TICK_DEADLINE_MS = 180_000

// The ids OpenRouter currently lists as enabled models — the runnable set
// resolution checks candidates against (§7.1). Also used at setup to decide
// which stored pins may enable their alias and whether the configured
// fallback is runnable.
export async function runnableSet(ctx: PluginCtx): Promise<Set<string>> {
  const listed = await ctx.model.list()
  const set = new Set<string>()
  for (const model of listed.data) {
    if (model.providerID === ALIAS_PROVIDER && model.enabled !== false) set.add(model.id)
  }
  return set
}

// One warning per refresh when any alias is disabled (§9): sessions on it —
// root default or /use-best — fall back to OpenCode's own choice silently.
export function warnDisabledAliases(
  enabled: Partial<Record<Priority, boolean>>,
  when: string,
): void {
  const disabled = PRIORITIES.filter((p) => enabled[p] !== true)
  if (disabled.length === 0) return
  console.warn(
    "[model-compare]",
    `${when}: aliases disabled (sessions on them fall back to OpenCode's own choice): ${disabled
      .map((p) => `${ALIAS_PROVIDER}/model-compare/${p}`)
      .join(", ")}`,
  )
}

// Publishes a plan as both the desired registry state (read by the alias
// transform) and — at setup, where registration applies it immediately — the
// applied view.
export function adoptPlan(state: WireState, plan: PickPlan, applied: boolean): void {
  state.plan = { picks: { ...plan.picks }, enabled: { ...plan.enabled } }
  state.pins = { ...plan.pins }
  if (applied) commitApplied(state, plan)
}

// The registry now serves `plan`: the applied view follows, except for aliases
// the transform found it could not enable (concrete model gone from the
// editor) — those stay disabled for the guard and /use-best.
export function commitApplied(state: WireState, plan: PickPlan): void {
  state.picks = { ...plan.picks }
  state.enabled = { ...plan.enabled }
  for (const p of PRIORITIES) if (state.registryDisabled[p]) state.enabled[p] = false
}

// Does the plan differ from what the registry last applied? An alias the
// transform disabled by itself still counts as "applied as enabled": the plan
// wanted it and the registry did what it could.
function differsFromApplied(state: WireState, plan: PickPlan): boolean {
  return PRIORITIES.some((p) => {
    const previous = state.picks[p]
    const appliedEnabled = state.enabled[p] === true || state.registryDisabled[p] === true
    return (
      (previous?.id ?? null) !== plan.picks[p].id ||
      (previous?.fromFallback ?? false) !== plan.picks[p].fromFallback ||
      appliedEnabled !== plan.enabled[p]
    )
  })
}

// Builds the tick. The refreshing flag lives in this closure so consecutive
// invocations never overlap (§8); the caller only schedules and cancels it.
export function createTick(
  ctx: PluginCtx,
  config: Config,
  state: WireState,
  deps: { acquire: typeof acquire; now: () => number; deadlineMs?: number },
): () => Promise<void> {
  let refreshing = false
  return async () => {
    if (refreshing) return
    refreshing = true
    // An abandoned body (deadline hit) must not touch state if it ever wakes.
    const run = { abandoned: false }
    const deadlineMs = deps.deadlineMs ?? TICK_DEADLINE_MS
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        run.abandoned = true
        reject(new Error(`refresh exceeded its ${deadlineMs}ms deadline; abandoning it`))
      }, deadlineMs)
    })
    try {
      await Promise.race([body(run), deadline])
    } catch (error) {
      console.error("[model-compare]", error)
    } finally {
      clearTimeout(timer)
      refreshing = false
    }
  }

  async function body(run: { abandoned: boolean }): Promise<void> {
    let result: Acquired | null = null
    try {
      result = await deps.acquire(config, { storage: ctx.storage })
      if (!result) throw new Error("the source returned no document")
    } catch (error) {
      // §9: no fresh catalog is not the end of the pass — fall through and
      // re-resolve pin → fallback → none against the current runnable set.
      result = null
      console.error("[model-compare]", error)
    }
    if (run.abandoned) return
    if (result) for (const warning of result.warnings) console.warn("[model-compare]", warning)

    const runnable = await runnableSet(ctx)
    const next = planPicks({
      config,
      doc: result?.sourced.doc ?? null,
      runnable,
      pins: state.pins,
      now: deps.now(),
    })
    for (const notice of next.notices) console.warn("[model-compare]", notice)

    // Persist before anything is published: a storage failure throws here,
    // with the state untouched, and the next tick simply redoes the pass.
    // The deadline may have fired while the runnable set was fetched: an
    // abandoned tick must not touch storage either (F-01 semantics —
    // abandoned means neither state nor storage is touched).
    if (run.abandoned) return
    if (result) {
      for (const { key, pin } of next.writes) await writeRecord(ctx.storage, key, pin)
      await writeCachedDoc(ctx.storage, result.identity, result.sourced)
    }
    if (run.abandoned) return

    const changed = differsFromApplied(state, next)
    if (result) state.sourced = result.sourced
    adoptPlan(state, next, false)
    warnDisabledAliases(next.enabled, "refresh")
    if (changed) {
      // The spike-verified replay order (§8, §15 item 1): provider first,
      // then model, then agent. A throw leaves the applied view stale on
      // purpose: the next tick's comparison fails again and retries.
      await ctx.provider.reload()
      await ctx.model.reload()
      await ctx.agent.reload()
    }
    // The reload chain is slow (measured 90-105 s) — the deadline can fire
    // in the middle of it. An abandoned tick must not commit its plan as
    // applied: the applied view (the guard, /use-best) stays on the old
    // picks, and the next tick's comparison retries the reload.
    if (run.abandoned) return
    commitApplied(state, next)
    console.warn(
      "[model-compare]",
      result
        ? `refresh complete: source=${result.source} fromCache=${result.fromCache} changed=${changed}`
        : `refresh failed; resolved without a fresh catalog: changed=${changed}`,
    )
  }
}

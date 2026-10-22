// tests/integration/probe/index.ts
// Observation plugin for the live integration suite (Task 13). Loaded by the
// scratch project's opencode.jsonc alongside the model-compare plugin. It
// appends one JSON line per event to tests/integration/wire.jsonl:
//
//   { type: "setup",   version }                   — once per server instance
//   { type: "options", options }                   — the plugin context's
//                                                  options object, logged once
//                                                  at setup (delivery probe:
//                                                  whatever OpenCode handed the
//                                                  plugin, verbatim)
//   { type: "models",  openrouter: string[] }      — bare ids of openrouter's
//                                                  enabled models (logged at
//                                                  setup and again on the first
//                                                  request, when the registry
//                                                  is fully materialized)
//   { type: "request", sessionID, agent, kind,
//     eventModel, wire }                           — one per http.request;
//                                                  `wire` is the model field of
//                                                  the cloned request body —
//                                                  what the provider actually
//                                                  receives
//   { type: "response", sessionID, agent, kind,
//     status }                                     — one per http.response
//   { type: "alias-state", quality, balanced,
//     price }                                      — whenever the plugin's
//                                                  alias models change in
//                                                  ctx.model.list(): per
//                                                  priority { id, name,
//                                                  enabled, modelID } (modelID
//                                                  only when the registry
//                                                  exposes it). This is the
//                                                  refresh-completion signal:
//                                                  the plugin's console output
//                                                  provably reaches neither the
//                                                  server's stdio nor its log
//                                                  file, so the harness watches
//                                                  the alias state instead.
//   { type: "command", name, sessionID, text }     — /probe-echo invocations
//
// The probe is deliberately dumb: it only records. Assertions live in
// core-cases.test.mjs.

import { Plugin } from "@opencode/plugin"
import { appendFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import path from "node:path"

const WIRE_FILE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "wire.jsonl",
)

function log(entry: Record<string, unknown>): void {
  appendFileSync(WIRE_FILE, JSON.stringify({ t: new Date().toISOString(), ...entry }) + "\n")
}

export default Plugin.define({
  id: "integration-probe",
  async setup(ctx) {
    log({ type: "setup", version: ctx.app.version })
    log({ type: "options", options: ctx.options })

    const logModels = (when: string) => {
      try {
        const listed = (ctx as unknown as { model: { list(): Promise<unknown> } }).model.list()
        void Promise.resolve(listed).then((result) => {
          const data = (result as { data?: unknown }).data
          const models = Array.isArray(data) ? data : []
          const openrouter = models
            .filter((m) => (m as { providerID?: string }).providerID === "openrouter")
            .filter((m) => (m as { enabled?: boolean }).enabled !== false)
            .map((m) => (m as { id: string }).id)
          log({ type: "models", when, openrouter })
        })
      } catch (error) {
        log({ type: "models.error", when, error: String(error).slice(0, 300) })
      }
    }
    logModels("setup")

    // Alias-state poller (the refresh-completion signal): snapshots the
    // plugin's alias models out of ctx.model.list() and logs a line whenever
    // the snapshot changes — including the very first one. The plugin's
    // console.warn provably reaches neither the server's stdio (serve writes
    // nothing there, even with --print-logs) nor the shared opencode log, so
    // the harness detects "the first refresh has landed" purely through this
    // observed alias state.
    let lastAliases: string | null = null
    const pollTimer = setInterval(() => {
      void (async () => {
        try {
          const listed = await (
            ctx as unknown as { model: { list(): Promise<unknown> } }
          ).model.list()
          const data = (listed as { data?: unknown }).data
          const models = Array.isArray(data) ? data : []
          const aliases = models
            .filter(
              (m) =>
                (m as { providerID?: string }).providerID === "openrouter" &&
                String((m as { id?: string }).id ?? "").startsWith("model-compare/"),
            )
            .map((m) => {
              const entry = m as Record<string, unknown>
              return {
                id: entry.id,
                name: entry.name,
                enabled: entry.enabled,
                ...(typeof entry.modelID === "string" ? { modelID: entry.modelID } : {}),
              }
            })
            .sort((x, y) => String(x.id).localeCompare(String(y.id)))
          const snapshot = JSON.stringify(aliases)
          if (snapshot !== lastAliases) {
            lastAliases = snapshot
            log({ type: "alias-state", aliases })
          }
        } catch {
          // Registry not ready yet — the next tick retries.
        }
      })()
    }, 300)

    let loggedModelsOnRequest = false
    await ctx.session.hook("http.request", async (event) => {
      if (!loggedModelsOnRequest) {
        loggedModelsOnRequest = true
        logModels("first-request")
      }
      let wire: unknown = null
      try {
        wire = JSON.parse(await event.request.clone().text()).model ?? null
      } catch {
        wire = null
      }
      log({
        type: "request",
        sessionID: event.sessionID,
        agent: event.agent,
        kind: event.kind,
        eventModel: event.model ?? null,
        wire,
      })
    })

    await ctx.session.hook("http.response", async (event) => {
      log({
        type: "response",
        sessionID: event.sessionID,
        agent: event.agent,
        kind: event.kind,
        status: event.response?.status ?? null,
      })
    })

    await ctx.command.transform((editor) => {
      editor.add({
        name: "probe-echo",
        description: "Integration probe: log the prompt text to wire.jsonl",
        execute: async ({ sessionID, prompt }) => {
          log({ type: "command", name: "probe-echo", sessionID, text: prompt.text })
        },
      })
    })

    return () => {
      clearInterval(pollTimer)
    }
  },
})
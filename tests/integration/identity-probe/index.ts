// tests/integration/identity-probe/index.ts
// Permanent Request-identity guard probe for WeakMap<Request, ...> correlation.
// Loaded AFTER model-compare only when renderProjectConfig enables
// `{ identityProbe: true }`. Logs exclusively under `type: "identity-probe"` in
// wire.jsonl (never `"setup"`, `"request"`, or `"response"`, keeping
// core-cases.test.mjs and ops-cases.test.mjs isolated).
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

type SeenRequest = {
  hasProvider: boolean
  providerOrder: string[] | null
}

export default Plugin.define({
  id: "identity-probe",
  async setup(ctx) {
    const finalRequests = new WeakMap<Request, SeenRequest>()

    await ctx.session.hook("http.request", async (event) => {
      const request = event.request
      let hasProvider = false
      let providerOrder: string[] | null = null
      try {
        const body = JSON.parse(await request.clone().text()) as Record<string, unknown>
        const provider = body.provider
        if (typeof provider === "object" && provider !== null && !Array.isArray(provider)) {
          hasProvider = true
          const order = (provider as Record<string, unknown>).order
          if (Array.isArray(order) && order.every((item) => typeof item === "string")) {
            providerOrder = order as string[]
          }
        }
      } catch {
        // Unparseable request body leaves hasProvider: false.
      }
      finalRequests.set(request, { hasProvider, providerOrder })
    })

    await ctx.session.hook("http.response", async (event) => {
      const seen = finalRequests.get(event.request)
      log({
        type: "identity-probe",
        sessionID: event.sessionID,
        agent: event.agent,
        kind: event.kind,
        status: event.response?.status ?? null,
        sameAsFinal: seen !== undefined,
        hasProvider: seen?.hasProvider ?? false,
        providerOrder: seen?.providerOrder ?? null,
      })
    })
  },
})

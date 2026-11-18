// tests/integration/identity-probe.test.mjs
// Permanent live-server Request-identity guard for WeakMap<Request, ...>
// correlation between `http.request` and `http.response`.
//
// If an OpenCode SDK update stops handing `http.response` the exact Request
// object that `model-compare`'s `http.request` hook last assigned, WeakMap
// correlation would silently degrade to `steering: unknown`. This test fails
// loudly instead.
//
// Opt-in: MC_INTEGRATION=1 npx vitest run tests/integration/identity-probe.test.mjs
import { afterAll, beforeAll, describe, expect, test } from "vitest"
import * as h from "./harness.mjs"

const enabled = process.env.MC_INTEGRATION === "1"
const missing = [!h.hasOpencode && "the opencode CLI", !h.hasPython3 && "python3"].filter(Boolean)
const skipReason =
  !enabled
    ? "opt-in suite: run with MC_INTEGRATION=1 (drives a live opencode server on 127.0.0.1:14721)"
    : missing.length > 0
      ? `missing prerequisites: ${missing.join(", ")}`
      : null
if (skipReason !== null) console.warn(`[model-compare identity-probe] SKIPPED — ${skipReason}`)

const suite = skipReason === null ? describe : describe.skip

function context(result) {
  return JSON.stringify(
    {
      result,
      wireTail: h.wireTail(2500),
      serverLogTail: h.serverLogTail(2500),
    },
    null,
    2,
  )
}

suite("model-compare integration: Request identity across http.request and http.response", () => {
  beforeAll(async () => {
    await h.setFixture("steered", { identityProbe: true })
  }, 300_000)

  afterAll(async () => {
    await h.finalCleanup()
  }, 120_000)

  test(
    "http.response receives the exact post-injection Request object assigned in http.request",
    async () => {
      h.truncateWire()
      const result = h.run(["--agent", "mc-sub", "Reply with exactly: pong"])
      await h.settle()
      expect(result.ok, `run failed\n${context(result)}`).toBe(true)

      const pickId = h.expectedPick("steered", "quality")
      const steeredDoc = h.fixtureVariants().steered
      const pickModel = steeredDoc.models.find((m) => m.id === pickId)
      const expectedOrder = pickModel?.steering?.provider?.order ?? null
      expect(expectedOrder, `expected steered pick ${pickId} to carry a non-empty order`).not.toBeNull()

      const entries = h
        .readWire()
        .filter((e) => e.type === "identity-probe" && e.kind === "primary")
      expect(
        entries.length,
        `expected at least one primary identity-probe observation\n${context(result)}`,
      ).toBeGreaterThan(0)

      for (const entry of entries) {
        expect(entry.status, `unexpected status\n${context(result)}`).toBe(200)
        expect(entry.hasProvider, `expected injected provider block\n${context(result)}`).toBe(true)
        expect(entry.providerOrder, `expected injected steering order\n${context(result)}`).toEqual(
          expectedOrder,
        )
        expect(
          entry.sameAsFinal,
          `http.response did not receive the post-injection Request object\n${context(result)}`,
        ).toBe(true)
      }
    },
    240_000,
  )
})

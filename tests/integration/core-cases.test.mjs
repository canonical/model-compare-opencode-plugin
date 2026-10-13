// tests/integration/core-cases.test.mjs
// Live integration cases for the model-compare plugin (Task 13, spec §13):
// the first run of the plugin inside a real OpenCode server. The suite spawns
// a dedicated `opencode serve` in the scratch project (see harness.mjs) and
// asserts, through the probe plugin's wire.jsonl observations, that every
// dispatch carries the CURRENT fixture's pick after every state change.
//
// Cases (brief order):
//   1. agent dispatch — `--agent mc-sub` primary request wires to the fixture's
//      quality-top pick.
//   2. root default dispatch — a plain run's primary request wires to the same
//      pick (the root config IS the quality alias).
//   3. pick change — restart with the reversed-rankings fixture (B); both the
//      agent and the root run must wire to B's pick.
//   4. stale-dispatch regression — restart back to fixture A and re-check both
//      runs; the discipline "wire == the CURRENT fixture's pick after EVERY
//      state change" is applied by every case above and this one.
//   5. guard error — with the empty-catalog fixture (and the guard phase's
//      never-used pin key), `--agent mc-sub` aborts with the exact guard error
//      and no completed primary response reaches the provider.
//   6. never-seen agent — same empty state, `--agent zzz-unseen`: the guard is
//      agent-agnostic.
//
// The suite drives real (tiny) model calls through the authenticated
// openrouter provider; the CATALOG always comes from the deterministic stub.
//
// Opt-in: set MC_INTEGRATION=1 (e.g.
//   MC_INTEGRATION=1 npx vitest run tests/integration/core-cases.test.mjs).
// Without it the file skips so plain `npm test` stays hermetic. It also skips
// when the opencode CLI or python3 is missing.

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
if (skipReason !== null) console.warn(`[model-compare integration] SKIPPED — ${skipReason}`)

const suite = skipReason === null ? describe : describe.skip

// Diagnostic bundle for assertion failures: the CLI result plus the tails of
// both observation surfaces (the server log is the debugging surface).
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

// Runs one dispatch and asserts the stale-dispatch discipline: every primary
// request the run produced for `agent` must wire to the CURRENT fixture's pick.
async function runAndAssertDispatch(cliArgs, agent, shape) {
  h.truncateWire()
  const result = h.run(cliArgs)
  await h.settle()
  const requests = h.primaryRequests(agent)
  expect(
    requests.length,
    `expected at least one primary http.request for agent "${agent}"\n${context(result)}`,
  ).toBeGreaterThan(0)
  const expected = h.expectedPick(shape, "quality")
  for (const request of requests) {
    expect(
      request.wire,
      `agent "${agent}" primary request wired ${JSON.stringify(request.wire)}, ` +
        `expected the fixture "${shape}" pick ${JSON.stringify(expected)}\n${context(result)}`,
    ).toBe(expected)
  }
  console.log(
    `[wire evidence] fixture=${shape} agent=${agent} runs=${requests.length} ` +
      `wire=${JSON.stringify(requests[0].wire)} eventModel=${JSON.stringify(requests[0].eventModel)}`,
  )
  return { result, requests }
}

suite("model-compare integration: live OpenCode server (spec §13)", () => {
  beforeAll(async () => {
    await h.setFixture("a")
  }, 300_000)

  afterAll(async () => {
    await h.finalCleanup()
  }, 120_000)

  test(
    "case 1: agent dispatch — mc-sub wires to the fixture A quality pick",
    async () => {
      const { result } = await runAndAssertDispatch(
        ["--agent", "mc-sub", "Reply with exactly: pong"],
        "mc-sub",
        "a",
      )
      // The alias must have served the run, not OpenCode's own fallback.
      expect(result.ok, `run failed\n${context(result)}`).toBe(true)
    },
    240_000,
  )

  test(
    "case 2: root default dispatch — plain run wires to the same pick",
    async () => {
      const { result } = await runAndAssertDispatch(
        ["Reply with exactly: pong"],
        "build",
        "a",
      )
      expect(result.ok, `run failed\n${context(result)}`).toBe(true)
    },
    240_000,
  )

  test(
    "case 3: pick change — fixture B (reversed rankings) flips agent and root dispatch",
    async () => {
      await h.setFixture("b")
      const bPick = h.expectedPick("b", "quality")
      const aPick = h.expectedPick("a", "quality")
      expect(bPick, "fixture B must pick a different model than fixture A").not.toBe(aPick)

      const agent = await runAndAssertDispatch(
        ["--agent", "mc-sub", "Reply with exactly: pong"],
        "mc-sub",
        "b",
      )
      expect(agent.result.ok, `agent run failed\n${context(agent.result)}`).toBe(true)

      const root = await runAndAssertDispatch(
        ["Reply with exactly: pong"],
        "build",
        "b",
      )
      expect(root.result.ok, `root run failed\n${context(root.result)}`).toBe(true)
    },
    240_000,
  )

  test(
    "case 4: stale-dispatch regression — back to fixture A, both runs wire to A's pick again",
    async () => {
      await h.setFixture("a")
      const agent = await runAndAssertDispatch(
        ["--agent", "mc-sub", "Reply with exactly: pong"],
        "mc-sub",
        "a",
      )
      expect(agent.result.ok, `agent run failed\n${context(agent.result)}`).toBe(true)

      const root = await runAndAssertDispatch(
        ["Reply with exactly: pong"],
        "build",
        "a",
      )
      expect(root.result.ok, `root run failed\n${context(root.result)}`).toBe(true)
    },
    240_000,
  )

  test(
    "case 5: guard error — disabled alias aborts the mc-sub primary request with the exact error",
    async () => {
      await h.setFixture("empty")
      h.truncateWire()
      const result = h.run(["--agent", "mc-sub", "Reply with exactly: pong"])
      await h.settle()

      const output = `${result.stdout}\n${result.stderr}`
      const guardError =
        "model-compare: no ranking data for openrouter/model-compare/quality"
      expect(
        output,
        `expected the guard error text in the CLI output\n${context(result)}`,
      ).toContain(guardError)

      // The request reached the hook stage (the probe logs before the guard
      // runs) but no response came back: it aborted.
      const requests = h.primaryRequests("mc-sub")
      expect(
        requests.length,
        `expected the aborted primary request to be logged\n${context(result)}`,
      ).toBeGreaterThan(0)
      const responses = h.primaryResponses("mc-sub")
      expect(
        responses.length,
        `the aborted request must not complete\n${context(result)}`,
      ).toBe(0)
      console.log(
        `[guard evidence] agent=mc-sub requests=${requests.length} responses=${responses.length} ` +
          `eventModel=${JSON.stringify(requests[0].eventModel)}`,
      )
    },
    240_000,
  )

  test(
    "case 6: never-seen agent — the guard is agent-agnostic (zzz-unseen)",
    async () => {
      // Same server instance as case 5 (same empty state); only the agent id
      // differs — proving the guard keys on the agent's configured ref, not on
      // any specific agent.
      h.truncateWire()
      const result = h.run(["--agent", "zzz-unseen", "Reply with exactly: pong"])
      await h.settle()

      const output = `${result.stdout}\n${result.stderr}`
      const guardError =
        "model-compare: no ranking data for openrouter/model-compare/quality"
      expect(
        output,
        `expected the guard error text in the CLI output\n${context(result)}`,
      ).toContain(guardError)

      const requests = h.primaryRequests("zzz-unseen")
      expect(
        requests.length,
        `expected the aborted primary request to be logged\n${context(result)}`,
      ).toBeGreaterThan(0)
      const responses = h.primaryResponses("zzz-unseen")
      expect(
        responses.length,
        `the aborted request must not complete\n${context(result)}`,
      ).toBe(0)
      console.log(
        `[guard evidence] agent=zzz-unseen requests=${requests.length} responses=${responses.length} ` +
          `eventModel=${JSON.stringify(requests[0].eventModel)}`,
      )
    },
    240_000,
  )
})
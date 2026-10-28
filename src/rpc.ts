// src/rpc.ts
// The plugin's RPC surface (V2 plugins RPC): methods the TUI half and other
// clients can call on the server plugin, plus the event the /model-compare
// command emits. The report method returns the SAME text the command
// synthesizes — one builder in src/index.ts serves both, so the two can
// never drift. The report EVENT carries the structured entries (the TUI's
// selectable report dialog), because the transcript notice itself only
// surfaces at the session's next turn.
import { Rpc } from "@opencode/plugin/rpc"

// The capture record the report payload carries (the footer's last-response
// line and the alt+e toast's data): the served endpoint verbatim, the
// response's concrete model id (empty when the response had none), and the
// downgrade verdict. Null when nothing was captured for the session.
const captureSchema = {
  type: ["object", "null"],
  properties: {
    endpoint: { type: "string" },
    model: { type: "string" },
    downgrade: { type: "boolean" },
  },
  required: ["endpoint", "model", "downgrade"],
  additionalProperties: false,
} as const

export const ModelCompare = Rpc.define({
  id: "model-compare",
  methods: {
    report: {
      // The session whose capture the footer fields report: the TUI passes
      // the CURRENT session's id (null on the opening screen — no capture
      // can belong to no session). Optional for the opening screen's
      // existing `{}` calls.
      input: {
        type: "object",
        properties: { sessionID: { type: ["string", "null"] } },
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          text: { type: "string" },
          age: { type: ["string", "null"] },
          capture: captureSchema,
          steeringNote: { type: ["string", "null"] },
          entries: {
            type: "array",
            items: {
              type: "object",
              properties: {
                priority: { type: "string" },
                rank: { type: ["integer", "null"] },
                id: { type: "string" },
                value: { type: "string" },
                score: { type: "string" },
                quality: { type: "string" },
                effort: { type: "string" },
                alternative: { type: "string" },
                price: { type: "string" },
                current: { type: "boolean" },
                fromFallback: { type: "boolean" },
              },
              required: [
                "priority",
                "rank",
                "id",
                "value",
                "score",
                "quality",
                "effort",
                "alternative",
                "price",
                "current",
                "fromFallback",
              ],
              additionalProperties: false,
            },
          },
        },
        required: ["text", "age", "capture", "steeringNote", "entries"],
        additionalProperties: false,
      },
    },
  },
  events: {
    report: {
      schema: {
        type: "object",
        properties: {
          sessionID: { type: "string" },
          age: { type: ["string", "null"] },
          capture: captureSchema,
          steeringNote: { type: ["string", "null"] },
          entries: {
            type: "array",
            items: {
              type: "object",
              properties: {
                priority: { type: "string" },
                rank: { type: ["integer", "null"] },
                id: { type: "string" },
                value: { type: "string" },
                score: { type: "string" },
                quality: { type: "string" },
                effort: { type: "string" },
                alternative: { type: "string" },
                price: { type: "string" },
                current: { type: "boolean" },
                fromFallback: { type: "boolean" },
              },
              required: [
                "priority",
                "rank",
                "id",
                "value",
                "score",
                "quality",
                "effort",
                "alternative",
                "price",
                "current",
                "fromFallback",
              ],
              additionalProperties: false,
            },
          },
        },
        required: ["sessionID", "age", "capture", "steeringNote", "entries"],
        additionalProperties: false,
      },
    },
    // The Q2 fallback's cannot-steer notification (the runtime hook emits it
    // once per session when a steerable alias request finds no steering
    // data): the TUI's toast listens for `rpc.model-compare.cannotSteer`.
    // Declared here like every other event — the host fails emits of
    // undeclared names with "Unknown RPC event".
    cannotSteer: {
      schema: {
        type: "object",
        properties: {
          sessionID: { type: "string" },
        },
        required: ["sessionID"],
        additionalProperties: false,
      },
    },
  },
})

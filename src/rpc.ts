// src/rpc.ts
// The plugin's RPC surface (V2 plugins RPC): methods the TUI half and other
// clients can call on the server plugin, plus the event the /model-compare
// command emits. The report method returns the SAME text the command
// synthesizes — one builder in src/index.ts serves both, so the two can
// never drift. The report EVENT carries the structured entries (the TUI's
// selectable report dialog), because the transcript notice itself only
// surfaces at the session's next turn.
import { Rpc } from "@opencode/plugin/rpc"

export const ModelCompare = Rpc.define({
  id: "model-compare",
  methods: {
    report: {
      input: { type: "object", properties: {}, additionalProperties: false },
      output: {
        type: "object",
        properties: {
          text: { type: "string" },
          age: { type: ["string", "null"] },
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
                price: { type: "string" },
                current: { type: "boolean" },
                fromFallback: { type: "boolean" },
              },
              required: ["priority", "rank", "id", "value", "score", "quality", "price", "current", "fromFallback"],
              additionalProperties: false,
            },
          },
        },
        required: ["text", "age", "entries"],
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
                price: { type: "string" },
                current: { type: "boolean" },
                fromFallback: { type: "boolean" },
              },
              required: ["priority", "rank", "id", "value", "score", "quality", "price", "current", "fromFallback"],
              additionalProperties: false,
            },
          },
        },
        required: ["sessionID", "age", "entries"],
        additionalProperties: false,
      },
    },
  },
})

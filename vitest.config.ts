import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    globals: true,
    // The two live-server integration files (tests/integration/) share port
    // 14721, the scratch project dir and wire.jsonl — they must not run
    // concurrently (vitest executes files in parallel by default).
    fileParallelism: false,
  },
})
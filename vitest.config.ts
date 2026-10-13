import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    globals: true,
    // Only this repo's tests/ — vitest's default pattern (**/*.test.*) also
    // collects test files under .worktrees/ (750 stray files at last count),
    // which slows every run and could fail a publish on a stale worktree.
    include: ["tests/**/*.{test,spec}.?(c|m)[jt]s?(x)"],
    // The two live-server integration files (tests/integration/) share port
    // 14721, the scratch project dir and wire.jsonl — they must not run
    // concurrently (vitest executes files in parallel by default).
    fileParallelism: false,
  },
})
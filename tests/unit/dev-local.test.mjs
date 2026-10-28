// tests/unit/dev-local.test.mjs
// The local TUI launcher (npm run dev): its generated project config must
// point OpenCode at THIS checkout's src/ directory (local plugins are resolved
// as <dir>/index.*, not through package exports), so the TUI exercises the
// working tree rather than the published package.
import { execFileSync } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, test } from "vitest"

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..")
const SCRIPT = path.join(REPO_ROOT, "scripts", "dev-local.mjs")

describe("the local TUI launcher", () => {
  test("prints a project config that loads this checkout's src/ as a local plugin", () => {
    const output = execFileSync(process.execPath, [SCRIPT, "--print-config"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    })
    const config = JSON.parse(output)

    expect(config.model).toBe("openrouter/model-compare/balanced")
    expect(config.plugins).toEqual([
      {
        package: path.join(REPO_ROOT, "src"),
        options: {
          source: "auto",
          defaultPriority: "balanced",
          fallback: "openrouter/z-ai/glm-5.3-flash",
        },
      },
    ])
  })
})

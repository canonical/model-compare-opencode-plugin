#!/usr/bin/env node
// scripts/dev-local.mjs
// Launch OpenCode's TUI against THIS checkout's plugin source.
//
// Why a scratch project instead of just running `opencode` in the repo:
//   * OpenCode resolves a local plugin directory as <dir>/index.* (and the TUI
//     half as <dir>/tui.*), so the generated project points at <repo>/src.
//   * The global OpenCode config is hidden for the run (OPENCODE_CONFIG_DIR),
//     so a published model-compare package installed there cannot win the
//     duplicate-plugin-ID race and shadow the working tree.
//   * The isolation is CONFIG-ONLY: the scratch project shares your real
//     OpenCode data directory (auth, plugin state, sessions), so alias
//     switches made in the dev TUI rewrite your live aliases. Auth must stay
//     shared — the plugin needs your OpenRouter key — so don't try to fully
//     isolate by copying secrets into a scratch dir; that just forks your
//     credential state.
//   * The scratch project lives under /tmp/opencode, outside the repository,
//     so no ancestor opencode.json can shadow the local entry either.
//
// Source edits need an OpenCode restart: a directory target without a
// package.json is not watched by the plugin loader.
//
// Usage:
//   npm run dev
//   npm run dev -- --print-config     # print the generated project config
//   npm run dev -- --auto             # pass extra flags to opencode
import { spawn } from "node:child_process"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const PLUGIN_DIR = path.join(REPO_ROOT, "src")
const SCRATCH_ROOT =
  process.env.MC_DEV_DIR ?? path.join(os.tmpdir(), "opencode", "model-compare-dev")
const PROJECT_DIR = path.join(SCRATCH_ROOT, "project")
const CONFIG_DIR = path.join(SCRATCH_ROOT, "config")

const CONFIG = {
  $schema: "https://opencode.ai/config.json",
  model: "openrouter/model-compare/balanced",
  plugins: [
    {
      package: PLUGIN_DIR,
      options: {
        source: "auto",
        defaultPriority: "balanced",
        fallback: "openrouter/z-ai/glm-5.3-flash",
      },
    },
  ],
}

function usage() {
  return `Usage: npm run dev [-- <opencode flags>]

Launches \`opencode --standalone\` in an isolated scratch project that loads
this checkout's src/ plugin directly. The global OpenCode config is hidden,
so the published model-compare package cannot shadow the working tree.

The isolation is CONFIG-ONLY: the scratch project shares your real OpenCode
data directory (auth, plugin state, sessions), so alias switches made in the
dev session rewrite your live aliases.

Environment:
  MC_DEV_DIR   scratch project/config root (default: ${
    path.join(os.tmpdir(), "opencode", "model-compare-dev")
  })

Flags:
  --print-config   print the generated project config and exit
  --help, -h       show this help and exit

Any other flags are passed to opencode.`
}

const argv = process.argv.slice(2)
if (argv.includes("--help") || argv.includes("-h")) {
  console.log(usage())
  process.exit(0)
}
if (argv.includes("--print-config")) {
  console.log(JSON.stringify(CONFIG, null, 2))
  process.exit(0)
}

if (!existsSync(path.join(REPO_ROOT, "node_modules", "@opencode", "plugin"))) {
  console.error(
    `model-compare: dependencies are missing under ${REPO_ROOT}.\n` +
      "Run `npm install` in the checkout first, then retry `npm run dev`.",
  )
  process.exit(1)
}

try {
  mkdirSync(PROJECT_DIR, { recursive: true })
  mkdirSync(CONFIG_DIR, { recursive: true })
  writeFileSync(path.join(PROJECT_DIR, "opencode.json"), JSON.stringify(CONFIG, null, 2) + "\n")
} catch (error) {
  console.error(
    `model-compare: could not prepare scratch project under ${SCRATCH_ROOT}: ${
      error instanceof Error ? error.message : String(error)
    }`,
  )
  process.exit(1)
}

console.log("model-compare local test")
console.log(`  project: ${PROJECT_DIR}`)
console.log(`  config:  ${CONFIG_DIR} (global OpenCode config hidden)`)
console.log("  data:    shared with your normal OpenCode sessions (config-only isolation)")
console.log(`  plugin:  ${PLUGIN_DIR}`)
console.log("  source edits need an OpenCode restart")
console.log("")

const child = spawn("opencode", ["--standalone", ...argv], {
  cwd: PROJECT_DIR,
  env: {
    ...process.env,
    // OpenCode 2.1.x resolves the project from PWD, not the spawned cwd.
    PWD: PROJECT_DIR,
    OPENCODE_CONFIG_DIR: CONFIG_DIR,
  },
  stdio: "inherit",
})

child.on("error", (error) => {
  console.error(`model-compare: could not launch opencode: ${error.message}`)
  process.exitCode = 1
})
child.on("exit", (code, signal) => {
  if (signal !== null) process.kill(process.pid, signal)
  else process.exitCode = code ?? 1
})

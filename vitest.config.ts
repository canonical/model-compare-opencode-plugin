import { existsSync } from "node:fs"
import { createRequire } from "node:module"
import path from "node:path"
import { pathToFileURL } from "node:url"
import type { Plugin as VitePlugin } from "vite"
import { defineConfig } from "vitest/config"

// The TUI half (src/tui.tsx) is Solid JSX: vitest's default esbuild transform
// compiles JSX to react/jsx-runtime, which nothing in this tree provides —
// the same trap the published package avoids by precompiling (see
// scripts/build-tui.mjs, whose header documents the host-side version of
// this story). The unit tests reuse the transform that build already pins:
// @opentui/solid's own Solid+TS compiler (the same Babel pipeline the
// OpenCode TUI host runs), applied to this repo's .tsx files only.
type SolidTransform = {
  transformSolidSource: (code: string, options: { filename: string }) => Promise<string>
}

let solidTransform: Promise<SolidTransform> | undefined
function loadSolidTransform(): Promise<SolidTransform> {
  solidTransform ??= (async () => {
    try {
      const require = createRequire(import.meta.url)
      const index = require.resolve("@opentui/solid")
      const script = path.resolve(path.dirname(index), "scripts", "solid-transform.js")
      if (!existsSync(script)) {
        throw new Error(
          `@opentui/solid no longer ships scripts/solid-transform.js (looked next to ${index}); ` +
            "update the vitest config's transform loader",
        )
      }
      return (await import(pathToFileURL(script).href)) as SolidTransform
    } catch (error) {
      throw new Error(
        "vitest.config.ts: the Solid transform loader could not load @opentui/solid's " +
          "scripts/solid-transform.js compiler",
        { cause: error },
      )
    }
  })().catch((error) => {
    // Do not memoize a rejection: a transient failure (a half-installed tree,
    // a race with an install) must not poison every later transform of the
    // run with a stale error. Drop the cached promise so the next call retries.
    solidTransform = undefined
    throw error
  })
  return solidTransform
}

function solidTsx(): VitePlugin {
  return {
    name: "opentui-solid-transform",
    enforce: "pre",
    async transform(code, id) {
      if (!id.endsWith(".tsx") || id.includes("node_modules")) return null
      const { transformSolidSource } = await loadSolidTransform()
      // Source maps are deliberately not produced: transformSolidSource
      // returns a compiled string only, so stacks that cross src/tui.tsx
      // report Babel-output line numbers against the .tsx filename. Accepted
      // for the test rig (the published artifact's absent .map is a separate,
      // package-shape decision — pack-smoke asserts dist/tui.js.map stays out
      // of the package).
      return { code: await transformSolidSource(code, { filename: id }), map: null }
    },
  }
}

export default defineConfig({
  plugins: [solidTsx()],
  resolve: {
    alias: [
      {
        // The bare `solid-js` specifier must land on the SAME client-build
        // file that @opentui/solid deep-imports: the package's own code
        // imports "solid-js/dist/solid.js" directly (index.js, 7 places), and
        // bare "solid-js" from this repo's files — the test file and the
        // compiled src/tui.tsx output, which keeps bare specifiers because
        // the transform above is invoked without resolvePath — would
        // otherwise resolve through Node's export conditions to the SSR
        // build (dist/server.js), where createEffect is a stub and the TUI
        // rig's signals would never re-run effects. More subtly, resolving
        // to any DIFFERENT file than @opentui/solid uses would split the
        // graph into two Solid instances (per-instance Listener/Updates
        // state) and effects would silently stop tracking signals — so the
        // replacement is resolved through Node's own algorithm (robust to
        // nested installs) rather than a hardcoded path.
        find: /^solid-js$/,
        replacement: createRequire(import.meta.url).resolve("solid-js/dist/solid.js"),
      },
    ],
  },
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

// scripts/lib/invoked-directly.mjs — shared CLI-entry guard for the repo's
// scripts (build-tui.mjs, pack-smoke.mjs).
//
// Node realpaths import.meta.url but keeps process.argv[1]'s spelling, so the
// common `import.meta.url === pathToFileURL(process.argv[1]).href` check
// silently skips main() — exit 0, no output — whenever the invocation path
// contains a symlink (e.g. `node /symlinked/dir/scripts/build-tui.mjs`). For
// build-tui that means `npm run build` appears to succeed without writing
// dist/; for pack-smoke the packaging safety check would silently not run.
// Comparing realpaths closes that hole.
//
// realpathSync can only throw if argv[1] does not exist, which cannot happen
// while Node is executing that very file — no try/catch.
import { realpathSync } from "node:fs"
import { fileURLToPath } from "node:url"

// -> boolean: true when the script behind `moduleUrl` is the file Node was
// invoked to run (`argv1`, i.e. process.argv[1]); false for an import or a
// different script.
export function invokedDirectly(moduleUrl, argv1) {
  return Boolean(argv1) && realpathSync(argv1) === fileURLToPath(moduleUrl)
}

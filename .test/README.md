# Try the plugin in your own OpenCode

One-time setup from the repo root (the plugin's imports — `@opencode/plugin`,
`@opencode/plugin/tui`, `solid-js` — resolve from the repo's `node_modules`):

    npm ci

Then:

    cd .test/project && opencode

**But read the shadowing section below first**: with the published copy
registered anywhere in the config chain, the local `src/` never loads —
OpenCode keeps the first plugin with a given ID and rejects the rest.

The scratch project loads the plugin straight from the repo's `src/` —
OpenCode's local loader resolves `src/index.ts` and the `./tui` half
(`src/tui.tsx`) directly from the directory target; no bridge or build step
is needed. (The build step — `npm run build` — is only for the *published*
npm package: OpenCode's Solid JSX transform skips `node_modules` paths, so
the npm-installed raw TSX cannot load and the tarball ships the precompiled
`dist/tui.js` instead.)

## The published copy shadows the local source

Plugin IDs register first-come-first-served: OpenCode keeps the first
`model-compare` and rejects every later one with "Duplicate plugin ID:
model-compare" (visible in `/plugins`). Two config layers can register the
published npm copy (0.1.1) before this checkout's `src/`:

- the global config (`~/.config/opencode/opencode.json` lists the npm
  package — it applies to every project), and
- the repo root's `opencode.json` (`./src`) — it applies to every project
  under this directory, **including worktrees in `.worktrees/`** (parent
  configs register before the deepest project config, and the parent wins).

When either is present, `.test/project` silently runs the published version
and the local source's changes never appear. Test against the local source
from a worktree **outside this repo's directory**:

    git worktree add ~/git/gh/rkratky/mc-testing <branch>
    cd ~/git/gh/rkratky/mc-testing && npm ci
    mkdir -p /tmp/opencode/empty-config
    cd .test/project
    OPENCODE_CONFIG_DIR=/tmp/opencode/empty-config opencode --standalone

- The empty `OPENCODE_CONFIG_DIR` removes the global plugin entry (and your
  other global plugins/MCP servers) for this session only — provider auth is
  unaffected, it lives in the data directory.
- `--standalone` gives the session its own server: the env var must reach
  the process that LOADS plugins, and the shared background service keeps
  its own environment and per-location plugin state.

To check which copy is actually running: `/plugins` lists each instance
with its source (`package` = published npm copy, `local` = this checkout)
and failure reasons.



- The model picker shows the three aliases: `Model Compare: balanced/price/quality → <pick>`
- `/use-best [priority]` switches this session (a toast confirms)
- `/model-compare` prints the ranking report
- The footer shows `MC: …` while a session is open

Data comes from the vendored CLI (`source: auto`); the fallback model is
`openrouter/z-ai/glm-5.3-flash`.

Source edits need an OpenCode restart to take effect (the directory has no
`package.json`, so the plugin watcher does not watch it).

# Try the plugin in your own OpenCode

One-time setup from the repo root (the plugin's imports — `@opencode/plugin`,
`@opencode/plugin/tui`, `solid-js` — resolve from the repo's `node_modules`):

    npm ci

Then:

    cd .test/project && opencode

The scratch project loads the plugin straight from the repo's `src/` —
OpenCode's local loader resolves `src/index.ts` and the `./tui` half
(`src/tui.tsx`) directly from the directory target; no bridge or build step
is needed. (The build step — `npm run build` — is only for the *published*
npm package: OpenCode's Solid JSX transform skips `node_modules` paths, so
the npm-installed raw TSX cannot load and the tarball ships the precompiled
`dist/tui.js` instead.)

- The model picker shows the three aliases: `Model Compare: balanced/price/quality → <pick>`
- `/use-best [priority]` switches this session (a toast confirms)
- `/model-compare` prints the ranking report
- The footer shows `MC: …` while a session is open

Data comes from the vendored CLI (`source: auto`); the fallback model is
`openrouter/z-ai/glm-5.3-flash`.

Source edits need an OpenCode restart to take effect (the directory has no
`package.json`, so the plugin watcher does not watch it).

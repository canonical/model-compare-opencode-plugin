// tests/unit/invoked-directly.test.mjs — scripts/lib/invoked-directly.mjs, the
// shared CLI-entry guard used by scripts/build-tui.mjs and
// scripts/pack-smoke.mjs so their main() runs when the script is executed
// directly. Node realpaths import.meta.url but keeps process.argv[1]'s
// spelling, so comparing raw strings silently skips main() (exit 0, no
// output) when the invocation path contains a symlink; the helper compares
// realpaths instead.
import { describe, expect, test } from "vitest"
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import path from "node:path"
import { tmpdir } from "node:os"
import { pathToFileURL } from "node:url"
import { invokedDirectly } from "../../scripts/lib/invoked-directly.mjs"

describe("invokedDirectly", () => {
  test("the script's own direct path matches", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "invoked-directly-"))
    try {
      const file = path.join(dir, "main.mjs")
      writeFileSync(file, "")
      expect(invokedDirectly(pathToFileURL(file).href, file)).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("a symlinked spelling of the script matches too", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "invoked-directly-"))
    try {
      const file = path.join(dir, "main.mjs")
      writeFileSync(file, "")
      const link = path.join(dir, "link.mjs")
      symlinkSync(file, link)
      expect(invokedDirectly(pathToFileURL(file).href, link)).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("a different script does not match", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "invoked-directly-"))
    try {
      const mine = path.join(dir, "mine.mjs")
      const other = path.join(dir, "other.mjs")
      writeFileSync(mine, "")
      writeFileSync(other, "")
      expect(invokedDirectly(pathToFileURL(mine).href, other)).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("no argv[1] (imported, not executed) does not match", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "invoked-directly-"))
    try {
      const file = path.join(dir, "main.mjs")
      writeFileSync(file, "")
      expect(invokedDirectly(pathToFileURL(file).href, undefined)).toBe(false)
      expect(invokedDirectly(pathToFileURL(file).href, "")).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

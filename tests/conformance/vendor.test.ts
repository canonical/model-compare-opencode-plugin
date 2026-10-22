// tests/conformance/vendor.test.ts
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { describe } from "vitest"
import { dynamicImportSites, importedModules } from "./imports"
test("vendored script matches the pinned tag", () => {
  const meta = JSON.parse(readFileSync("vendor/UPSTREAM.json", "utf8"))
  // Tag-agnostic: the exact version is pinned by the vendor-contract test
  // (--version output == tag). Asserting the format here keeps this test
  // maintenance-free across re-vendors while the sha stays the pin.
  expect(meta.tag).toMatch(/^v\d+\.\d+\.\d+$/)
  const sha = createHash("sha256").update(readFileSync("vendor/model_compare.py")).digest("hex")
  expect(sha).toBe(meta.sha256)
})

// Standard library only (design §11). `__future__` and `datetime` are the two
// modules the script imports with `from … import`.
const ALLOWLIST = new Set([
  "__future__",
  "argparse",
  // vendored 0.4.0 uses concurrent.futures for catalog assembly
  "concurrent.futures",
  "datetime",
  "gzip",
  "json",
  "math",
  "os",
  "re",
  "sys",
  "time",
  "urllib.error",
  "urllib.parse",
  "urllib.request",
])

test("imports stay on the allowlist", () => {
  const src = readFileSync("vendor/model_compare.py", "utf8")
  const imports = importedModules(src)
  // Guard against the extractor silently matching nothing.
  expect(imports).toContain("__future__")
  expect(imports).toContain("datetime")
  for (const i of imports) expect(ALLOWLIST.has(i), `unexpected import: ${i}`).toBe(true)
  expect(dynamicImportSites(src), "dynamic imports bypass the allowlist").toEqual([])
})

describe("importedModules", () => {
  test("captures `import a`, comma lists, aliases, and `from x import y`", () => {
    const src = [
      "import os",
      "import sys, json as j",
      "from datetime import datetime, timezone",
      "from __future__ import annotations",
      "    import gzip  # indented, function-local",
      "x = 1  # not an import",
    ].join("\n")
    expect(importedModules(src)).toEqual(["os", "sys", "json", "datetime", "__future__", "gzip"])
  })

  test("`from subprocess import run` is extracted — and fails the allowlist", () => {
    const found = importedModules("from subprocess import run\nimport os")
    expect(found).toEqual(["subprocess", "os"])
    expect(found.every((m) => ALLOWLIST.has(m))).toBe(false)
  })

  test("a lazy import in a function body is seen", () => {
    expect(importedModules("def f():\n    import socket\n")).toEqual(["socket"])
  })

  test("`import a, subprocess` fails on the second name", () => {
    expect(importedModules("import os, subprocess").filter((m) => !ALLOWLIST.has(m))).toEqual([
      "subprocess",
    ])
  })
})

describe("dynamicImportSites", () => {
  test("flags __import__ and importlib", () => {
    expect(dynamicImportSites("m = __import__('subprocess')")).toHaveLength(1)
    expect(dynamicImportSites("x = importlib.import_module('os')")).toHaveLength(1)
    expect(dynamicImportSites("print('fine')")).toEqual([])
  })
})

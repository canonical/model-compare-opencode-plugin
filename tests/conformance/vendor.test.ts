// tests/conformance/vendor.test.ts
import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { describe, expect, test } from "vitest"
import { scriptEnv } from "../../src/sources/local"
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

// Standard library only (design §11). `__future__`, `datetime` and
// `contextlib` are the modules the script imports with `from … import`.
// `shlex`/`subprocess` back the CLI pager only (0.7.2+); `--catalog` never
// pages, so the plugin never reaches that code path.
const ALLOWLIST = new Set([
  "__future__",
  "argparse",
  // vendored 0.7.0+ uses concurrent.futures for catalog assembly
  "concurrent.futures",
  "contextlib",
  "datetime",
  "gzip",
  "json",
  "math",
  "os",
  "re",
  "shlex",
  "subprocess",
  "sys",
  "time",
  "urllib.error",
  "urllib.parse",
  "urllib.request",
])

const PROCESS_BOUNDARY_AUDIT_PY = `
import ast, json, sys

src = sys.stdin.read()
tree = ast.parse(src)
parents = {child: node for node in ast.walk(tree) for child in ast.iter_child_nodes(node)}
top_funcs = {
    node.name: node
    for node in tree.body
    if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
}

def enclosing_top_func(node):
    cur = node
    top = None
    while cur in parents:
        cur = parents[cur]
        if isinstance(cur, (ast.FunctionDef, ast.AsyncFunctionDef)) and parents.get(cur) is tree:
            top = cur.name
    return top

violations = []

for node in ast.walk(tree):
    if isinstance(node, ast.ImportFrom):
        mod = (node.module or "").split(".")[0]
        if mod in ("subprocess", "shlex", "os"):
            violations.append(f"line {node.lineno}: from {node.module} import is forbidden")
    elif isinstance(node, ast.Import):
        for alias in node.names:
            root = alias.name.split(".")[0]
            if root in ("subprocess", "shlex", "os") and alias.asname is not None:
                violations.append(f"line {node.lineno}: aliasing {alias.name} as {alias.asname} is forbidden")

popen_calls = 0

for node in ast.walk(tree):
    if not isinstance(node, ast.Name) or node.id not in ("subprocess", "shlex", "os"):
        continue
    parent = parents.get(node)
    if not (isinstance(parent, ast.Attribute) and parent.value is node):
        violations.append(f"line {node.lineno}: bare {node.id} reference outside attribute access")
        continue
    attr = parent.attr
    func = enclosing_top_func(parent)
    if node.id == "subprocess":
        if func != "paged_stdout":
            violations.append(f"line {parent.lineno}: subprocess.{attr} outside paged_stdout (in {func!r})")
        elif attr == "Popen":
            popen_calls += 1
            call = parents.get(parent)
            if not (isinstance(call, ast.Call) and call.func is parent):
                violations.append(f"line {parent.lineno}: subprocess.Popen must be called directly")
            else:
                for kw in call.keywords:
                    if kw.arg is None:
                        violations.append(f"line {kw.lineno}: **kwargs forbidden in subprocess.Popen")
                    elif kw.arg == "shell" and not (isinstance(kw.value, ast.Constant) and kw.value.value is False):
                        violations.append(f"line {kw.lineno}: shell keyword in subprocess.Popen must be literal False")
        elif attr != "PIPE":
            violations.append(f"line {parent.lineno}: unexpected subprocess.{attr} in paged_stdout")
    elif node.id == "shlex":
        if func != "resolve_pager":
            violations.append(f"line {parent.lineno}: shlex.{attr} outside resolve_pager (in {func!r})")
        elif attr != "split":
            violations.append(f"line {parent.lineno}: unexpected shlex.{attr} in resolve_pager")
    elif node.id == "os":
        if attr in ("system", "popen") or attr.startswith(("exec", "spawn", "posix_spawn")):
            violations.append(f"line {parent.lineno}: forbidden process spawn os.{attr}")

if popen_calls > 1:
    violations.append(f"paged_stdout contains {popen_calls} subprocess.Popen calls (expected <= 1)")

def references_pager(subtree):
    for n in ast.walk(subtree):
        if isinstance(n, ast.Name) and n.id in ("paged_stdout", "resolve_pager"):
            return n.lineno
        if isinstance(n, ast.Attribute) and n.attr in ("paged_stdout", "resolve_pager"):
            return n.lineno
    return None

build_fn = top_funcs.get("build_catalog")
if build_fn is None:
    violations.append("missing top-level def build_catalog")
else:
    hit = references_pager(build_fn)
    if hit is not None:
        violations.append(f"line {hit}: build_catalog references pager helper")

run_fn = top_funcs.get("run")
if run_fn is None:
    violations.append("missing top-level def run")
else:
    guarded = False
    for stmt in run_fn.body:
        if (
            isinstance(stmt, ast.If)
            and isinstance(stmt.test, ast.Attribute)
            and isinstance(stmt.test.value, ast.Name)
            and stmt.test.value.id == "args"
            and stmt.test.attr == "catalog"
            and not stmt.orelse
            and bool(stmt.body)
            and isinstance(stmt.body[-1], ast.Return)
        ):
            hit = references_pager(stmt)
            if hit is not None:
                violations.append(f"line {hit}: if args.catalog branch references pager helper")
            guarded = True
            break
        hit = references_pager(stmt)
        if hit is not None:
            violations.append(f"line {hit}: pager helper referenced in run() before if args.catalog return")
    if not guarded:
        violations.append("run() has no top-level 'if args.catalog: ... return' early exit before pager")

print(json.dumps(violations))
`

function auditProcessBoundaries(source: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const child = spawn("python3", ["-B", "-c", PROCESS_BOUNDARY_AUDIT_PY], { env: scriptEnv() })
    let stdout = ""
    let stderr = ""
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk
    })
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk
    })
    child.on("error", reject)
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`python3 AST audit exited ${code}: ${stderr.trim()}`))
        return
      }
      resolve(JSON.parse(stdout) as string[])
    })
    child.stdin?.end(source)
  })
}

test("imports stay on the allowlist", () => {
  const src = readFileSync("vendor/model_compare.py", "utf8")
  const imports = importedModules(src)
  // Guard against the extractor silently matching nothing.
  expect(imports).toContain("__future__")
  expect(imports).toContain("datetime")
  for (const i of imports) expect(ALLOWLIST.has(i), `unexpected import: ${i}`).toBe(true)
  expect(dynamicImportSites(src), "dynamic imports bypass the allowlist").toEqual([])
})

test("subprocess, shlex, and os process-spawning stay confined to the unreachable CLI pager", async () => {
  const src = readFileSync("vendor/model_compare.py", "utf8")
  expect(await auditProcessBoundaries(src)).toEqual([])
})

describe("auditProcessBoundaries", () => {
  const validBase = [
    "import os",
    "import shlex",
    "import subprocess",
    "def resolve_pager(args):",
    "    return shlex.split('less -R')",
    "def paged_stdout(argv):",
    "    p = subprocess.Popen(argv, stdin=subprocess.PIPE)",
    "    return p",
    "def build_catalog(args):",
    "    return {}",
    "def run(args):",
    "    if args.catalog:",
    "        return 0",
    "    with paged_stdout(resolve_pager(args)):",
    "        pass",
    "    return 0",
  ].join("\n")

  test("accepts the minimal valid pager-confined layout", async () => {
    expect(await auditProcessBoundaries(validBase)).toEqual([])
  })

  test("flags from-imports, aliases, shell=True, non-pager subprocess/shlex, os spawns, and catalog-path pager calls", async () => {
    expect(await auditProcessBoundaries(`${validBase}\nfrom subprocess import run\n`)).toEqual(
      expect.arrayContaining([expect.stringMatching(/from subprocess import is forbidden/)]),
    )
    expect(
      await auditProcessBoundaries(
        validBase.replace("stdin=subprocess.PIPE", "stdin=subprocess.PIPE, shell=True"),
      ),
    ).toEqual(expect.arrayContaining([expect.stringMatching(/shell keyword in subprocess\.Popen/)]))
    expect(
      await auditProcessBoundaries(
        validBase.replace("return {}", "subprocess.run(['id'])\n    return {}"),
      ),
    ).toEqual(expect.arrayContaining([expect.stringMatching(/subprocess\.run outside paged_stdout/)]))
    expect(
      await auditProcessBoundaries(
        validBase.replace("return {}", "shlex.split('x')\n    return {}"),
      ),
    ).toEqual(expect.arrayContaining([expect.stringMatching(/shlex\.split outside resolve_pager/)]))
    expect(
      await auditProcessBoundaries(validBase.replace("return {}", "os.system('id')\n    return {}")),
    ).toEqual(expect.arrayContaining([expect.stringMatching(/forbidden process spawn os\.system/)]))
    expect(
      await auditProcessBoundaries(validBase.replace("return {}", "os.execvp('id', ['id'])\n    return {}")),
    ).toEqual(expect.arrayContaining([expect.stringMatching(/forbidden process spawn os\.execvp/)]))
    expect(
      await auditProcessBoundaries(
        validBase.replace("if args.catalog:", "resolve_pager(args)\n    if args.catalog:"),
      ),
    ).toEqual(expect.arrayContaining([expect.stringMatching(/before if args\.catalog return/)]))
    expect(
      await auditProcessBoundaries(
        validBase.replace("return {}", "paged_stdout([])\n    return {}"),
      ),
    ).toEqual(expect.arrayContaining([expect.stringMatching(/build_catalog references pager helper/)]))
  })
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

  test("`from socket import create_connection` is extracted — and fails the allowlist", () => {
    const found = importedModules("from socket import create_connection\nimport os")
    expect(found).toEqual(["socket", "os"])
    expect(found.every((m) => ALLOWLIST.has(m))).toBe(false)
  })

  test("a lazy import in a function body is seen", () => {
    expect(importedModules("def f():\n    import socket\n")).toEqual(["socket"])
  })

  test("`import a, socket` fails on the second name", () => {
    expect(importedModules("import os, socket").filter((m) => !ALLOWLIST.has(m))).toEqual([
      "socket",
    ])
  })

  test("extracts semicolon-chained imports while ignoring semicolons in strings and comments", () => {
    const src = [
      "x = 1; import socket",
      "import os; from ctypes import cdll",
      'msg = "x; import ftplib"; tag = \'#not-a-comment\'; import urllib.parse # ; import ssl',
    ].join("\n")
    expect(importedModules(src)).toEqual(["socket", "os", "ctypes", "urllib.parse"])
  })
})

describe("dynamicImportSites", () => {
  test("flags __import__ and importlib", () => {
    expect(dynamicImportSites("m = __import__('subprocess')")).toHaveLength(1)
    expect(dynamicImportSites("x = importlib.import_module('os')")).toHaveLength(1)
    expect(dynamicImportSites("print('fine')")).toEqual([])
  })
})

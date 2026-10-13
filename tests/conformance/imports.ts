// tests/conformance/imports.ts
// Module extraction for the vendored script's import allowlist (design §11).
// Handles both statement forms — `import a, b as c` and `from x import y` —
// including indented (function-local) imports, and flags dynamic imports.

// Every module a Python source imports, in order of appearance.
export function importedModules(source: string): string[] {
  const modules: string[] = []
  for (const line of source.split("\n")) {
    const from = /^\s*from\s+(\S+)\s+import\b/.exec(line)
    if (from) {
      modules.push(from[1])
      continue
    }
    const plain = /^\s*import\s+([^#]+)/.exec(line)
    if (plain) {
      for (const part of plain[1].split(",")) {
        const name = part.trim().split(/\s+/)[0]
        if (name) modules.push(name)
      }
    }
  }
  return modules
}

// Constructs that import without an import statement.
export function dynamicImportSites(source: string): string[] {
  return source
    .split("\n")
    .map((line, i) => ({ line, n: i + 1 }))
    .filter(({ line }) => /__import__\s*\(|\bimportlib\b/.test(line))
    .map(({ line, n }) => `line ${n}: ${line.trim()}`)
}

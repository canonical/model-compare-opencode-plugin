// tests/conformance/imports.ts
// Module extraction for the vendored script's import allowlist (design §11).
// Handles both statement forms — `import a, b as c` and `from x import y` —
// including indented (function-local) imports, and flags dynamic imports.

// Splits one physical Python line into `;`-separated statements, stripping
// trailing `# ...` comments while ignoring `;` and `#` inside string literals.
function statementsOnLine(line: string): string[] {
  const statements: string[] = []
  let start = 0
  let quote: '"' | "'" | '"""' | "'''" | null = null
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (quote !== null) {
      if (ch === "\\") {
        i++
        continue
      }
      if (quote.length === 3) {
        if (line.slice(i, i + 3) === quote) {
          quote = null
          i += 2
        }
      } else if (ch === quote) {
        quote = null
      }
      continue
    }
    if (ch === "#") {
      statements.push(line.slice(start, i))
      return statements
    }
    if (ch === '"' || ch === "'") {
      const triple = line.slice(i, i + 3)
      if (triple === '"""' || triple === "'''") {
        quote = triple
        i += 2
      } else {
        quote = ch
      }
      continue
    }
    if (ch === ";") {
      statements.push(line.slice(start, i))
      start = i + 1
    }
  }
  statements.push(line.slice(start))
  return statements
}

// Every module a Python source imports, in order of appearance.
export function importedModules(source: string): string[] {
  const modules: string[] = []
  for (const line of source.split("\n")) {
    for (const stmt of statementsOnLine(line)) {
      const from = /^\s*from\s+(\S+)\s+import\b/.exec(stmt)
      if (from) {
        modules.push(from[1])
        continue
      }
      const plain = /^\s*import\s+(.+)/.exec(stmt)
      if (plain) {
        for (const part of plain[1].split(",")) {
          const name = part.trim().split(/\s+/)[0]
          if (name) modules.push(name)
        }
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

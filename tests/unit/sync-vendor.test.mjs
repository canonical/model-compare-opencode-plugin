// tests/unit/sync-vendor.test.mjs
import { readFileSync } from "node:fs"
import { describe, expect, test } from "vitest"
import { changelogSection } from "../../scripts/sync-vendor.mjs"

const SAMPLE_CHANGELOG = [
  "# Changelog",
  "",
  "## [Unreleased]",
  "",
  "- Upcoming work.",
  "",
  "## [0.7.10] - 2026-11-09",
  "",
  "- Added LiteLLM artifacts.",
  "",
  "## [0.7.2] - 2026-10-30",
  "",
  "- Added terminal pager.",
  "",
  "## [0.7.1] - 2026-10-29",
  "",
  "- Tooltip polish.",
  "",
  "## [0.7.0] - 2026-10-28",
  "",
  "- Schema v6 best-selectable-depth quality.",
  "",
].join("\n")

describe("changelogSection", () => {
  test("disambiguates prefix-colliding versions (0.7.1 does not match 0.7.10 or 0.7.1-rc1)", () => {
    const withPrerelease = [
      "## [0.7.10] - 2026-11-09",
      "- Ten.",
      "",
      "## [0.7.1-rc1] - 2026-10-29",
      "- Release candidate.",
      "",
      "## [0.7.1] - 2026-10-29",
      "- Exact 0.7.1.",
      "",
      "## [0.7.0] - 2026-10-28",
      "- Zero.",
    ].join("\n")

    expect(changelogSection(withPrerelease, "0.7.1")).toBe(
      ["## [0.7.1] - 2026-10-29", "- Exact 0.7.1."].join("\n"),
    )
    expect(changelogSection("## 0.7.10\n- Ten.\n\n## 0.7.1\n- One.\n", "0.7.1")).toBe(
      "## 0.7.1\n- One.",
    )
  })

  test("extracts a single tag's section when no previous tag is supplied or when equal", () => {
    const expected = ["## [0.7.10] - 2026-11-09", "", "- Added LiteLLM artifacts."].join("\n")
    expect(changelogSection(SAMPLE_CHANGELOG, "0.7.10")).toBe(expected)
    expect(changelogSection(SAMPLE_CHANGELOG, "v0.7.10", "v0.7.10")).toBe(expected)
  })

  test("extracts the full contiguous range from target tag down to (excluding) previousTag on multi-tag jumps", () => {
    expect(changelogSection(SAMPLE_CHANGELOG, "v0.7.10", "v0.7.0")).toBe(
      [
        "## [0.7.10] - 2026-11-09",
        "",
        "- Added LiteLLM artifacts.",
        "",
        "## [0.7.2] - 2026-10-30",
        "",
        "- Added terminal pager.",
        "",
        "## [0.7.1] - 2026-10-29",
        "",
        "- Tooltip polish.",
      ].join("\n"),
    )
  })

  test("falls back to the single target section if previousTag is missing or ordered above target", () => {
    const expected = ["## [0.7.2] - 2026-10-30", "", "- Added terminal pager."].join("\n")
    expect(changelogSection(SAMPLE_CHANGELOG, "0.7.2", "v0.6.0")).toBe(expected)
    expect(changelogSection(SAMPLE_CHANGELOG, "0.7.2", "v0.7.10")).toBe(expected)
  })

  test("returns null when the target version is absent from the changelog", () => {
    expect(changelogSection(SAMPLE_CHANGELOG, "9.9.9", "0.7.0")).toBeNull()
  })

  test("scripts/sync-vendor.mjs guards its CLI entrypoint with invokedDirectly", () => {
    const src = readFileSync("scripts/sync-vendor.mjs", "utf8")
    expect(src).toMatch(/invokedDirectly\(import\.meta\.url,\s*process\.argv\[1\]\)/)
  })
})

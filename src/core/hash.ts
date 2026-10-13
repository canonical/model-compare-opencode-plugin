// src/core/hash.ts
// 32-bit FNV-1a as lowercase hex. Used to derive storage keys (pin records by
// effective weights §7.2, the document cache by source identity) — not a
// security primitive.
export function fnv1aHex(input: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, "0")
}

// Cache keys: a SHA-256 over canonical JSON, so the same inputs give the same key whatever their key order.
import { createHash } from "node:crypto"
import type { Schema } from "effect"

const sortKeys = (value: Schema.Json): Schema.Json => {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value === null || typeof value !== "object") return value
  return Object.fromEntries(
    Object.entries(value)
      .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => [k, sortKeys(v)])
  )
}

// JSON.stringify with every object's keys sorted.
export const canonicalJson = (value: Schema.Json): string => JSON.stringify(sortKeys(value))

// The first 16 hex digits of a SHA-256 over the parts, each followed by a NUL byte.
export const sha = (...parts: ReadonlyArray<string | Uint8Array>): string => {
  const hash = createHash("sha256")
  for (const part of parts) hash.update(part).update("\0")
  return hash.digest("hex").slice(0, 16)
}

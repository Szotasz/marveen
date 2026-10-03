// The .env line grammar, zero-import so a small launcher helper
// (scripts/fleet-venv-prefix.mjs via dist/fleet-venv.js) can share it with
// env.ts without pulling the rest of the app in. Comments and blank lines are
// skipped, the value is trimmed, and ONE pair of matching surrounding quotes
// ("..." or '...') is stripped.
export function parseEnvContent(content: string, keys?: string[]): Record<string, string> {
  const result: Record<string, string> = {}
  for (const line of content.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eqIdx = trimmed.indexOf('=')
    if (eqIdx === -1) continue
    const key = trimmed.slice(0, eqIdx).trim()
    let value = trimmed.slice(eqIdx + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    if (keys && !keys.includes(key)) continue
    result[key] = value
  }
  return result
}

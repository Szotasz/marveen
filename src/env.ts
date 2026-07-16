import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { atomicWriteFileSync } from './web/atomic-write.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = join(__dirname, '..')

export function readEnvFile(keys?: string[]): Record<string, string> {
  const envPath = join(PROJECT_ROOT, '.env')
  let content: string
  try {
    content = readFileSync(envPath, 'utf-8')
  } catch {
    return {}
  }

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

// Update (or append) the given keys in .env, preserving every other line,
// comment, and the original ordering. Used by fleet import to mirror the
// main-agent identity takeover into .env: the dashboard resolves identity via
// cfg() (config-overrides.json > .env), but the shell-side launchers -- most
// importantly scripts/channels.sh -- read MAIN_AGENT_ID / CHANNEL_PROVIDER
// DIRECTLY from .env. Without this mirror the dashboard shows the taken-over
// identity while channels.sh still launches `${old-id}-channels`, so the main
// agent comes up under the wrong identity (and the dashboard sees it as down).
//
// Values are written UNQUOTED: channels.sh parses with `cut -d= -f2-` and does
// no quote-stripping, so a quoted value would leak the quotes. Only non-empty
// string values are written; empty updates are a no-op (no file touch).
export function updateEnvFile(updates: Record<string, string>): void {
  const envPath = join(PROJECT_ROOT, '.env')
  const entries = Object.entries(updates).filter(
    ([, v]) => typeof v === 'string' && v.length > 0,
  )
  if (entries.length === 0) return

  let content = ''
  try {
    content = readFileSync(envPath, 'utf-8')
  } catch {
    content = ''
  }

  const remaining = new Map(entries)
  const lines = content.length > 0 ? content.split('\n') : []
  const out = lines.map((line) => {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) return line
    const eqIdx = trimmed.indexOf('=')
    if (eqIdx === -1) return line
    const key = trimmed.slice(0, eqIdx).trim()
    if (!remaining.has(key)) return line
    const val = remaining.get(key)!
    remaining.delete(key)
    return `${key}=${val}`
  })

  // Append keys that were not already present.
  for (const [key, val] of remaining) {
    out.push(`${key}=${val}`)
  }

  atomicWriteFileSync(envPath, out.join('\n'))
}

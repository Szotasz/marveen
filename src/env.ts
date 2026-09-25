import { readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { atomicWriteFileSync } from './web/atomic-write.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
// CLAUDECLAW_ENV_DIR: test-only escape hatch so the suite can point .env
// reads/writes at a sandbox instead of the real repo root (env.test.ts used
// to unlink+rewrite the LIVE .env -- 2026-07-27 incident). Read at import
// time; production never sets it.
const PROJECT_ROOT = process.env.CLAUDECLAW_ENV_DIR ?? join(__dirname, '..')

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

// The mode a newly created .env gets: it holds secrets, and install-macos.sh /
// install-linux.sh chmod it to 600.
export const ENV_FILE_MODE = 0o600

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

  // ENVPERM925: keep the file's own mode. atomicWriteFileSync writes a NEW file
  // and renames it over .env, so without an explicit mode the result took the
  // umask default: a 0600 .env holding the bot token and API keys came back
  // 0644, readable by every local user (measured 2026-09-25 with this function).
  // A new file is created ENV_FILE_MODE.
  let mode = ENV_FILE_MODE
  try { mode = statSync(envPath).mode & 0o777 } catch { /* no .env yet */ }
  atomicWriteFileSync(envPath, out.join('\n'), { mode })
}

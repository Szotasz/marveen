import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { PROJECT_ROOT } from '../config.js'
import { atomicWriteFileSync } from './atomic-write.js'

// A single bearer token gates every /api/* route. It is loaded from
// DASHBOARD_TOKEN if set, otherwise persisted at store/.dashboard-token
// (mode 0600) and auto-generated on first run. Static assets (/, /index.html,
// /style.css, /app.js, /avatars/*) and the auth-status endpoint stay public
// so the UI can bootstrap itself.
const DASHBOARD_TOKEN_PATH = join(PROJECT_ROOT, 'store', '.dashboard-token')

export function loadOrCreateDashboardToken(): string {
  const fromEnv = process.env.DASHBOARD_TOKEN?.trim()
  if (fromEnv) return fromEnv
  try {
    if (existsSync(DASHBOARD_TOKEN_PATH)) {
      const cached = readFileSync(DASHBOARD_TOKEN_PATH, 'utf-8').trim()
      if (cached) return cached
    }
  } catch { /* fall through and regenerate */ }
  const fresh = randomBytes(32).toString('hex')
  mkdirSync(join(PROJECT_ROOT, 'store'), { recursive: true })
  atomicWriteFileSync(DASHBOARD_TOKEN_PATH, fresh, { mode: 0o600 })
  return fresh
}

export function checkBearerToken(header: string | undefined, expected: string): boolean {
  if (!header) return false
  const m = /^Bearer\s+(.+)$/.exec(header)
  if (!m) return false
  const provided = Buffer.from(m[1].trim())
  const wanted = Buffer.from(expected)
  if (provided.length !== wanted.length) return false
  return timingSafeEqual(provided, wanted)
}

// CRM 1. utem (CRM1SKEL922): separate entry point, separate port.
//   node dist/crm/index.js         (CRM_PORT, default 3421; loopback only)
// The dashboard on 3420 is untouched: this process shares only the bearer
// token file and reads store/claudeclaw.db read-only.
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PROJECT_ROOT, STORE_DIR } from '../config.js'
import { initCrmDatabase, openClaudeclawReadOnly } from './db.js'
import { createCrmServer } from './server.js'

export const CRM_DEFAULT_PORT = 3421
const CRM_HOST = '127.0.0.1'

/** The dashboard's token, READ only. The CRM never mints one: if the
 *  dashboard has not created it yet there is nothing to authenticate
 *  against, and minting here would race the dashboard's own first run. */
function readDashboardToken(): string | null {
  const fromEnv = process.env.DASHBOARD_TOKEN?.trim()
  if (fromEnv) return fromEnv
  const p = join(STORE_DIR, '.dashboard-token')
  if (!existsSync(p)) return null
  const v = readFileSync(p, 'utf-8').trim()
  return v || null
}

export function resolveCrmPort(raw: string | undefined): number {
  const n = parseInt(raw ?? '', 10)
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : CRM_DEFAULT_PORT
}

function main(): void {
  const port = resolveCrmPort(process.env.CRM_PORT)
  const token = readDashboardToken()
  if (!token) {
    process.stderr.write('crm: FAIL-CLOSED, no dashboard token (store/.dashboard-token or DASHBOARD_TOKEN); start the dashboard first\n')
    process.exit(3)
  }
  mkdirSync(STORE_DIR, { recursive: true })
  const crmDb = initCrmDatabase(join(STORE_DIR, 'crm.db'))
  let readDb = null
  try {
    readDb = openClaudeclawReadOnly(join(STORE_DIR, 'claudeclaw.db'))
  } catch (err) {
    process.stderr.write(`crm: claudeclaw.db not readable (${(err as Error).message}); fleet views stay empty\n`)
  }
  const server = createCrmServer({ token, webDir: join(PROJECT_ROOT, 'web-crm'), crmDb, readDb })
  server.listen(port, CRM_HOST, () => {
    process.stderr.write(`crm: listening on http://${CRM_HOST}:${port}/ (store/crm.db, claudeclaw.db read-only)\n`)
  })
  const stop = () => {
    server.close(() => {
      try { crmDb.close() } catch { /* already closed */ }
      try { readDb?.close() } catch { /* already closed */ }
      process.exit(0)
    })
  }
  process.on('SIGTERM', stop)
  process.on('SIGINT', stop)
}

// Only run when executed directly (tests import the module for its exports).
const invokedDirectly = process.argv[1] !== undefined && /[\\/]crm[\\/]index\.[cm]?js$/.test(process.argv[1])
if (invokedDirectly) main()

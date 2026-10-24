import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CodexDeliveryStore } from '../codex-delivery.js'
import { DeliveryRecoveryStore } from '../codex-recovery.js'
import { monitorCodexDeliveries } from '../web/schedule-runner.js'

const roots: string[] = []
const openStores: Array<{ close(): void }> = []
const repoDbFiles = [
  join(process.cwd(), 'store/claudeclaw.db'),
  join(process.cwd(), 'store/claudeclaw.db-wal'),
  join(process.cwd(), 'store/claudeclaw.db-shm'),
]

afterEach(() => {
  vi.unstubAllEnvs()
  for (const store of openStores.splice(0)) store.close()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('Codex scheduler monitor database isolation', () => {
  it('uses injected temporary stores and never creates repository DB files', async () => {
    expect(repoDbFiles.some(existsSync)).toBe(false)
    const root = mkdtempSync(join(tmpdir(), 'codex-monitor-isolation-'))
    roots.push(root)
    const dbPath = join(root, 'monitor.sqlite')
    const deliveryStore = new CodexDeliveryStore(dbPath)
    const recoveryStore = new DeliveryRecoveryStore(dbPath)
    openStores.push(deliveryStore, recoveryStore)
    vi.stubEnv('MARVEEN_AGENT_BACKEND', 'codex')

    await monitorCodexDeliveries([], Date.now(), deliveryStore, recoveryStore)

    expect(existsSync(dbPath)).toBe(true)
    expect(repoDbFiles.some(existsSync)).toBe(false)
  })
})

// PORTRECLAIM1123: the port reclaim stops only this install's own dashboard.
import { describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isOwnDashboardProcess, readPortHolder, selectReclaimVictims, type PortHolderInfo } from '../port-reclaim.js'

const ROOT = '/Users/someone/ClaudeClaw'
const UID = 501
const own = (command: string, cwd: string | null = '/', uid: number | null = UID) => isOwnDashboardProcess({ uid, command, cwd }, ROOT, UID)

describe('isOwnDashboardProcess', () => {
  it('this install\'s dashboard, by absolute path: yes', () => {
    expect(own(`/opt/homebrew/bin/node ${ROOT}/dist/index.js`)).toBe(true)
    expect(own(`node ${ROOT}/dist/index.js --some-flag`)).toBe(true)
    expect(own(`/usr/local/bin/tsx ${ROOT}/src/index.ts`)).toBe(true)
    expect(own(`node ${ROOT}/./dist/index.js`)).toBe(true) // another spelling of the same file
  })

  it('this install\'s dashboard, by relative path from the install root: yes', () => {
    expect(own('node dist/index.js', ROOT)).toBe(true)
    expect(own('node ./dist/index.js', ROOT)).toBe(true)
    expect(own('tsx src/index.ts', `${ROOT}/`)).toBe(true)
  })

  it('the incident: another node service on the port (the CRM) is NOT stopped', () => {
    expect(own('/opt/homebrew/bin/node /Users/someone/marveen-crm/dist/crm/index.js', '/Users/someone/marveen-crm')).toBe(false)
    expect(own('node dist/server.js', ROOT)).toBe(false)
    expect(own('node tools/serve.mjs dist 3421', ROOT)).toBe(false)
  })

  it('another install or a worktree of the same repo is NOT stopped', () => {
    expect(own('node /Users/someone/wt-dani/dist/index.js')).toBe(false)
    expect(own('node dist/index.js', '/Users/someone/wt-dani')).toBe(false)
    expect(own(`node ${ROOT}-old/dist/index.js`)).toBe(false)
    expect(own(`node ${ROOT}/dist/index.js.bak`)).toBe(false)
  })

  it('a relative entry without a readable working directory is NOT stopped', () => {
    expect(own('node dist/index.js', null)).toBe(false)
    expect(own('node dist/index.js', 'relative/dir')).toBe(false)
  })

  it('another user, or an unreadable uid, is NOT stopped', () => {
    expect(own(`node ${ROOT}/dist/index.js`, '/', 0)).toBe(false)
    expect(own(`node ${ROOT}/dist/index.js`, '/', null)).toBe(false)
    // where the platform has no uid (Windows), the command line decides alone
    expect(isOwnDashboardProcess({ uid: null, command: `node ${ROOT}/dist/index.js`, cwd: null }, ROOT, null)).toBe(true)
  })

  it('an empty command line (ps failed) is NOT stopped', () => {
    expect(own('', ROOT)).toBe(false)
  })
})

describe('selectReclaimVictims (the reclaim loop of web.ts)', () => {
  const holders: Record<number, PortHolderInfo> = {
    10: { uid: UID, command: `node ${ROOT}/dist/index.js`, cwd: ROOT },
    11: { uid: UID, command: 'node /Users/someone/marveen-crm/dist/crm/index.js', cwd: '/Users/someone/marveen-crm' },
    12: { uid: UID, command: `node ${ROOT}/dist/index.js`, cwd: ROOT },
  }
  it('stops only the own dashboard, never itself, and names the foreign holder', () => {
    const r = selectReclaimVictims([10, 11, 12], 12, (pid) => holders[pid]!, ROOT, UID)
    expect(r.victims).toEqual([10])
    expect(r.foreign.map((f) => f.pid)).toEqual([11])
  })
  it('the incident: only a foreign holder on the port, nothing is stopped', () => {
    expect(selectReclaimVictims([11], 99, (pid) => holders[pid]!, ROOT, UID).victims).toEqual([])
  })
})

describe('readPortHolder on a real process (this test process)', () => {
  it('reads its uid, its command line and its working directory', () => {
    const h = readPortHolder(process.pid)
    if (typeof process.getuid === 'function') expect(h.uid).toBe(process.getuid())
    expect(h.command).toContain('node')
    expect(h.cwd).not.toBeNull()
  })
  it('a pid that does not exist reads as unknown, which is never stopped', () => {
    const h = readPortHolder(2 ** 22 + 12345)
    expect(h.command).toBe('')
    expect(isOwnDashboardProcess(h, ROOT, UID)).toBe(false)
  })
})

describe('an install reached through a symlink', () => {
  it('its own predecessor is recognised under either spelling of the root', () => {
    // realpath: on macOS the tmpdir itself sits behind a symlink (/var -> /private/var)
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'portreclaim-')))
    try {
      const real = join(base, 'real-install')
      mkdirSync(real)
      const link = join(base, 'link-install')
      symlinkSync(real, link)
      const viaLink = { uid: UID, command: `node ${link}/dist/index.js`, cwd: link }
      const viaReal = { uid: UID, command: `node ${real}/dist/index.js`, cwd: real }
      for (const root of [link, real]) {
        expect(isOwnDashboardProcess(viaLink, root, UID), root).toBe(true)
        expect(isOwnDashboardProcess(viaReal, root, UID), root).toBe(true)
        expect(isOwnDashboardProcess({ uid: UID, command: 'node dist/index.js', cwd: real }, root, UID), root).toBe(true)
      }
      expect(isOwnDashboardProcess({ uid: UID, command: `node ${base}/other/dist/index.js`, cwd: base }, link, UID)).toBe(false)
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })
})

describe('web.ts wiring (pinned in source)', () => {
  const src = readFileSync(join(__dirname, '..', 'web.ts'), 'utf-8')
  it('the reclaim loop takes its victims from selectReclaimVictims, and the old node/tsx comm test is gone', () => {
    expect(src).toContain('selectReclaimVictims(pids, process.pid, readPortHolder, PROJECT_ROOT, uid)')
    expect(src).not.toMatch(/\/node\|tsx\/i\.test\(cmd\)/)
    expect(src).not.toContain('victims.push(')
  })
})

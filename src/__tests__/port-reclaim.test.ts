// PORTRECLAIM1123: the port reclaim stops only this install's own dashboard.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { isOwnDashboardProcess } from '../port-reclaim.js'

const ROOT = '/Users/someone/ClaudeClaw'
const UID = 501
const own = (command: string, cwd: string | null = '/', uid: number | null = UID) => isOwnDashboardProcess({ uid, command, cwd }, ROOT, UID)

describe('isOwnDashboardProcess', () => {
  it('this install\'s dashboard, by absolute path: yes', () => {
    expect(own(`/opt/homebrew/bin/node ${ROOT}/dist/index.js`)).toBe(true)
    expect(own(`node ${ROOT}/dist/index.js --some-flag`)).toBe(true)
    expect(own(`/usr/local/bin/tsx ${ROOT}/src/index.ts`)).toBe(true)
    expect(own(`node ${ROOT}/./dist/index.js`)).toBe(false) // not the normalised form: unknown is never stopped
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

describe('web.ts wiring (pinned in source)', () => {
  const src = readFileSync(join(__dirname, '..', 'web.ts'), 'utf-8')
  it('the reclaim loop asks isOwnDashboardProcess, and the old node/tsx comm test is gone', () => {
    expect(src).toContain('isOwnDashboardProcess(holder, PROJECT_ROOT, uid)')
    expect(src).not.toMatch(/\/node\|tsx\/i\.test\(cmd\)/)
  })
})

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// WIZNAME1 (2026-07-28, bootcamp): renaming the agent in the wizard appeared
// to do nothing on installer-started (VPS) installs. Two independent causes:
//   1. the identity save only wrote BOT_NAME when the fleet was NOT running,
//      and on a VPS the installer starts the fleet before the wizard;
//   2. config.ts freezes BOT_NAME/BRAND_NAME at module load, so even the
//      written BRAND_NAME stayed invisible until a process restart.
// These tests pin the fix: the always-write + restart decision core, and the
// fresh-read helpers the display routes now use.
//
// Sandboxed .env via the CLAUDECLAW_ENV_DIR hook (see env.test.ts): set
// BEFORE the dynamic import so neither config.js nor env.js ever touches the
// checkout's real .env.
const SANDBOX = mkdtempSync(join(tmpdir(), 'wizname-test-'))
const testEnvPath = join(SANDBOX, '.env')

beforeAll(() => {
  process.env.CLAUDECLAW_ENV_DIR = SANDBOX
  writeFileSync(testEnvPath, 'BOT_NAME=BootName\n')
})

afterAll(() => {
  delete process.env.CLAUDECLAW_ENV_DIR
  rmSync(SANDBOX, { recursive: true, force: true })
})

describe('currentBotName / currentBrandName (fresh per-call reads)', () => {
  it('reflects a post-import BOT_NAME change without a restart, while the module const stays frozen', async () => {
    const cfg = await import('../config.js')
    expect(cfg.BOT_NAME).toBe('BootName')
    expect(cfg.currentBotName()).toBe('BootName')

    writeFileSync(testEnvPath, 'BOT_NAME=Robi\n')
    expect(cfg.BOT_NAME).toBe('BootName') // module-load snapshot: unchanged
    expect(cfg.currentBotName()).toBe('Robi') // fresh read: the rename is live
  })

  it('falls brandName back to the current bot name when BRAND_NAME is unset', async () => {
    const cfg = await import('../config.js')
    writeFileSync(testEnvPath, 'BOT_NAME=Robi\n')
    expect(cfg.currentBrandName()).toBe('Robi')
  })

  it('uses an explicit BRAND_NAME over the bot name, and ignores a blank one', async () => {
    const cfg = await import('../config.js')
    writeFileSync(testEnvPath, 'BOT_NAME=Robi\nBRAND_NAME=Acme Ops\n')
    expect(cfg.currentBrandName()).toBe('Acme Ops')
    writeFileSync(testEnvPath, 'BOT_NAME=Robi\nBRAND_NAME=\n')
    expect(cfg.currentBrandName()).toBe('Robi')
  })

  it('falls back to the boot-time name when the .env line is missing', async () => {
    const cfg = await import('../config.js')
    writeFileSync(testEnvPath, 'OTHER=1\n')
    expect(cfg.currentBotName()).toBe('BootName')
  })
})

describe('identitySavePlan (identity-save decision core)', () => {
  it('first-run save with the fleet up restarts the channels session (the VPS wizard path)', async () => {
    const { identitySavePlan } = await import('../web/routes/onboarding.js')
    expect(identitySavePlan(true, true)).toEqual({ restart: true, restartNeeded: false })
  })

  it('first-run save with no fleet does not restart anything (pre-install flow: launch picks the name up)', async () => {
    const { identitySavePlan } = await import('../web/routes/onboarding.js')
    expect(identitySavePlan(false, true)).toEqual({ restart: false, restartNeeded: false })
  })

  it('re-save on a configured running install never implicitly bounces a working fleet', async () => {
    const { identitySavePlan } = await import('../web/routes/onboarding.js')
    expect(identitySavePlan(true, false)).toEqual({ restart: false, restartNeeded: true })
  })

  it('re-save on a configured stopped install needs no restart flag either', async () => {
    const { identitySavePlan } = await import('../web/routes/onboarding.js')
    expect(identitySavePlan(false, false)).toEqual({ restart: false, restartNeeded: false })
  })
})

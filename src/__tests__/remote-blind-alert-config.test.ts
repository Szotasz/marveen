// MARVEEN_REMOTE_BLIND_ALERT_MIN must reach the watcher from where a factory user actually writes it.
// Measured on a factory install (2026-10-12): the first version read process.env only, so the
// value in .env never arrived -- /proc/<pid>/environ had no such key and the 15 min default stayed on.
// These tests import the REAL config.ts against a sandboxed .env (CLAUDECLAW_ENV_DIR). The Settings override
// file (store/config-overrides.json) sits above .env in the same cfg() and is covered by the existing cfg tests.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getSettingDefinition, validateSettingValue } from '../config-registry.js'

let dir: string
const keepEnvDir = process.env.CLAUDECLAW_ENV_DIR
const keepProc = process.env.MARVEEN_REMOTE_BLIND_ALERT_MIN

async function loadWith(envFile: string | null, procValue: string | undefined) {
  if (envFile !== null) writeFileSync(join(dir, '.env'), envFile)
  process.env.CLAUDECLAW_ENV_DIR = dir
  if (procValue === undefined) delete process.env.MARVEEN_REMOTE_BLIND_ALERT_MIN
  else process.env.MARVEEN_REMOTE_BLIND_ALERT_MIN = procValue
  vi.resetModules()
  return (await import('../config.js')).REMOTE_BLIND_ALERT_MIN_RAW
}

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'blind-cfg-')) })
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  if (keepEnvDir === undefined) delete process.env.CLAUDECLAW_ENV_DIR; else process.env.CLAUDECLAW_ENV_DIR = keepEnvDir
  if (keepProc === undefined) delete process.env.MARVEEN_REMOTE_BLIND_ALERT_MIN; else process.env.MARVEEN_REMOTE_BLIND_ALERT_MIN = keepProc
})

describe('MARVEEN_REMOTE_BLIND_ALERT_MIN reaches the watcher through cfg()', () => {
  it('a value in .env arrives (the measured factory defect)', async () => {
    expect(await loadWith('MARVEEN_REMOTE_BLIND_ALERT_MIN=2\n', undefined)).toBe('2')
  })

  it('.env wins over the process environment', async () => {
    expect(await loadWith('MARVEEN_REMOTE_BLIND_ALERT_MIN=2\n', '9')).toBe('2')
  })

  it('an EMPTY value in .env stays empty (the watcher logs it by name and uses 15), never undefined-as-off', async () => {
    expect(await loadWith('MARVEEN_REMOTE_BLIND_ALERT_MIN=\n', undefined)).toBe('')
  })

  it('without .env the process environment (systemd Environment=) is the fallback', async () => {
    expect(await loadWith(null, '7')).toBe('7')
    expect(await loadWith(null, undefined)).toBeUndefined()
  })

  it('the watcher reads the cfg() export, not process.env', () => {
    const code = readFileSync(join(process.cwd(), 'src', 'web', 'stuck-input-watcher.ts'), 'utf-8')
    expect(code).toMatch(/const raw = REMOTE_BLIND_ALERT_MIN_RAW\b/)
    expect(code).not.toMatch(/process\.env\.MARVEEN_REMOTE_BLIND_ALERT_MIN/)
  })

  it('is a registered agents setting: int 0..1440, default 15, restart needed', () => {
    const def = getSettingDefinition('MARVEEN_REMOTE_BLIND_ALERT_MIN')!
    expect(def).toBeDefined()
    expect(def.module).toBe('agents')
    expect(def.type).toBe('int')
    expect(def.default).toBe(15)
    expect(def.requiresRestart).toBe(true)
    expect(def.secret).toBe(false)
    expect(validateSettingValue(def, 0).ok).toBe(true)
    expect(validateSettingValue(def, -1).ok).toBe(false)
  })
})

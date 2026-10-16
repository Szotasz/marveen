/**
 * The rebase of #1570 onto #1600 (JSONCLOBBER926) put two rules into
 * writeMainModel, in Marveen's order (32905): the .env MAIN_AGENT_MODEL write
 * first, then the settings.json fall-through through readJsonObjectForWrite.
 * What this pins, by behaviour and not by source text:
 *  - no MAIN_AGENT_MODEL in .env, and a corrupt settings.json: the write is
 *    refused (it throws into the runner's catch) and the file is byte-for-byte
 *    what it was, not reset to {model};
 *  - MAIN_AGENT_MODEL in .env: the model goes there and a corrupt settings.json
 *    is never read, so the .env write is not blocked by a file it does not use.
 * Swapping the order makes the second case throw.
 */
import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = mkdtempSync(join(tmpdir(), 'mf-env-corrupt-'))
vi.mock('../config.js', async () => {
  const actual = await vi.importActual<typeof import('../config.js')>('../config.js')
  return { ...actual, PROJECT_ROOT: ROOT }
})
vi.mock('../logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() } }))

const { _mainModelIoForTest: io } = await import('../web/model-fallback-runner.js')
const ENV = join(ROOT, '.env')
const SETTINGS = join(ROOT, '.claude', 'settings.json')
const SERULT = '{"model": "claude-opus-5", "permissions": {'

function seed(envLines: string[]) {
  mkdirSync(join(ROOT, '.claude'), { recursive: true })
  writeFileSync(SETTINGS, SERULT)
  writeFileSync(ENV, envLines.join('\n'))
  chmodSync(ENV, 0o600)
}

describe('writeMainModel after the #1570 x #1600 rebase', () => {
  it('no MAIN_AGENT_MODEL: a corrupt settings.json is refused, not reset to {model}', () => {
    seed(['SECRET=x'])
    expect(() => io.writeMainModel('claude-sonnet-5')).toThrow()
    expect(readFileSync(SETTINGS, 'utf-8')).toBe(SERULT)
  })
  it('MAIN_AGENT_MODEL set: the write goes to .env, and the corrupt settings.json is not even read', () => {
    seed(['SECRET=x', 'MAIN_AGENT_MODEL=claude-opus-5'])
    expect(() => io.writeMainModel('claude-sonnet-5')).not.toThrow()
    expect(readFileSync(ENV, 'utf-8')).toContain('MAIN_AGENT_MODEL=claude-sonnet-5')
    expect(readFileSync(SETTINGS, 'utf-8')).toBe(SERULT)
  })
})

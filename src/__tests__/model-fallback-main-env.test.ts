/**
 * The main agent's model lives in .env MAIN_AGENT_MODEL when set (it wins over
 * .claude/settings.json in channels.sh), so the fallback runner must read and
 * write THERE -- and keep .env's mode, since it holds secrets.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = mkdtempSync(join(tmpdir(), 'mf-env-'))
vi.mock('../config.js', async () => {
  const actual = await vi.importActual<typeof import('../config.js')>('../config.js')
  return { ...actual, PROJECT_ROOT: ROOT }
})
vi.mock('../logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() } }))

const { _mainModelIoForTest: io } = await import('../web/model-fallback-runner.js')
const ENV = join(ROOT, '.env')
const SETTINGS = join(ROOT, '.claude', 'settings.json')

function seed(envLines: string[] | null, settingsModel: string) {
  mkdirSync(join(ROOT, '.claude'), { recursive: true })
  writeFileSync(SETTINGS, JSON.stringify({ model: settingsModel }))
  if (envLines) { writeFileSync(ENV, envLines.join('\n')); chmodSync(ENV, 0o600) }
  else { try { writeFileSync(ENV, '') } catch { /* */ } }
}

describe('main agent model: .env precedence', () => {
  beforeEach(() => { seed(null, 'claude-sonnet-5') })

  it('reads MAIN_AGENT_MODEL from .env over settings.json', () => {
    seed(['FOO=1', 'MAIN_AGENT_MODEL=claude-opus-5'], 'claude-sonnet-5')
    expect(io.readMainModel()).toContain('claude-opus-5')
  })

  it('writes to .env (not settings.json) when .env has MAIN_AGENT_MODEL, keeping mode 0600', () => {
    seed(['SECRET=x', 'MAIN_AGENT_MODEL=claude-opus-5'], 'claude-opus-5')
    io.writeMainModel('claude-sonnet-5')
    expect(readFileSync(ENV, 'utf-8')).toContain('MAIN_AGENT_MODEL=claude-sonnet-5')
    expect(readFileSync(ENV, 'utf-8')).toContain('SECRET=x')
    expect(JSON.parse(readFileSync(SETTINGS, 'utf-8')).model).toBe('claude-opus-5')
    expect(statSync(ENV).mode & 0o777).toBe(0o600)
  })

  it('an empty MAIN_AGENT_MODEL does not shadow settings.json, and writes go there', () => {
    seed(['MAIN_AGENT_MODEL='], 'claude-sonnet-5')
    expect(io.readMainModel()).toContain('claude-sonnet-5')
    io.writeMainModel('claude-opus-5')
    expect(JSON.parse(readFileSync(SETTINGS, 'utf-8')).model).toBe('claude-opus-5')
  })
})

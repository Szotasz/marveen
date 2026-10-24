// #2227: the production wiring of the fleet leg reads a sub-agent's real
// agent-config.json, so an agent that names its own setup-token file
// (oauthTokenFile, #1511) is not treated as a fleet-token agent and is not
// restarted when the fleet token rotates. The pure rule is covered in
// claude-plan-fleet-rotation.test.ts; this pins the binding.
import { describe, it, expect, vi, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const tmpRoot = mkdtempSync(join(tmpdir(), 'fleet-wiring-own-token-'))
afterAll(() => rmSync(tmpRoot, { recursive: true, force: true }))

vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  PROJECT_ROOT: tmpRoot,
  STORE_DIR: join(tmpRoot, 'store'),
  MAIN_AGENT_ID: 'main',
}))
// The wiring's restart side is not exercised here; keep the process layer inert.
vi.mock('../web/agent-process.js', () => ({
  FLEET_OAUTH_TOKEN_PATH: join(tmpRoot, 'store', '.claude-oauth-token'),
  isAgentRunning: () => false,
  restartAgentProcess: async () => ({ ok: true }),
  capturePane: () => '',
  startAgentProcess: async () => ({ ok: true }),
}))

const { usesFleetToken } = await import('../web/claude-plan-fleet-wiring.js')

function agent(name: string, config: Record<string, unknown> | string) {
  const dir = join(tmpRoot, 'agents', name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'agent-config.json'), typeof config === 'string' ? config : JSON.stringify(config))
}

describe('fleet wiring: own setup-token file (#2227)', () => {
  it('a plain Claude sub-agent on the shared token is a fleet-token agent (control)', () => {
    agent('plain', { model: 'claude-opus-5' })
    expect(usesFleetToken('plain')).toBe(true)
  })

  it('an agent whose agent-config.json names its own token file is not', () => {
    agent('own', { model: 'claude-opus-5', oauthTokenFile: '/Users/someone/agent-own-token' })
    expect(usesFleetToken('own')).toBe(false)
  })

  it('an invalid oauthTokenFile counts as own too (the launcher refuses rather than fall back)', () => {
    agent('broken', { model: 'claude-opus-5', oauthTokenFile: 'relative/path' })
    expect(usesFleetToken('broken')).toBe(false)
  })
})

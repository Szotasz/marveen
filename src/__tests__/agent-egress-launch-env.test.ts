// AGENTEGRESS1111: the agent's launch command carries its own vendor list choice.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const SRC = readFileSync(join(__dirname, '..', 'web', 'agent-process.ts'), 'utf-8')

describe('the launch command tells the egress hook which agent vendor list to read', () => {
  it('the piece is built from agentVendorHostsEnv for this agent and sits in the launch command, before the claude call', () => {
    expect(SRC).toContain('const agentEgressEnv = agentVendorHostsEnv(name, shSingleQuote)')
    const cmd = SRC.slice(SRC.indexOf('const buildLaunchCmd = '))
    const line = cmd.slice(0, cmd.indexOf('\n'))
    expect(line).toContain('${helperTokenEnvPiece}${agentEgressEnv}')
    expect(line.indexOf('${agentEgressEnv}')).toBeLessThan(line.indexOf('${claudeBin()}'))
  })
})

// VOICETOKENLEAK1101 PR-A0: the agent's launch command carries the helper's token choice (agent-tokens.ts helperTokenEnv).
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const SRC = readFileSync(join(__dirname, '..', 'web', 'agent-process.ts'), 'utf-8')

describe('the launch command tells marveen-api.sh which token to read', () => {
  it('the piece is built from helperTokenEnv for this agent and sits in the launch command, before the claude call', () => {
    expect(SRC).toContain('const helperTokenEnvPiece = helperTokenEnv(name, shSingleQuote)')
    const cmd = SRC.slice(SRC.indexOf('const buildLaunchCmd = '))
    const line = cmd.slice(0, cmd.indexOf('\n'))
    expect(line).toContain('${claudeConfigEnv}${helperTokenEnvPiece}')
    expect(line.indexOf('${helperTokenEnvPiece}')).toBeLessThan(line.indexOf('${claudeBin()}'))
  })
})

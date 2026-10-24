import { describe, expect, it } from 'vitest'
import { senderRoleGateEnabled, senderRoleGatePolicyArg } from '../web/agent-config.js'

// The wiring half of the sender-role gate: which agent-config.json values make
// the launcher wire scripts/hooks/sender-role-gate.py as a PreToolUse hook.
// Only the explicit "off" shapes (key absent, or a plain object whose
// riskyTools is missing/empty) are false; every malformed shape is TRUE so
// the hook is wired and fails closed on its side.
const CASES: ReadonlyArray<readonly [unknown, boolean]> = [
  [{}, false],
  [{ senderRoleGate: { riskyTools: [] } }, false],
  [{ senderRoleGate: {} }, false],
  [{ senderRoleGate: { riskyTools: ['Bash'] } }, true],
  [{ senderRoleGate: 'x' }, true],
  [{ senderRoleGate: null }, true],
  [{ senderRoleGate: [] }, true],
  [{ senderRoleGate: { riskyTools: 'Bash' } }, true],
  ['x', false],
  [null, false],
  [[], false],
]

describe('senderRoleGateEnabled', () => {
  it.each(CASES)('%j -> %s', (config, expected) => {
    expect(senderRoleGateEnabled(config)).toBe(expected)
  })
})

describe('senderRoleGatePolicyArg', () => {
  it('is null when the gate is off, and base64url of the value otherwise', () => {
    expect(senderRoleGatePolicyArg({})).toBeNull()
    expect(senderRoleGatePolicyArg({ senderRoleGate: { riskyTools: [] } })).toBeNull()
    const value = { riskyTools: ['mcp__ms365__send-mail'], roles: [{ channel: 'teams', sender: 'Ω-1', role: 'owner' }] }
    const arg = senderRoleGatePolicyArg({ senderRoleGate: value }) as string
    expect(arg).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(JSON.parse(Buffer.from(arg, 'base64url').toString('utf-8'))).toEqual(value)
    expect(JSON.parse(Buffer.from(senderRoleGatePolicyArg({ senderRoleGate: null }) as string, 'base64url').toString())).toBeNull()
  })
})

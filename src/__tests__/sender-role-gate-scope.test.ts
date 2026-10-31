// GROMZOGATECONF1030 (Dani 57892 (2), 59506, Samu 59495): the team scope (MXD_SCOPE=both) needs a sender-role gate
// that really closes tools in a colleague's turn, not only one that exists: allowTools ["*"] wires the gate and
// lets everything through. Only concrete tool names or one MCP server's prefix give the team scope.
import { describe, it, expect } from 'vitest'
import { senderRoleGateClosesTools, senderRoleGateEnabled } from '../web/agent-config.js'

const gate = (g: unknown) => ({ senderRoleGate: g })
const REPLY = 'mcp__plugin_gromzo-channel_gromzo__reply'

describe('senderRoleGateClosesTools', () => {
  it('concrete tool names close the rest', () => {
    expect(senderRoleGateClosesTools(gate({ allowTools: [REPLY, 'mcp__plugin_gromzo-channel_gromzo__typing', 'ToolSearch'] }))).toBe(true)
  })

  it("one MCP server's prefix counts", () => {
    expect(senderRoleGateClosesTools(gate({ allowTools: ['mcp__plugin_gromzo-channel_gromzo__*'] }))).toBe(true)
    expect(senderRoleGateClosesTools(gate({ allowTools: ['mcp__plugin_gromzo_channel_gromzo__*', 'ToolSearch'] }))).toBe(true)
  })

  it('any other pattern gives the owner scope, though the gate is wired (Dani 59506)', () => {
    for (const p of ['*', '**', 'mcp__*', 'B*', '*__*', '?*', 'Re?d', '[A-Z]*', 'mcp__*__*', 'mcp__x*__*', 'mcp__x__y*', 'mcp____*', ' Bash', '']) {
      expect(senderRoleGateEnabled(gate({ allowTools: [REPLY, p] })), p).toBe(true)
      expect(senderRoleGateClosesTools(gate({ allowTools: [REPLY, p] })), JSON.stringify(p)).toBe(false)
    }
  })

  it('an empty allow-list is no decision for the team: owner scope', () => {
    expect(senderRoleGateEnabled(gate({ allowTools: [] }))).toBe(true)
    expect(senderRoleGateClosesTools(gate({ allowTools: [] }))).toBe(false)
  })

  it('a deny-list alone (no allowTools) leaves a later tool open, so it does not count', () => {
    expect(senderRoleGateEnabled(gate({ riskyTools: ['Bash'] }))).toBe(true)
    expect(senderRoleGateClosesTools(gate({ riskyTools: ['Bash'] }))).toBe(false)
  })

  it('no gate, a malformed one or a non-object config does not count', () => {
    for (const cfg of [{}, null, [], 'x', gate(null), gate('x'), gate({ allowTools: 'Bash' }), gate({ allowTools: [1] })]) {
      expect(senderRoleGateClosesTools(cfg), JSON.stringify(cfg)).toBe(false)
    }
  })
})

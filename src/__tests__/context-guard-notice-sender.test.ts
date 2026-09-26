import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Guard notices to the main agent go out as 'system', never under the name of
// the agent being restarted (that polluted the agent's own sent-message ledger).

const created: unknown[][] = []
vi.mock('../db.js', () => ({ createAgentMessage: vi.fn((...a: unknown[]) => { created.push(a); return { id: 1 } }) }))
vi.mock('../config.js', async (orig) => ({ ...(await orig() as object), MAIN_AGENT_ID: 'main-agent' }))

import { postGuardNotice } from '../web/context-guard-runner.js'
import { SYSTEM_DIRECTIVE_SENDER } from '../web/system-directive.js'

describe('context-guard notice sender', () => {
  it("postGuardNotice sends from 'system' to the main agent", () => {
    postGuardNotice('[CONTEXT-GUARD] test', 'context-guard restart notice')
    expect(SYSTEM_DIRECTIVE_SENDER).toBe('system')
    expect(created[0]!.slice(0, 2)).toEqual(['system', 'main-agent'])
  })

  it('every notice in the runner goes through postGuardNotice', () => {
    const src = readFileSync(join(__dirname, '..', 'web', 'context-guard-runner.ts'), 'utf-8')
    const direct = src.match(/\bcreateAgentMessage\(/g) ?? []
    // Exactly one direct call: the one inside postGuardNotice.
    expect(direct.length).toBe(1)
    expect(src).toMatch(/function postGuardNotice[\s\S]{0,200}createAgentMessage\(SYSTEM_DIRECTIVE_SENDER,/)
    expect((src.match(/\bpostGuardNotice\(/g) ?? []).length).toBeGreaterThanOrEqual(3)
  })
})

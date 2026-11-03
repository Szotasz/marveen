// APPROVALSLACK1030 (2), Samu 65935: whose reaction approves can only be changed with the owner's session, the switch
// can only be turned ON with it, and every change of the approver is announced to the OLD one (Dani 65925).
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SETTINGS_REGISTRY } from '../config-registry.js'
import { announceSlackOwnerChange } from '../notify.js'

const def = (k: string) => SETTINGS_REGISTRY.find((d) => d.key === k)!

describe('the two settings', () => {
  it('SLACK_OWNER_USER_ID: ANY change loosens (needs the owner\'s session), keeping it does not', () => {
    const l = def('SLACK_OWNER_USER_ID').loosens!
    expect(l('U0OWNER01', 'U0OTHER01')).toBe(true)
    expect(l('', 'U0OTHER01')).toBe(true)
    expect(l('U0OWNER01', '')).toBe(true)
    expect(l('U0OWNER01', ' U0OWNER01 ')).toBe(false)
  })

  it('APPROVAL_SLACK_REACTIONS: off by default; turning it on loosens, turning it off does not', () => {
    const d = def('APPROVAL_SLACK_REACTIONS')
    expect(d.default).toBe('off')
    expect(d.loosens!('off', 'on')).toBe(true)
    expect(d.loosens!('on', 'off')).toBe(false)
    expect(d.loosens!('on', 'on')).toBe(false)
    expect(d.validate!('on')).toBeNull()
    expect(d.validate!('yes')).not.toBeNull()
  })

  it('the settings route announces a change of SLACK_OWNER_USER_ID on both paths (set and remove)', () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'web', 'routes', 'settings.ts'), 'utf-8')
    expect(src.split("if (key === 'SLACK_OWNER_USER_ID') void announceSlackOwnerChange(").length - 1).toBe(2)
  })
})

describe('announceSlackOwnerChange: the OLD owner is told', () => {
  const access = (ids: string[]) => () => JSON.stringify({ allowFrom: ids })

  it('a change from one explicit id to another DMs the OLD id with both ids', async () => {
    const sent: Array<{ text: string; owner?: string }> = []
    const r = await announceSlackOwnerChange('U0OWNER01', 'U0OTHER01', {
      readAccess: access([]), now: new Date('2026-11-02T09:00:00Z'),
      send: (async (_t: string, text: string, o: { ownerUserId?: string }) => { sent.push({ text, owner: o.ownerUserId }); return { ok: true } }) as never,
    })
    expect(r).toEqual({ sent: true })
    expect(sent).toHaveLength(1)
    expect(sent[0].owner).toBe('U0OWNER01')
    expect(sent[0].text).toContain('U0OWNER01 -> U0OTHER01')
  })

  it('the old owner from the allowFrom fallback (no explicit setting before) is told too', async () => {
    const sent: string[] = []
    await announceSlackOwnerChange('', 'U0OTHER01', { readAccess: access(['U0OWNER01']), send: (async (_t: string, _x: string, o: { ownerUserId?: string }) => { sent.push(o.ownerUserId!); return { ok: true } }) as never })
    expect(sent).toEqual(['U0OWNER01'])
  })

  it('no message when nothing changed or there was no old owner; a failed send is reported, never thrown', async () => {
    const send = (async () => ({ ok: true })) as never
    expect(await announceSlackOwnerChange('U0OWNER01', 'U0OWNER01', { readAccess: access([]), send })).toEqual({ sent: false, reason: 'unchanged' })
    expect(await announceSlackOwnerChange('', 'U0OTHER01', { readAccess: access([]), send })).toEqual({ sent: false, reason: 'no_old_owner' })
    const failing = (async () => ({ ok: false, error: 'not_allowed' })) as never
    expect(await announceSlackOwnerChange('U0OWNER01', 'U0OTHER01', { readAccess: access([]), send: failing })).toEqual({ sent: false, reason: 'not_allowed' })
  })
})

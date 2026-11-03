import { describe, it, expect, vi } from 'vitest'

// ISSUE1895 (#1895): owner-facing times follow the install zone (APP_TZ), not a
// hardcoded Europe/Budapest. With the zone set to Europe/London, the heartbeat
// header and the approval expiry are London time -- one hour behind Budapest in
// September -- which is what an install outside Central Europe must see.
vi.mock('../config.js', async (orig) => ({ ...(await orig<typeof import('../config.js')>()), APP_TZ: 'Europe/London' }))

const { stampHeartbeatHeader } = await import('../web/heartbeat-header-stamp.js')
const { buildOwnerApprovalText } = await import('../web/routes/approvals.js')

// 2026-09-08T13:00:28Z == 14:00 in Europe/London (BST), 15:00 in Europe/Budapest
const NOW = new Date('2026-09-08T13:00:28Z')

describe('the install zone, not Budapest (ISSUE1895)', () => {
  it('the heartbeat header is stamped in APP_TZ', () => {
    expect(stampHeartbeatHeader('## Heartbeat 2026-09-08 18:00', NOW)).toBe('## Heartbeat 2026-09-08 14:00')
  })

  it('the approval expiry in the owner text is APP_TZ time', () => {
    const text = buildOwnerApprovalText({
      id: 'a1', agent_id: 'tester', category: 'cat', action_description: 'do it', action_payload: null,
      status: 'pending', timeout_at: Math.floor(NOW.getTime() / 1000), telegram_message_id: null,
      requested_at: 0, resolved_at: null, resolved_by: null,
    } as never)
    expect(text).toContain(NOW.toLocaleString('hu-HU', { timeZone: 'Europe/London' }))
    expect(text).not.toContain(NOW.toLocaleString('hu-HU', { timeZone: 'Europe/Budapest' }))
  })
})

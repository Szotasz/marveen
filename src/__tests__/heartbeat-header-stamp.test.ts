import { describe, it, expect, vi } from 'vitest'

// ISSUE1895 (#1895): the header is stamped in the install zone (APP_TZ), not a
// hardcoded Europe/Budapest. These cases pin the zone to Budapest so they read the
// same on any runner (a CI host in UTC included); heartbeat-header-stamp-zone.test.ts
// covers another zone.
vi.mock('../config.js', async (orig) => ({ ...(await orig<typeof import('../config.js')>()), APP_TZ: 'Europe/Budapest' }))

const { stampHeartbeatHeader } = await import('../web/heartbeat-header-stamp.js')

// 2026-09-08T13:00:28Z == 15:00 in Europe/Budapest (CEST, UTC+2)
const NOW = new Date('2026-09-08T13:00:28Z')

describe('stampHeartbeatHeader', () => {
  it('replaces a drifted header clock with the server time (the measured +3h case)', () => {
    const content = '## Heartbeat 2026-09-08 18:00 (Europe/Budapest)\n\n### Calendar (next 2h)\n- x'
    expect(stampHeartbeatHeader(content, NOW)).toBe(
      '## Heartbeat 2026-09-08 15:00 (Europe/Budapest)\n\n### Calendar (next 2h)\n- x',
    )
  })

  it('restamps an already-correct header to the same value (idempotent surface)', () => {
    const content = '## Heartbeat 2026-09-08 15:00 (Europe/Budapest)\n\nbody'
    expect(stampHeartbeatHeader(content, NOW)).toBe(content)
  })

  it('corrects the date too, not only the hour (a midnight-crossing drift)', () => {
    const content = '## Heartbeat 2026-09-09 01:00 (Europe/Budapest)\n\nbody'
    expect(stampHeartbeatHeader(content, NOW)).toContain('## Heartbeat 2026-09-08 15:00')
  })

  it('leaves a digest quoted after other text untouched (historical label)', () => {
    const content = 'Nézd ezt a digestet:\n## Heartbeat 2026-09-08 18:00 (Europe/Budapest)\nbody'
    expect(stampHeartbeatHeader(content, NOW)).toBe(content)
  })

  it('leaves non-digest content untouched', () => {
    const content = 'Feladat KÉSZ. PR: https://example.com/1'
    expect(stampHeartbeatHeader(content, NOW)).toBe(content)
  })

  it('leaves a header without the timestamp shape untouched', () => {
    const content = '## Heartbeat woke up\nbody'
    expect(stampHeartbeatHeader(content, NOW)).toBe(content)
  })

  it('stamps in Europe/Budapest local time, not UTC', () => {
    const content = '## Heartbeat 2026-09-08 13:00 (Europe/Budapest)'
    // 13:00Z must become 15:00 local, proving the timezone conversion happens.
    expect(stampHeartbeatHeader(content, NOW)).toBe('## Heartbeat 2026-09-08 15:00 (Europe/Budapest)')
  })
})

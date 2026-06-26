import { describe, it, expect } from 'vitest'
import { looksLikeSystemDelivery } from '../pane-state.js'

// Gate for the stuck-input watcher's sub-agent plain re-inject. System
// deliveries (inter-agent / scheduled / wrapped peer blocks) are safe to
// auto-submit when parked; raw human-typed terminal text is NOT (the
// dashboard agent-terminal can leave a half-typed draft in a sub-agent pane).
describe('looksLikeSystemDelivery', () => {
  it('true for an inter-agent DM prefix (both ascii and accented forms)', () => {
    expect(looksLikeSystemDelivery('[Uzenet @balazsmarveenja-tol -- trusted team member]: szia')).toBe(true)
    expect(looksLikeSystemDelivery('[Üzenet @marveen-is-tól]: csinald meg')).toBe(true)
  })

  it('true for wrapped peer / untrusted / scheduled blocks', () => {
    expect(looksLikeSystemDelivery('<trusted-peer source="agent:x">jelzés</trusted-peer>')).toBe(true)
    expect(looksLikeSystemDelivery('<untrusted>data</untrusted>')).toBe(true)
    expect(looksLikeSystemDelivery('<scheduled-task source="scheduled-task:foo">do it</scheduled-task>')).toBe(true)
    expect(looksLikeSystemDelivery('TEAM MEMBER NOTICE -- the next block ...')).toBe(true)
    expect(looksLikeSystemDelivery('SCHEDULED TASK NOTICE -- one of YOUR OWN tasks')).toBe(true)
  })

  it('FALSE for raw human-typed terminal text -- the bug class (must not auto-submit)', () => {
    // The exact 2026-06-26 incident input: a half-typed dashboard-terminal
    // draft that must NOT be auto-submitted by the watcher.
    expect(looksLikeSystemDelivery('Szólj Ferencnek a KPI-katalógus Várda-instanciája ügyében')).toBe(false)
    expect(looksLikeSystemDelivery('küldj egy emailt Tóthnak')).toBe(false)
    expect(looksLikeSystemDelivery('nézd át az emaileket')).toBe(false)
  })

  it('false for empty / null / whitespace', () => {
    expect(looksLikeSystemDelivery('')).toBe(false)
    expect(looksLikeSystemDelivery(null)).toBe(false)
    expect(looksLikeSystemDelivery(undefined)).toBe(false)
    expect(looksLikeSystemDelivery('   ')).toBe(false)
  })

  it('false for a message that merely mentions the word "uzenet" without the @ prefix', () => {
    expect(looksLikeSystemDelivery('írj egy uzenetet Ferencnek')).toBe(false)
  })
})

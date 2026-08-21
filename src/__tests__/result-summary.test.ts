import { describe, it, expect, vi } from 'vitest'

// The route module pulls in the DB and the agent config; neither is needed to measure the
// summary rule, and both would make this test a deployment test instead.
vi.mock('../db.js', () => ({
  createAgentMessage: vi.fn(), getPendingMessages: vi.fn(), listAgentMessages: vi.fn(),
  getAgentConversation: vi.fn(), getAgentConversationThreads: vi.fn(),
  getKanbanSeqByIdPrefix: vi.fn(), markMessageDone: vi.fn(), markMessageFailed: vi.fn(),
  getAgentMessage: vi.fn(), closeOtelSpan: vi.fn(), getPendingBacklogByAgent: vi.fn(),
}))
vi.mock('../web/agent-config.js', () => ({ isKnownAgent: vi.fn(() => true) }))

const { resultSummary, RESULT_NOTIFY_MAX } = await import('../web/routes/messages.js')

describe('resultSummary -- a levagott eredmeny KOVETHETO marad', () => {
  it('a rovid eredmenyt valtozatlanul adja tovabb', () => {
    expect(resultSummary(42, 'kesz, 3 sor')).toBe('kesz, 3 sor')
  })

  it('hianyzo eredmenynel megmondja, hogy nincs -- nem ures stringet ad', () => {
    expect(resultSummary(42, undefined)).toBe('(nincs eredmény)')
    expect(resultSummary(42, '')).toBe('(nincs eredmény)')
  })

  it('a HATARON meg nem vag: pontosan RESULT_NOTIFY_MAX karakter valtozatlan', () => {
    const eppen = 'x'.repeat(RESULT_NOTIFY_MAX)
    expect(resultSummary(42, eppen)).toBe(eppen)
  })

  it('egy karakterrel a hatar folott MAR vag, es jelzi is', () => {
    const tul = 'x'.repeat(RESULT_NOTIFY_MAX + 1)
    const ki = resultSummary(42, tul)
    expect(ki).not.toBe(tul)
    expect(ki).toContain('levágva')
  })

  // EZ A LENYEG. A regi valtozat egy MEZOT nevezett meg ("msg N result mezoje"), amit a cimzett
  // nem tudott egy lepesben elolvasni -- ketszer is ujrakuldest kert helyette. A marker ezert
  // egy FUTTATHATO parancsot tartalmaz, a KONKRET azonositoval.
  it('a marker futtathato parancsot ad, a valodi uzenet-azonositoval', () => {
    const ki = resultSummary(1767, 'y'.repeat(RESULT_NOTIFY_MAX + 500))
    expect(ki).toContain('bash scripts/agent-msg-get.sh 1767')
    // A mutato MEGMONDJA, mire mutat: a megnevezett id nem az olvasott uzenete. Enelkul
    // egy agens a sajat id-jevel kerdezte le, ures valaszt kapott, es adatvesztest jelentett volna.
    expect(ki).toContain('NEM ennek az üzenetnek az id-je')
  })

  it('megmondja, MENNYI maradt le -- kulonben nem tudni, erdemes-e utananezni', () => {
    const ki = resultSummary(7, 'z'.repeat(RESULT_NOTIFY_MAX + 137))
    expect(ki).toContain('137 karakter')
  })

  it('a tovabbitott resz a MEG NEM VAGOTT eleje, nem valami rovidebb kivonat', () => {
    const eredeti = 'A'.repeat(RESULT_NOTIFY_MAX) + 'B'.repeat(50)
    const ki = resultSummary(9, eredeti)
    expect(ki.startsWith('A'.repeat(RESULT_NOTIFY_MAX))).toBe(true)
    expect(ki).not.toContain('B')
  })

  // A hatar NEM lehet akarmi: egy tul kicsi ertek pont azt a hibat hozna vissza, ami miatt ez
  // a fuggveny letezik (a vagas a lenyeg kozepere esett), egy vegtelen pedig a cimzett
  // kontextusat koltene el a beleegyezese nelkul. Mindket irany merve.
  it('a hatar tagas, de veges', () => {
    expect(RESULT_NOTIFY_MAX).toBeGreaterThanOrEqual(1500)
    expect(RESULT_NOTIFY_MAX).toBeLessThanOrEqual(8000)
  })
})

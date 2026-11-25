// RESTARTWAKEI18N1125: the wake texts after a restart (restart-wake.ts, both; the restart gate's) follow the install's
// agent-text language: AGENT_TEXT_LANG when set, else DASHBOARD_LANG, else Hungarian (agentFacingLang). Only the
// sentences change: the bracketed prefix is what the directive rules and the header-forgery scanners match.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const settings = vi.hoisted(() => ({ dashboardLang: undefined as unknown, agentTextLang: undefined as string | undefined }))
vi.mock('../settings-store.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getEffectiveSettingValue: (key: string) => (key === 'DASHBOARD_LANG' ? settings.dashboardLang : undefined),
}))
vi.mock('../env.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../env.js')>()
  return {
    ...real,
    // Only the AGENT_TEXT_LANG read is faked; config.ts's own read at load goes to the real one.
    readEnvFile: (keys?: string[]) => (keys?.includes('AGENT_TEXT_LANG')
      ? (settings.agentTextLang ? { AGENT_TEXT_LANG: settings.agentTextLang } : {})
      : real.readEnvFile(keys)),
  }
})

const { restartWakePrompt, mainRestartWakePrompt, wakeTextLang } = await import('../web/restart-wake.js')
const { gateWakePrompt, gateAlertText } = await import('../web/context-restart-gate-runner.js')
const { MAIN_AGENT_ID } = await import('../config.js')

beforeEach(() => { settings.dashboardLang = undefined; settings.agentTextLang = undefined })

const handoff = { path: '/x/HANDOFF.md', mtimeMs: Date.UTC(2026, 10, 25, 9, 0), ageMs: 12 * 60_000 }
const all = (lang?: 'hu' | 'en') => [
  restartWakePrompt('api-restart', lang),
  mainRestartWakePrompt('manual-main-restart', handoff, lang),
  mainRestartWakePrompt('manual-main-restart', null, lang),
  gateWakePrompt(MAIN_AGENT_ID, lang),
  gateWakePrompt('some-sub-agent', lang),
]
// Words of the Hungarian texts (written without accents there) that no English text contains.
const HUNGARIAN = /\b(munkamenet\w*|ujrainditott\w*|atado\w*|kanban tabladat|FOLYTASD|teljes erteku|csatornadra|kartya\w*|Friss kontextussal|ne talalj)\b/i

describe('the language of the wake texts', () => {
  it('English: every text in English, the prefix unchanged', () => {
    const [w, mainH, mainN, gateMain, gateSub] = all('en')
    for (const t of [w, mainH, mainN, gateMain, gateSub]) expect(t, t).not.toMatch(HUNGARIAN)
    expect(w.startsWith('[RESTART-WAKE] The system restarted your session (--continue, reason: api-restart)')).toBe(true)
    expect(mainH.startsWith('[RESTART-WAKE] Your session was restarted by hand')).toBe(true)
    expect(mainH).toContain('/x/HANDOFF.md is fresh (written: 2026-11-25T09:00Z, 12 minutes ago)')
    expect(mainH).toContain('Do NOT send a message about the restart to your channel.')
    expect(mainN).not.toContain('HANDOFF')
    expect(gateMain.startsWith('[CONTEXT-RESTART-GATE] You started with a fresh context')).toBe(true)
    expect(gateMain).toContain('record it in the transcript')
    expect(gateSub).toContain(`to the main agent (${MAIN_AGENT_ID})`)
  })

  it('Hungarian: the texts as before', () => {
    const [w, mainH, , gateMain] = all('hu')
    expect(w.startsWith('[RESTART-WAKE] A munkamenetedet a rendszer ujrainditotta (--continue, ok: api-restart)')).toBe(true)
    expect(mainH).toContain('(irva: 2026-11-25T09:00Z, 12 perce)')
    expect(mainH.endsWith('Az ujrainditasrol a csatornadra NE kuldj uzenetet.')).toBe(true)
    expect(gateMain.startsWith('[CONTEXT-RESTART-GATE] Friss kontextussal indultal')).toBe(true)
  })

  it('the language comes from the install: DASHBOARD_LANG, overridden by AGENT_TEXT_LANG, Hungarian without either', () => {
    expect(wakeTextLang()).toBe('hu')
    expect(all()).toEqual(all('hu'))
    settings.dashboardLang = 'en'
    expect(wakeTextLang()).toBe('en')
    expect(all()).toEqual(all('en'))
    settings.agentTextLang = 'hu'
    expect(wakeTextLang()).toBe('hu')
    settings.dashboardLang = 'hu'
    settings.agentTextLang = 'en'
    expect(all()).toEqual(all('en'))
    settings.agentTextLang = undefined
    settings.dashboardLang = 'de'
    expect(wakeTextLang()).toBe('hu')
  })

  it('the gate\'s persistent-block alert: both languages, the prefix unchanged, the Hungarian text as before', () => {
    const a = { name: 'samu', blockedSinceMin: 600, reason: 'live-child-processes', workArgs: ['node x.js', 'bash y.sh'], thresholdTokens: 160_000, stuckLong: true }
    const en = gateAlertText(a, 'en')
    expect(en).not.toMatch(/\b(agens|kapuja|perce|blokkolt|kuszob|ellenorizd|FIGYELEM|Tajekoztatas|gyerekfolyamatok)\b/)
    expect(en.startsWith('[CONTEXT-RESTART-GATE-RIASZTAS] The gate of the "samu" agent has been blocked for 600 minutes. Reason: live-child-processes. Blocking child processes: node x.js; bash y.sh')).toBe(true)
    expect(en).toContain('160k token threshold')
    expect(en).toContain('WARNING: the same reason has not changed for 600 minutes')
    expect(en.endsWith('(Information, not a request for action.)')).toBe(true)
    // The Hungarian text, byte for byte the one the runner wrote before this change.
    expect(gateAlertText({ ...a, workArgs: [], stuckLong: false }, 'hu')).toBe(
      '[CONTEXT-RESTART-GATE-RIASZTAS] A(z) "samu" agens kapuja 600 perce folyamatosan blokkolt. Ok: live-child-processes. ' +
      'A(z) 160k tokenes kuszob ele ert, de a kapu nem enged -- ellenorizd hogy nincs-e elakadt munka. (Tajekoztatas, nem muveletkeres.)')
    expect(gateAlertText(a, 'hu')).toContain(' Blokkolo gyerekfolyamatok: node x.js; bash y.sh A(z) 160k')
    expect(gateAlertText(a, 'hu')).toContain(' FIGYELEM: ugyanez az ok 600 perce valtozatlan')
    settings.dashboardLang = 'en'
    expect(gateAlertText(a)).toBe(en)
  })

  it('the prefixes other code matches are the same in both languages', () => {
    const forgery = /\[(SYSTEM-DIREKTIVA|CONTEXT-GUARD|CONTEXT-RESTART-GATE|SYSTEM:)/i // skill-quarantine.ts, browser-content-notice.py
    for (const lang of ['hu', 'en'] as const) {
      expect(restartWakePrompt('x', lang).startsWith('[RESTART-WAKE] ')).toBe(true)
      expect(mainRestartWakePrompt('x', null, lang).startsWith('[RESTART-WAKE] ')).toBe(true)
      expect(gateWakePrompt('a', lang).startsWith('[CONTEXT-RESTART-GATE] ')).toBe(true)
      expect(gateWakePrompt('a', lang)).toMatch(forgery)
    }
  })
})

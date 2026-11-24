import { describe, it, expect } from 'vitest'
import { parseRapidExits, decideMainDown, mainDownText, mainRecoveredText } from '../web/main-down-alert.js'

const LOG = [
  '2026-11-24 21:34:20 channels.sh: main-agent isolated CLAUDE_CONFIG_DIR=/x',
  '2026-11-24 21:13:35 rapid-exit after 5s reason=pane-dead pane_status=126',
  'garbage line',
  '2026-11-24 21:21:27 rapid-exit after 5s reason=pane-dead pane_status=126',
  '2026-11-24 21:29:20 rapid-exit after 6s reason=session-gone',
].join('\n')

const t = (hms: string) => new Date(`2026-11-24T${hms}`).getTime()

describe('parseRapidExits', () => {
  it('keeps only rapid-exit lines, with reason and optional pane status', () => {
    const e = parseRapidExits(LOG)
    expect(e).toHaveLength(3)
    expect(e[0]).toEqual({ at: t('21:13:35'), reason: 'pane-dead', paneStatus: '126' })
    expect(e[2]).toEqual({ at: t('21:29:20'), reason: 'session-gone', paneStatus: null })
  })
})

describe('decideMainDown', () => {
  const exits = parseRapidExits(LOG)
  const idle = { alerted: false, firstAt: null }

  it('fires on a fresh streak of 3+', () => {
    const d = decideMainDown(exits, t('21:35:00'), idle)
    expect(d.action).toBe('down')
    if (d.action === 'down') {
      expect(d.streak).toBe(3)
      expect(d.firstAt).toBe(t('21:13:35'))
      expect(d.next.alerted).toBe(true)
    }
  })

  it('stays quiet below the streak threshold', () => {
    expect(decideMainDown(exits.slice(0, 2), t('21:30:00'), idle).action).toBe('none')
  })

  it('a stale streak (recovered session, file not yet cleared) is not "down"', () => {
    expect(decideMainDown(exits, t('22:00:00'), idle).action).toBe('none')
  })

  it('reports recovery once after an alert, then goes quiet', () => {
    const d = decideMainDown(exits, t('22:00:00'), { alerted: true, firstAt: t('21:13:35') })
    expect(d.action).toBe('recovered')
    if (d.action === 'recovered') expect(d.downMinutes).toBe(46)
    expect(decideMainDown(exits, t('22:01:00'), d.next).action).toBe('none')
  })

  it('a cleared file (normal exit) after an alert is also recovery', () => {
    expect(decideMainDown([], t('22:00:00'), { alerted: true, firstAt: t('21:13:35') }).action).toBe('recovered')
  })
})

describe('texts', () => {
  it('names the 126 case and the manual fix', () => {
    const e = parseRapidExits(LOG)
    const s = mainDownText('dojo-channels', 3, e[0].at, e[1], t('21:35:00'))
    expect(s).toContain('NEM áll fel')
    expect(s).toContain('kilépési kód 126')
    expect(s).toContain('npm install -g')
    expect(mainRecoveredText('dojo-channels', 46)).toContain('újra fut')
  })
})

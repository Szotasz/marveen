// #2390 (part 1): owner-facing alerts are written with full Hungarian accents (owner rule).
// The texts below were sent without accents; each unaccented form must stay gone from the
// alert sources, and the two pure text builders must produce the accented wording.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { routineAlertSuffix } from '../web/routine-alert.js'

const read = (rel: string) => readFileSync(join(__dirname, '..', rel), 'utf-8')

// The exact unaccented phrases that were in owner alerts before #2390.
const GONE: Array<[file: string, phrase: string]> = [
  ['web/channel-monitor.ts', 'Session resume nem segitett'],
  ['web/channel-monitor.ts', 'elinditva a ${session}'],
  ['web/channel-monitor.ts', 'sem sikerult a ${session}'],
  ['web/channel-monitor.ts', 'session eltunt -- ujrainditom'],
  ['web/channel-monitor.ts', 'Enelkul minden utemezett feladat'],
  ['web/channel-monitor.ts', 'resume suketen jott fel'],
  ['web/channel-monitor.ts', 'a beszelgetes elveszik, memoria marad'],
  ['web/channel-monitor.ts', 'a panel tetlen es a beviteli mezo ures'],
  ['web/channel-monitor.ts', 'riasztas lezarva'],
  ['web/channel-monitor.ts', 'Kezi beavatkozas kell: inditsd ujra'],
  ['web/channel-monitor.ts', 'Hard restart SEM segitett. Kezzel kell megnezni'],
  ['web/channel-monitor.ts', 'plugin meg mindig halott. Nezd meg kezzel.'],
  ['web/channel-monitor.ts', 'kapcsolat helyreallt'],
  ['web/channel-monitor.ts', 'Ha a kieses alatt irtal es nem jott valasz, mindjart potolom.'],
  ['web/routine-alert.ts', 'Az elmult '],
  ['web/routine-alert.ts', 'Ha nem all le magatol, nezz ra.'],
]

describe('owner alerts carry Hungarian accents (#2390)', () => {
  it.each(GONE)('%s no longer sends "%s"', (file, phrase) => {
    expect(read(file)).not.toContain(phrase)
  })

  it('the accented replacements are what the alerts now say', () => {
    const cm = read('web/channel-monitor.ts')
    for (const phrase of [
      'Session resume nem segített. Hard restart',
      'session eltűnt -- újraindítom (channels.sh). Enélkül minden ütemezett feladat',
      'A --continue resume süketen jött fel',
      'a panel tétlen és a beviteli mező üres. A beragadt-bemenet riasztás lezárva.',
      'Kézi beavatkozás kell: indítsd újra a ${SERVICE_ID}-channels szolgáltatást.',
      'Hard restart SEM segített. Kézzel kell megnézni',
      'plugin még mindig halott. Nézd meg kézzel.',
      'kapcsolat helyreállt (${downedFor}s kiesés, ${stage} szint).',
      'Ha a kiesés alatt írtál és nem jött válasz, mindjárt pótolom.',
    ]) expect(cm).toContain(phrase)
  })

  it('the routine repeat suffix is accented', () => {
    const s = routineAlertSuffix(2, 30 * 60_000)
    expect(s).toContain('Az elmúlt 30 percben 3 ilyen volt.')
    expect(s).toContain('Ha nem áll le magától, nézz rá.')
  })
})

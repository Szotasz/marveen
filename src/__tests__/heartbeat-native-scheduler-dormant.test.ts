import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

// HBDBKUSZOB823 -- A WAKE-UP GATE, not documentation.
//
// src/heartbeat.ts still exports a full notification filter (shouldNotify),
// and it is still unit-tested (heartbeat-calendar-fail-open.test.ts pins its
// 22:00 curfew), so it LOOKS like a working filter. It is not running: the
// 2026-06-02 architecture switch moved the hourly summary to the `heartbeat`
// sub-agent via the scheduled-task runner, and index.ts deliberately never
// calls initHeartbeat() (see its comment there). Measured 2026-09-13 on the
// live host: zero "Heartbeat ellenorzes indul" lines in store/dashboard.log
// against 580 other heartbeat lines in the same file.
//
// Why a test and not a comment: the module carries a defect that only bites
// on revival, and a comment does not fire at the moment someone reintroduces
// it. Whoever starts the native scheduler again lands here first.
//
// WHAT THIS DOES NOT CATCH, said plainly: it matches call sites textually, so
// an aliased or dynamically-dispatched call (`const f = initHeartbeat; f()`)
// walks past it. It is aimed at the realistic revival -- a literal
// initHeartbeat() call added back to the boot path -- not at an adversary.

const SRC = join(__dirname, '..')

function tsFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    if (entry === '__tests__' || entry === 'node_modules') continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...tsFiles(full))
    else if (entry.endsWith('.ts')) out.push(full)
  }
  return out
}

describe('the native heartbeat scheduler stays dormant', () => {
  it('nobody calls initHeartbeat() -- and if you are here to change that, read the message', () => {
    const callSites: string[] = []
    for (const file of tsFiles(SRC)) {
      const body = readFileSync(file, 'utf8')
      body.split('\n').forEach((line, i) => {
        if (!line.includes('initHeartbeat(')) return
        // The definition itself and the (kept) import are not call sites.
        if (/export\s+function\s+initHeartbeat\(/.test(line)) return
        if (/^\s*import\s|from '\.\/heartbeat\.js'/.test(line)) return
        callSites.push(`${file.slice(SRC.length + 1)}:${i + 1}: ${line.trim()}`)
      })
    }
    expect(callSites, [
      'A NATIV HEARTBEAT-UTEMEZOT VALAKI UJRA ELINDITJA. Elotte KET dolgot kell rendezni,',
      'kulonben a fo-agens ertesites-szuroje gyakorlatilag kikapcsolva indul ujra:',
      '',
      '  1. src/heartbeat.ts shouldNotify(): a `if (data.system.dbWarning) return true` a',
      '     FUGGVENY ELSO sora, tehat megkeruli a 22:00-as csendes ablakot, az esti',
      '     urgent-only es a hetvegi szurot is. Vidd a csendes ablak ALA.',
      '  2. src/heartbeat.ts collectSystem(): a kuszob hardkodolt `dbSize > 100`. Az',
      '     abszolut meret itt ROSSZ MUSZER: a DB merete tervezesbol korlatos (2026-09-13:',
      '     481,7 MB, ~65 % a naponta nyesett token-naplo), tehat a feltetel SOHA nem lehet',
      '     hamis -- a szuro allando megkerulese nem hiba-allapot, hanem az uzemszeru allapot.',
      '     Ha kell kuszob, config-kulcs legyen; a valodi jel viszont a nyeses-lemaradas,',
      '     ami mar meg van irva: db.ts getTokenPruneLag().',
      '',
      'Talalt hivas(ok):',
      ...callSites,
    ].join('\n')).toEqual([])
  })

  it('POSITIVE CONTROL: the detector really finds a call site when one exists', () => {
    // Without this, "zero call sites" could equally mean "the matcher is
    // broken" -- the same green-looking nothing the dead filter itself is.
    const sample = [
      "import { initHeartbeat } from './heartbeat.js'",
      '  initHeartbeat()',
    ]
    const hits = sample.filter((line) =>
      line.includes('initHeartbeat(')
      && !/export\s+function\s+initHeartbeat\(/.test(line)
      && !/^\s*import\s|from '\.\/heartbeat\.js'/.test(line))
    expect(hits).toEqual(['  initHeartbeat()'])
  })
})

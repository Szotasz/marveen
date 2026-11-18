import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'

// fleet decision 2026-10-15 ("Legyen").
//
// scripts/kapu-leltar.mjs answers one question: which gate has a test, and which
// test marks a negative control. The number it prints is only worth something if
// the inventory itself is not quietly measuring the wrong set -- which is the very
// defect the card is about (three measured cases where a gate ran, stayed green,
// and was not looking at what we thought).

const ROOT = join(__dirname, '..', '..')

function leltar(): {
  sorok: { kapu: string; tesztek: string[]; negativKontroll: string[] }[]
  osszegzes: { kapu: number; nincsTeszt: number; nincsNegativKontroll: number; teljes: number }
} {
  const out = execFileSync('node', [join(ROOT, 'scripts', 'kapu-leltar.mjs'), '--json'], {
    encoding: 'utf-8',
    cwd: ROOT,
  })
  return JSON.parse(out)
}

describe('kapu-leltar', () => {
  const r = leltar()

  it('finds the gates that exist on this install', () => {
    expect(r.osszegzes.kapu).toBeGreaterThan(20)
    const nevek = r.sorok.map((s) => s.kapu)
    expect(nevek).toContain('scripts/email-send-gate.mjs')
    expect(nevek).toContain('scripts/hooks/provenance-gate.py')
  })

  it('the three buckets are consistent with the rows', () => {
    const nincsTeszt = r.sorok.filter((s) => s.tesztek.length === 0)
    const teljes = r.sorok.filter((s) => s.negativKontroll.length > 0)
    expect(nincsTeszt.length).toBe(r.osszegzes.nincsTeszt)
    expect(teljes.length).toBe(r.osszegzes.teljes)
    // a marked control is always one of the referencing tests, never a stray file
    for (const s of teljes) {
      for (const t of s.negativKontroll) expect(s.tesztek).toContain(t)
    }
  })

  it('a gate with many tests is not reported as untested', () => {
    const sor = r.sorok.find((s) => s.kapu === 'scripts/email-send-gate.mjs')
    expect(sor, 'email-send-gate.mjs missing from the inventory').toBeDefined()
    expect(sor!.tesztek.length).toBeGreaterThan(0)
  })

  // NEGATIV KONTROLL. The inventory must not count the things that merely LOOK
  // like gates: a gate's own test file, and the script that INSTALLS a gate. Both
  // exist here (test_garmin_run_gate.py, install-secret-gate-hook.sh). Without the
  // exclusion the count inflates and -- worse -- a test file would be reported as
  // an untested gate, which reads as a hole that is not there. Remove the filter
  // and this test goes red.
  it('does not count test files or installers as gates', () => {
    const nevek = r.sorok.map((s) => s.kapu)
    expect(nevek).not.toContain('scripts/test_garmin_run_gate.py')
    expect(nevek).not.toContain('scripts/test_memoria_heartbeat_gate.py')
    expect(nevek).not.toContain('scripts/install-secret-gate-hook.sh')
    expect(nevek.some((n) => n.includes('.test.'))).toBe(false)
  })
})

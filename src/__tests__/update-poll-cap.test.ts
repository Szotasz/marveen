// UPDATEUIPLAFON1120 (#2991): the dashboard's update poll (pollUpdateOutcome in
// web/app.js) must outlast the finalizer's worst case, or a dead new build ends
// in "status did not arrive in time" instead of "rolled back" / "failed". The
// UI cannot read update.sh at run time, so it mirrors the health figure in
// FINALIZER_HEALTH_WORST_S. This test derives that figure from the finalizer's
// own _health loop and its call count, so a change to the health window fails
// here until the UI cap follows it.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(__dirname, '..', '..')
const UPDATE_SH = readFileSync(join(ROOT, 'update.sh'), 'utf-8')
const APP_JS = readFileSync(join(ROOT, 'web', 'app.js'), 'utf-8')

// The detached finalizer is the quoted FINALIZE_EOF heredoc inside update.sh.
function finalizerSource(): string {
  const start = UPDATE_SH.indexOf(`cat > "$FINALIZE_SCRIPT" <<'FINALIZE_EOF'`)
  const end = UPDATE_SH.indexOf('\nFINALIZE_EOF\n', start)
  expect(start, 'finalizer heredoc start').toBeGreaterThan(-1)
  expect(end, 'finalizer heredoc end').toBeGreaterThan(start)
  return UPDATE_SH.slice(start, end)
}

function num(src: string, rx: RegExp, what: string): number {
  const m = rx.exec(src)
  expect(m, what).not.toBeNull()
  return Number(m![1])
}

function appConst(name: string): number {
  return num(APP_JS, new RegExp(`^const ${name} = (\\d+)$`, 'm'), `web/app.js const ${name}`)
}

describe('update UI poll cap vs the finalizer health window (#2991)', () => {
  const fin = finalizerSource()
  const health = /^_health\(\) \{.*?return 1; \}$/ms.exec(fin)?.[0] ?? ''

  it('the UI health figure equals the worst case of one finalizer _health', () => {
    expect(health, '_health() in the finalizer').not.toBe('')
    const attempts = num(health, /\[ "\$i" -lt (\d+) \]/, 'attempt bound')
    const deadline = num(health, /deadline=\$\(\( SECONDS \+ (\d+) \)\)/, 'time bound')
    const curlMax = num(health, /curl -fsS -m (\d+) /, 'curl -m')
    const sleep = num(health, /sleep (\d+);/, 'sleep')
    // The loop stops at whichever bound comes first; the last attempt may start just before the deadline.
    const worst = Math.min(attempts * (curlMax + sleep), deadline + curlMax + sleep)
    expect(appConst('FINALIZER_HEALTH_WORST_S')).toBe(worst)
  })

  it('the cap counts every _health the finalizer can run', () => {
    const calls = fin.split('\n').filter((l) => /^\s*if _health; then/.test(l)).length
    expect(calls).toBe(2)
    expect(APP_JS).toContain('const UPDATE_POLL_CAP_MS = (2 * FINALIZER_HEALTH_WORST_S + UPDATE_BUILD_HEADROOM_S) * 1000')
  })

  it('pollUpdateOutcome stops at that cap, and the build headroom is at least the 5 minutes it used to be in total', () => {
    const fn = /async function pollUpdateOutcome\(resetBtn\) \{[\s\S]*?\n\}\n/.exec(APP_JS)?.[0] ?? ''
    expect(fn).toContain('const deadline = startedAt + UPDATE_POLL_CAP_MS')
    expect(appConst('UPDATE_BUILD_HEADROOM_S')).toBeGreaterThanOrEqual(300)
  })
})

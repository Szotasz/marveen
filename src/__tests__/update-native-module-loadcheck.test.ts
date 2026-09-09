import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// #950: on a host whose Node moved to 24+, `npm rebuild better-sqlite3
// --build-from-source` no longer compiled AND deleted the working
// better_sqlite3.node. update.sh ran it with `|| true`, so the update
// proceeded to a restart with no native module, and every rollback path ran
// the SAME failing command -- the "safety net" depended on the operation that
// failed. The fix: move to a Node-API build (better-sqlite3 13.x, stable ABI,
// prebuilt binaries), stop forcing a source build, and gate the restart on the
// module actually LOADING.
const ROOT = join(__dirname, '..', '..')
const UPDATE = readFileSync(join(ROOT, 'update.sh'), 'utf-8')
const PKG = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8')) as {
  dependencies: Record<string, string>
  engines: { node: string }
}

describe('update.sh native-module handling (#950)', () => {
  it('never rebuilds better-sqlite3 --build-from-source (that command deleted the working binary)', () => {
    // Only a real invocation counts; the explanatory comment naming the flag is fine.
    const invocations = UPDATE.split('\n').filter(
      (l) => !l.trimStart().startsWith('#') && l.includes('better-sqlite3 --build-from-source'),
    )
    expect(invocations).toEqual([])
  })

  it('defines a load check and uses it to gate the update before restart', () => {
    expect(UPDATE).toContain('native_module_loads()')
    // The gate must roll back on a module that does not load.
    const gate = UPDATE.indexOf('if ! native_module_loads; then')
    expect(gate).toBeGreaterThan(-1)
  })

  it('pins better-sqlite3 to the Node-API line (>=13)', () => {
    const spec = PKG.dependencies['better-sqlite3']
    const major = parseInt(spec.replace(/[^0-9.]/g, '').split('.')[0], 10)
    expect(major).toBeGreaterThanOrEqual(13)
  })

  it('no longer caps the supported Node version below 24', () => {
    // The "<24" upper bound is exactly what made a current-Node install trip
    // EBADENGINE (#735) and hit the ABI trap (#950).
    expect(PKG.engines.node).not.toContain('<24')
  })

  it('keeps the lower bound at Node 22 (better-sqlite3 13.x requires >=22)', () => {
    expect(PKG.engines.node).toMatch(/>=\s*22/)
  })

  it('the rollback path names the running Node version so a Node 20 host learns why', () => {
    // Anchor on the restart gate (not the earlier prebuild rebuild that shares
    // the native_module_loads guard).
    const gate = UPDATE.indexOf('verify the native module actually loads before we restart')
    expect(gate).toBeGreaterThan(-1)
    const tail = UPDATE.slice(gate, gate + 1400)
    expect(tail).toContain('node -v')
    expect(tail).toContain('Node 22')
  })
})

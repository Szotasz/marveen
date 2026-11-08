// GROMZONOPROVIDER1108: install-macos.sh's Bun path now has BUNTIMEOUT1108's time limits. macOS has no `timeout`,
// so _mac_timeout falls back to the system perl, which runs the command in its own process group and signals the
// whole group at the limit. These run the REAL function (sliced out of install-macos.sh) with a PATH that has neither
// timeout nor gtimeout, so the perl branch is what is measured.
import { describe, it, expect } from 'vitest'
import { readFileSync, mkdtempSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

const MAC = readFileSync(join(__dirname, '..', '..', 'install-macos.sh'), 'utf8')
const HAVE_PERL = existsSync('/usr/bin/perl')

function sliceFn(src: string, name: string): string {
  const start = src.indexOf(`${name}() {`)
  if (start < 0) throw new Error(`${name} not found`)
  let i = src.indexOf('{', start) + 1
  let depth = 1
  while (depth > 0) { if (src[i] === '{') depth++; else if (src[i] === '}') depth--; i++ }
  return src.slice(start, i)
}
const FN = sliceFn(MAC, '_mac_timeout')
const run = (cmd: string) => {
  const t0 = Date.now()
  const r = spawnSync('/bin/bash', ['-c', `${FN}\n${cmd}\necho "RC=$?"`], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } })
  return { out: r.stdout, ms: Date.now() - t0 }
}

describe.skipIf(!HAVE_PERL)('_mac_timeout without timeout(1): the perl process-group watchdog', () => {
  it('precondition: the test PATH has no timeout or gtimeout (so the perl branch runs)', () => {
    expect(spawnSync('/bin/bash', ['-c', 'command -v timeout || command -v gtimeout'], { env: { PATH: '/usr/bin:/bin' } }).status).not.toBe(0)
  })
  it('a command within the limit: its own exit code passes through', () => {
    expect(run('_mac_timeout 5 /bin/sh -c "exit 7"').out).toContain('RC=7')
    expect(run('_mac_timeout 5 /bin/sh -c "exit 0"').out).toContain('RC=0')
  })
  it('past the limit: exit 124, and the background child of the command is killed too (the whole group)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mac-to-'))
    const r = run(`_mac_timeout 1 /bin/bash -c '(sleep 3; touch "${dir}/late") & sleep 30'`)
    expect(r.out).toContain('RC=124')
    expect(r.ms).toBeLessThan(15_000)
    spawnSync('/bin/sleep', ['4'])
    expect(existsSync(join(dir, 'late'))).toBe(false)
  }, 30_000)
})

describe('install-macos.sh: Bun only for Bun channels, after the choice, with the ported BUNTIMEOUT helpers', () => {
  it('no bare `curl | bash` for Bun is left; the helpers are there and use _mac_timeout', () => {
    // code lines only: comments and the printed fix hints (echo ... curl | bash) are not executions
    const code = MAC.split('\n').filter((l) => !l.trimStart().startsWith('#') && !/\becho\b/.test(l)).join('\n')
    expect(code).not.toMatch(/curl[^\n]*bun\.sh\/install[^\n]*\|\s*bash/)
    for (const f of ['_run_remote_installer', '_install_bun_from_npm', '_install_bun']) expect(MAC).toContain(`${f}() {`)
    expect(sliceFn(MAC, '_run_remote_installer')).toContain('_mac_timeout "${REMOTE_INSTALL_TIMEOUT:-300}" bash "$script"')
  })
  it('the bun-install step: telegram|discord install it, everything else skips; it comes after the channel choice', () => {
    const step = MAC.slice(MAC.indexOf('INSTALL_STEP="bun-install"'), MAC.indexOf('INSTALL_STEP="npm-install"'))
    expect(step).toMatch(/case "\$CHANNEL_PROVIDER" in\n  telegram\|discord\)\n[\s\S]*?\n\s+_install_bun\n[\s\S]*?\n  \*\)\n\s+ok "Bun nem kell/)
    expect(MAC.indexOf('INSTALL_STEP="bun-install"')).toBeGreaterThan(MAC.indexOf('CHANNEL_PROVIDER="gromzo"'))
  })
})

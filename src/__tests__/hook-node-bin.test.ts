import { describe, it, expect } from 'vitest'
import { resolveHookNodeBin } from '../web/agent-scaffold.js'

// Issue #2036: a brew upgrade deletes the version-pinned Cellar dir that
// process.execPath points at, and every gate then blocks until a restart.
// The stable opt symlink is burnt in instead -- but only when it provably
// resolves to the same binary; everything else keeps execPath.

const CELLAR = '/opt/homebrew/Cellar/node@22/22.23.1/bin/node'
const OPT = '/opt/homebrew/opt/node@22/bin/node'

function fakeFs(links: Record<string, string>) {
  return {
    existsSync: (p: string) => p in links,
    realpathSync: (p: string) => {
      if (!(p in links)) throw new Error(`ENOENT: ${p}`)
      return links[p]
    },
  }
}

describe('resolveHookNodeBin', () => {
  it('uses the brew opt symlink when it resolves to the running Cellar node', () => {
    const fs = fakeFs({ [CELLAR]: CELLAR, [OPT]: CELLAR })
    expect(resolveHookNodeBin(CELLAR, fs)).toBe(OPT)
  })

  it('works for the unversioned node formula and other brew prefixes', () => {
    const cellar = '/usr/local/Cellar/node/24.1.0/bin/node'
    const opt = '/usr/local/opt/node/bin/node'
    expect(resolveHookNodeBin(cellar, fakeFs({ [cellar]: cellar, [opt]: cellar }))).toBe(opt)
  })

  it('keeps execPath when the opt symlink is missing', () => {
    expect(resolveHookNodeBin(CELLAR, fakeFs({ [CELLAR]: CELLAR }))).toBe(CELLAR)
  })

  it('keeps execPath when the opt symlink points at a different binary', () => {
    const other = '/opt/homebrew/Cellar/node@22/22.24.0/bin/node'
    const fs = fakeFs({ [CELLAR]: CELLAR, [OPT]: other })
    expect(resolveHookNodeBin(CELLAR, fs)).toBe(CELLAR)
  })

  it('keeps execPath when resolving a link throws', () => {
    const fs = {
      existsSync: () => true,
      realpathSync: () => { throw new Error('EACCES') },
    }
    expect(resolveHookNodeBin(CELLAR, fs)).toBe(CELLAR)
  })

  it('leaves nvm and other non-brew paths untouched', () => {
    const nvm = '/home/u/.nvm/versions/node/v22.23.1/bin/node'
    const fs = fakeFs({})
    expect(resolveHookNodeBin(nvm, fs)).toBe(nvm)
    expect(resolveHookNodeBin('/usr/bin/node', fs)).toBe('/usr/bin/node')
  })

  it('leaves native Windows paths untouched', () => {
    const fs = fakeFs({})
    for (const win of ['C:\\Program Files\\nodejs\\node.exe', 'C:/Program Files/nodejs/node.exe']) {
      expect(resolveHookNodeBin(win, fs)).toBe(win)
    }
  })

  it('also covers Linuxbrew', () => {
    const cellar = '/home/linuxbrew/.linuxbrew/Cellar/node@22/22.23.1/bin/node'
    const opt = '/home/linuxbrew/.linuxbrew/opt/node@22/bin/node'
    expect(resolveHookNodeBin(cellar, fakeFs({ [cellar]: cellar, [opt]: cellar }))).toBe(opt)
  })
})

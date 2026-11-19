import { describe, it, expect, afterEach } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'
import {
  formatSupportStatus,
  nodeMajor,
  supportStatus,
  SUPPORT_DISPATCH_PATH,
  SUPPORT_ROUTINE_MIN_NODE_MAJOR,
  type SupportStatusDeps,
} from '../support-standby.js'
import { createStatusDeps, readStdinCapped, runSupportCli, startedFromKit, SUPPORT_CLI_USAGE } from '../support-standby-cli.js'
import type { StandbyDeps } from '../support-standby-enable.js'
import { writeSupportToken } from '../support-access-token.js'
import { writeGroupRecord } from '../support-group-record.js'
import { KitError } from '../support-kit.js'
import { buildSupportGrantLines } from '../support-access-line.js'
import type { SshdAssessment } from '../support-access-sshd.js'
import type { StandbyFiles } from '../support-standby.js'
import { currentLoginUser } from '../support-access-sshd-run.js'
import { TEST_ONLY_KEYS, TEST_ONLY_FROM } from './helpers/sk-test-keys.js'

const LINES = buildSupportGrantLines({
  keys: TEST_ONLY_KEYS,
  fromCidrs: TEST_ONLY_FROM,
  grantId: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
  consentVersion: 1,
  dispatchPath: '/home/marveen/.marveen/support-dispatch.sh',
  sshd: { major: 9, minor: 6 },
})
const PERSONAL = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcH someone'
const SSHD_OK: SshdAssessment = { ok: true, version: { major: 10, minor: 0 }, keysFiles: ['authorized_keys', 'authorized_keys2'], listenPorts: [22], hostKeyFiles: [] }

function deps(over: Partial<SupportStatusDeps> = {}): { deps: SupportStatusDeps; probed: string[][]; asked: string[] } {
  const probed: string[][] = []
  const asked: string[] = []
  return {
    probed,
    asked,
    deps: {
      nodeVersion: 'v22.22.3',
      pins: { keys: TEST_ONLY_KEYS, fromCidrs: TEST_ONLY_FROM },
      probeSshd: async (fromCidrs) => {
        probed.push([...fromCidrs])
        return SSHD_OK
      },
      isExecutable: (path) => {
        asked.push(path)
        return path === '/usr/bin/curl'
      },
      readKeysFile: (name) => (name === 'authorized_keys' ? [PERSONAL, ...LINES].join('\n') + '\n' : null),
      readStandbyFiles: () => ({ token: 'missing', record: { kind: 'missing' } }),
      ...over,
    },
  }
}

describe('nodeMajor', () => {
  it('reads the major version of what process.version holds', () => {
    expect(nodeMajor('v20.19.2')).toBe(20)
    expect(nodeMajor('v22.22.3')).toBe(22)
    expect(nodeMajor('v8.0.0')).toBe(8)
  })

  it.each(['20.19.2', 'v20', 'vx.1.2', '', 'node v20.1.2'])('answers null for %j', (text) => {
    expect(nodeMajor(text)).toBeNull()
  })
})

describe('supportStatus', () => {
  it('reports a machine that is ready', async () => {
    const d = deps()
    expect(await supportStatus(d.deps)).toEqual({
      node: { version: 'v22.22.3', ok: true },
      pins: 'ok',
      sshd: 'ok',
      sshdVersion: '10.0',
      curl: '/usr/bin/curl',
      keysFiles: { authorized_keys: { state: 'read', supportLines: 2 }, authorized_keys2: { state: 'absent' } },
      standby: { state: 'off', keys: [] },
    })
    expect(d.probed).toEqual([[...TEST_ONLY_FROM]])
  })

  it.each<[string, StandbyFiles, string, string[]]>([
    ['off: neither file', { token: 'missing', record: { kind: 'missing' } }, 'off', []],
    ['on: both', { token: 'ok', record: { kind: 'ok', keys: ['key1', 'key2'] } }, 'on', ['key1', 'key2']],
    ['partial: the token only', { token: 'ok', record: { kind: 'missing' } }, 'partial', []],
    ['partial: the record only', { token: 'missing', record: { kind: 'ok', keys: ['key1'] } }, 'partial', []],
    ['invalid: a token that is not ours to use', { token: 'invalid', record: { kind: 'ok', keys: ['key1'] } }, 'invalid', []],
    ['invalid: a record that is not ours to use', { token: 'ok', record: { kind: 'invalid' } }, 'invalid', []],
  ])('standby is %s', async (_label, files, state, keys) => {
    expect((await supportStatus(deps({ readStandbyFiles: () => files }).deps)).standby).toEqual({ state, keys })
  })

  it('the node minimum is 20, said in one place', async () => {
    expect(SUPPORT_ROUTINE_MIN_NODE_MAJOR).toBe(20)
    expect((await supportStatus(deps({ nodeVersion: 'v20.0.0' }).deps)).node.ok).toBe(true)
    expect((await supportStatus(deps({ nodeVersion: 'v19.9.9' }).deps)).node.ok).toBe(false)
    expect((await supportStatus(deps({ nodeVersion: 'garbage' }).deps)).node.ok).toBe(false)
  })

  it('does not ask sshd while the pins are not usable, and says so', async () => {
    for (const pins of [
      { keys: [], fromCidrs: [] },
      { keys: TEST_ONLY_KEYS, fromCidrs: [] },
      { keys: TEST_ONLY_KEYS, fromCidrs: ['203.0.113.0/24'] },
    ]) {
      const d = deps({ pins })
      const report = await supportStatus(d.deps)
      expect(report.sshd).toBe('not_asked')
      expect(report.sshdVersion).toBeNull()
      expect(d.probed).toEqual([])
    }
    expect((await supportStatus(deps({ pins: { keys: [], fromCidrs: [] } }).deps)).pins).toBe('support_keys_unset')
    expect((await supportStatus(deps({ pins: { keys: TEST_ONLY_KEYS, fromCidrs: [] } }).deps)).pins).toBe('support_from_unset')
    expect((await supportStatus(deps({ pins: { keys: TEST_ONLY_KEYS, fromCidrs: ['203.0.113.0/24'] } }).deps)).pins).toBe(
      'support_pins_invalid',
    )
  })

  it('passes on what sshd refuses, with the version when there is one', async () => {
    const refused: SshdAssessment = { ok: false, problem: 'tunnel_permitted', version: { major: 9, minor: 2 } }
    const report = await supportStatus(deps({ probeSshd: async () => refused }).deps)
    expect(report.sshd).toBe('tunnel_permitted')
    expect(report.sshdVersion).toBe('9.2')
    const unknown: SshdAssessment = { ok: false, problem: 'sshd_version_unknown', version: null }
    expect((await supportStatus(deps({ probeSshd: async () => unknown }).deps)).sshdVersion).toBeNull()
  })

  it('looks for curl where the dispatcher will, in that order, and takes the first', async () => {
    expect(SUPPORT_DISPATCH_PATH).toEqual(['/usr/bin', '/bin', '/usr/sbin', '/sbin'])
    const d = deps({ isExecutable: (path) => path === '/bin/curl' || path === '/sbin/curl' })
    expect((await supportStatus(d.deps)).curl).toBe('/bin/curl')
    // A curl somewhere else (Homebrew, a home directory) is not one the dispatcher would find.
    const elsewhere = deps({ isExecutable: (path) => path === '/opt/homebrew/bin/curl' || path === '/usr/local/bin/curl' })
    expect((await supportStatus(elsewhere.deps)).curl).toBeNull()
  })

  it('counts support lines in both files, and tells a missing file from one it cannot read', async () => {
    const loose = 'sk-ssh-ed25519@openssh.com ' + TEST_ONLY_KEYS[0].pub + ' handy'
    const report = await supportStatus(
      deps({ readKeysFile: (name) => (name === 'authorized_keys' ? 'unreadable' : [PERSONAL, loose].join('\n') + '\n') }).deps,
    )
    expect(report.keysFiles).toEqual({ authorized_keys: { state: 'unreadable' }, authorized_keys2: { state: 'read', supportLines: 1 } })
  })

  it('still recognises a pinned key in the files when the pins as a whole are refused', async () => {
    // A copy of a pinned key WITHOUT the support comment: only the blob tells that it is ours.
    const loose = 'sk-ssh-ed25519@openssh.com ' + TEST_ONLY_KEYS[0].pub + ' handy'
    const report = await supportStatus(
      deps({ pins: { keys: TEST_ONLY_KEYS, fromCidrs: [] }, readKeysFile: () => [PERSONAL, loose].join('\n') + '\n' }).deps,
    )
    expect(report.pins).toBe('support_from_unset')
    expect(report.keysFiles.authorized_keys).toEqual({ state: 'read', supportLines: 1 })
  })
})

describe('formatSupportStatus', () => {
  it('prints one fact per line, with the fixed keys and words the launcher matches on', async () => {
    expect(formatSupportStatus(await supportStatus(deps().deps))).toBe(
      'node=ok\nnode_version=v22.22.3\nnode_minimum=20\npins=ok\nsshd=ok\nsshd_version=10.0\ncurl=present\n' +
        'support_lines=2\nsupport_lines_second_file=absent\nstandby=off\nstandby_keys=none\nconsent_version=2\nconsent_lang=hu\nconsent_sha256=1edde713149d360f3aef27d51e3e379557ece268f8716380acbfee7621e1152b\n',
    )
    const bad = await supportStatus(
      deps({
        nodeVersion: 'v18.20.0',
        pins: { keys: [], fromCidrs: [] },
        isExecutable: () => false,
        readKeysFile: () => 'unreadable',
      }).deps,
    )
    expect(formatSupportStatus(bad)).toBe(
      'node=too_old\nnode_version=v18.20.0\nnode_minimum=20\npins=support_keys_unset\nsshd=not_asked\nsshd_version=unknown\n' +
        'curl=missing\nsupport_lines=unreadable\nsupport_lines_second_file=unreadable\nstandby=off\nstandby_keys=none\nconsent_version=2\nconsent_lang=hu\nconsent_sha256=1edde713149d360f3aef27d51e3e379557ece268f8716380acbfee7621e1152b\n',
    )
    const on = await supportStatus(deps({ readStandbyFiles: () => ({ token: 'ok', record: { kind: 'ok', keys: ['key1', 'key2'] } }) }).deps)
    expect(formatSupportStatus(on).endsWith('standby=on\nstandby_keys=key1,key2\nconsent_version=2\nconsent_lang=hu\nconsent_sha256=1edde713149d360f3aef27d51e3e379557ece268f8716380acbfee7621e1152b\n')).toBe(true)
  })
})

/** For the subcommands that must not reach enable or disable. */
const NO_STANDBY = {
  standby: (): never => {
    throw new Error('standby must not run here')
  },
  readCode: async (): Promise<string | null> => null,
}

describe('runSupportCli', () => {
  function io(): { out: string[]; err: string[]; io: { out: (t: string) => void; err: (t: string) => void } } {
    const out: string[] = []
    const err: string[] = []
    return { out, err, io: { out: (t) => out.push(t), err: (t) => err.push(t) } }
  }

  const noInstall = async (): Promise<never> => {
    throw new Error('install-kit must not run here')
  }

  it('status prints the report and exits with 0', async () => {
    const c = io()
    expect(await runSupportCli(['status'], c.io, { status: () => deps().deps, installKit: noInstall, ...NO_STANDBY })).toBe(0)
    expect(c.out.join('')).toContain('sshd=ok\n')
    expect(c.err).toEqual([])
  })

  // SUPPORTMENTOUT1114: the launcher's first question. One line, the verdict as a code, never a path.
  it('verify-kit prints kit=ok for a kit that verifies, and the problem code otherwise; both exit 0', async () => {
    const ok = io()
    expect(await runSupportCli(['verify-kit'], ok.io, {
      status: () => deps().deps, installKit: noInstall, ...NO_STANDBY,
      verifyKit: () => ({ ok: true, kitDir: '/home/x/.marveen/support/kit', manifest: { files: {}, installRoot: '/opt/m', nodePath: '/usr/bin/node', nodeMin: 20, release: 'abc1234' } }),
    })).toBe(0)
    expect(ok.out.join('')).toBe('kit=ok\n')
    const bad = io()
    expect(await runSupportCli(['verify-kit'], bad.io, {
      status: () => deps().deps, installKit: noInstall, ...NO_STANDBY,
      verifyKit: () => ({ ok: false, problem: 'kit_mismatch', detail: '/home/x/.marveen/support/kit/support-access is not the file the manifest names' }),
    })).toBe(0)
    expect(bad.out.join('')).toBe('kit=kit_mismatch\n')
    expect(bad.err).toEqual([])
  })

  it('verify-kit is a call it does not know when no verifier is given, and with an argument', async () => {
    const c = io()
    expect(await runSupportCli(['verify-kit'], c.io, { status: () => deps().deps, installKit: noInstall, ...NO_STANDBY })).toBe(2)
    const d = io()
    expect(await runSupportCli(['verify-kit', 'x'], d.io, {
      status: () => deps().deps, installKit: noInstall, ...NO_STANDBY, verifyKit: () => { throw new Error('must not run') },
    })).toBe(2)
  })

  const ROOT_ARGS = ['--install-root', '/opt/marveen', '--node', '/usr/bin/node', '--release', 'abc1234']

  it.each([
    [[]],
    [['bogus']],
    [['status', 'extra']],
    [['--help']],
    [['enable']],
    [['install-kit']],
    [['install-kit', ...ROOT_ARGS.slice(0, 4)]],
    [['install-kit', ...ROOT_ARGS, '--force']],
    [['install-kit', ...ROOT_ARGS, '--release', 'def5678']],
    [['install-kit', '--install-root', '/a', '--install-root', '/b', '--release', 'abc1234']],
    [['install-kit', '--install-root', '', '--node', '/usr/bin/node', '--release', 'abc1234']],
    [['install-kit', '--install-root=/opt/marveen', '--node', '/usr/bin/node', '--release', 'abc1234', 'x']],
    [['install-kit', '--node', '/usr/bin/node', '--release', 'abc1234', '--support-dir', '/tmp/x']],
    [['install-kit', '--INSTALL-ROOT', '/opt/marveen', '--node', '/usr/bin/node', '--release', 'abc1234']],
    [['install-kit', '__proto__', '/x', '--node', '/usr/bin/node', '--release', 'abc1234']],
  ])('anything else (%j) prints the usage, exits with 2, and neither measures nor writes', async (argv) => {
    const c = io()
    let touched = false
    const code = await runSupportCli(argv, c.io, {
      ...NO_STANDBY,
      status: () => {
        touched = true
        return deps().deps
      },
      installKit: async () => {
        touched = true
        throw new Error('no')
      },
    })
    expect(code).toBe(2)
    expect(c.err.join('')).toBe(SUPPORT_CLI_USAGE)
    expect(c.out).toEqual([])
    expect(touched).toBe(false)
  })

  it('install-kit hands the three values over, in any order, and prints what happened', async () => {
    const c = io()
    const seen: unknown[] = []
    const argv = ['install-kit', '--release', 'abc1234', '--node', '/usr/bin/node', '--install-root', '/opt/marveen']
    const code = await runSupportCli(argv, c.io, {
      status: () => deps().deps,
      ...NO_STANDBY,
      installKit: async (args) => {
        seen.push(args)
        return { kitDir: '/home/x/.marveen/support/kit', replaced: true, cleaned: ['.kit-old-0123456789abcdef'] }
      },
    })
    expect(code).toBe(0)
    expect(seen).toEqual([{ installRoot: '/opt/marveen', nodePath: '/usr/bin/node', release: 'abc1234' }])
    expect(c.out.join('')).toBe('kit=written\nreplaced=yes\ncleaned=1\n')
    expect(c.err).toEqual([])
  })

  it('install-kit says a refusal by its code only, and exits with 1; anything else is not swallowed', async () => {
    const c = io()
    const code = await runSupportCli(['install-kit', ...ROOT_ARGS], c.io, {
      status: () => deps().deps,
      ...NO_STANDBY,
      installKit: async () => {
        throw new KitError('kit_source_mismatch', 'support-standby.mjs in /home/someone/secret-place is not the file of this release')
      },
    })
    expect(code).toBe(1)
    expect(c.err.join('')).toBe('install-kit: refused: kit_source_mismatch\n')
    expect(c.out).toEqual([])
    await expect(
      runSupportCli(['install-kit', ...ROOT_ARGS], c.io, {
        status: () => deps().deps,
        ...NO_STANDBY,
      ...NO_STANDBY,
        installKit: async () => {
          throw new Error('disk on fire')
        },
      }),
    ).rejects.toThrow('disk on fire')
  })
})

describe('createStatusDeps', () => {
  const savedHome = process.env['HOME']
  const savedSeam = process.env['MARVEEN_SSH_DIR']
  let root: string | null = null
  afterEach(() => {
    if (savedHome === undefined) delete process.env['HOME']
    else process.env['HOME'] = savedHome
    if (savedSeam === undefined) delete process.env['MARVEEN_SSH_DIR']
    else process.env['MARVEEN_SSH_DIR'] = savedSeam
    if (root !== null) rmSync(root, { recursive: true, force: true })
    root = null
  })

  it('reads the keys files under the home of the account it was given, byte for byte; no variable moves the directory', () => {
    root = mkdtempSync(join(tmpdir(), 'support-standby-deps-'))
    const elsewhere = join(root, 'elsewhere')
    const home = join(root, 'home')
    mkdirSync(join(home, '.ssh'), { recursive: true })
    mkdirSync(join(elsewhere, '.ssh'), { recursive: true })
    writeFileSync(join(home, '.ssh', 'authorized_keys'), Buffer.from([0x61, 0xe9, 0x0a]))
    writeFileSync(join(elsewhere, 'authorized_keys'), 'not this one\n')
    writeFileSync(join(elsewhere, '.ssh', 'authorized_keys'), 'not this one either\n')
    mkdirSync(join(home, '.ssh', 'authorized_keys2'))
    process.env['HOME'] = elsewhere
    process.env['MARVEEN_SSH_DIR'] = elsewhere
    const real = createStatusDeps({ name: 'marveen', isRoot: false, home })
    expect(real.readKeysFile('authorized_keys')).toBe('aé\n')
    // A directory in the file's place exists and cannot be read as a file.
    expect(real.readKeysFile('authorized_keys2')).toBe('unreadable')
    rmSync(join(home, '.ssh', 'authorized_keys2'), { recursive: true })
    expect(real.readKeysFile('authorized_keys2')).toBeNull()
  })

  // The probe asks about the SAME account the keys files are read for. A made-up root account makes the real
  // probe ask sshd as root, without a host key of its own, which a non-root test run cannot get an answer to
  // ("no hostkeys available", measured). The process's own account would take the non-root path (with a host
  // key and the proof), whose outcome depends on the machine, so it is not asserted here.
  it.skipIf(!existsSync('/usr/sbin/sshd') || process.getuid?.() === 0)('hands its account to the probe', async () => {
    const made = createStatusDeps({ name: 'support-test-root', isRoot: true, home: '/nonexistent-home' })
    expect(await made.probeSshd(TEST_ONLY_FROM)).toMatchObject({ ok: false, problem: 'sshd_config_unknown' })
  })

  // S1 of Dani's review: the default account is the one in the user database, whatever HOME says.
  it('takes the login account from the user database, not from HOME', () => {
    root = mkdtempSync(join(tmpdir(), 'support-standby-deps-'))
    process.env['HOME'] = root
    const account = currentLoginUser()
    expect(account.home).toBe(userInfo().homedir)
    expect(account.home).not.toBe(root)
    expect(account.name).toBe(userInfo().username)
    expect(account.isRoot).toBe(process.getuid?.() === 0)
  })

  it('tells an executable file from one that is not, and from a missing one', () => {
    root = mkdtempSync(join(tmpdir(), 'support-standby-deps-'))
    writeFileSync(join(root, 'tool'), '#!/bin/sh\n', { mode: 0o755 })
    writeFileSync(join(root, 'data'), 'x\n', { mode: 0o644 })
    const real = createStatusDeps()
    expect(real.isExecutable(join(root, 'tool'))).toBe(true)
    expect(real.isExecutable(join(root, 'data'))).toBe(false)
    expect(real.isExecutable(join(root, 'missing'))).toBe(false)
    expect(real.nodeVersion).toBe(process.version)
  })
})

describe('enable and disable on the command line', () => {
  function io(): { out: string[]; err: string[]; io: { out: (t: string) => void; err: (t: string) => void } } {
    const out: string[] = []
    const err: string[] = []
    return { out, err, io: { out: (t) => out.push(t), err: (t) => err.push(t) } }
  }
  const fakeStandby = (over: Partial<StandbyDeps> = {}): StandbyDeps => ({
    supportDir: '/nonexistent/support',
    sshDir: '/nonexistent/.ssh',
    pins: { keys: TEST_ONLY_KEYS, fromCidrs: TEST_ONLY_FROM },
    probeSshd: async () => ({ ok: true, version: { major: 9, minor: 6 }, keysFiles: ['authorized_keys'], listenPorts: [22], hostKeyFiles: [] }),
    readHostKey: async () => ({ kind: 'ok', key: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJ' }),
    redeemTransport: async () => {
      throw new Error('no network in this test')
    },
    now: () => new Date(0),
    newGrantId: () => '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
    startedFromKit: false,
    ...over,
  })

  it('tells the kit copy from the tree copy by its own URL', () => {
    expect(startedFromKit('data:text/javascript;base64,AAAA')).toBe(true)
    expect(startedFromKit('file:///opt/marveen/scripts/support-standby.mjs')).toBe(false)
    expect(startedFromKit('not a url')).toBe(false)
  })

  it('enable takes the code from standard input, never from an argument, and says why it refuses', async () => {
    const c = io()
    let read = 0
    const code = await runSupportCli(['enable', '--consent', '1'], c.io, {
      status: () => deps().deps,
      installKit: async () => {
        throw new Error('no')
      },
      standby: () => fakeStandby(),
      readCode: async () => {
        read++
        return 'msc_' + 'TESTONLY'.repeat(4)
      },
    })
    expect(read).toBe(1)
    expect(code).toBe(1)
    expect(c.err.join('')).toBe('enable: refused: enable_not_from_kit\n')
    expect(c.out).toEqual([])
  })

  it.each([[['enable']], [['enable', '--consent']], [['enable', '--consent', '0']], [['enable', '--consent', 'one']], [['enable', 'msc_x']], [['enable', '--consent', '1', 'extra']], [['disable', 'now']]])(
    '%j is the usage, and reads no standard input',
    async (argv) => {
      const c = io()
      let read = false
      const code = await runSupportCli(argv, c.io, {
        status: () => deps().deps,
        installKit: async () => {
          throw new Error('no')
        },
        standby: () => {
          throw new Error('no')
        },
        readCode: async () => {
          read = true
          return null
        },
      })
      expect(code).toBe(2)
      expect(read).toBe(false)
      expect(c.err.join('')).toBe(SUPPORT_CLI_USAGE)
    },
  )

  // Geri 78479: the launcher prints the consent text of the version it passes to enable.
  const noInstall = async (): Promise<never> => {
    throw new Error('install-kit must not run here')
  }

  it('consent-text: a known version without an approved text refuses with its own code, reads nothing', async () => {
    const c = io()
    let touched = false
    const code = await runSupportCli(['consent-text', '--consent', '1'], c.io, {
      status: () => {
        touched = true
        return deps().deps
      },
      installKit: noInstall,
      standby: () => {
        touched = true
        throw new Error('no')
      },
      readCode: async () => {
        touched = true
        return null
      },
    })
    expect([code, c.out, c.err.join('')]).toEqual([1, [], 'consent-text: refused: consent_text_unset\n'])
    expect(touched).toBe(false)
  })

  it.each([['3'], ['9999']])('consent-text: a version this release does not know (%s) is consent_invalid', async (v) => {
    const c = io()
    expect(await runSupportCli(['consent-text', '--consent', v], c.io, { status: () => deps().deps, installKit: noInstall, ...NO_STANDBY })).toBe(1)
    expect(c.err.join('')).toBe('consent-text: refused: consent_invalid\n')
    expect(c.out).toEqual([])
  })

  it.each([[['consent-text']], [['consent-text', '--consent']], [['consent-text', '--consent', '0']], [['consent-text', '--consent', '01']], [['consent-text', '--consent', '1', 'x']]])(
    'consent-text %j is the usage',
    async (argv) => {
      const c = io()
      expect(await runSupportCli(argv, c.io, { status: () => deps().deps, installKit: noInstall, ...NO_STANDBY })).toBe(2)
      expect(c.err.join('')).toBe(SUPPORT_CLI_USAGE)
    },
  )

  it('more standard input than a code can be is no code', async () => {
    expect(await readStdinCapped(64, (async function* () { yield 'x'.repeat(65) })())).toBeNull()
    expect(await readStdinCapped(64, (async function* () { yield 'msc_'; yield Buffer.from('abc') })())).toBe('msc_abc')
  })
})

// Geri 78368: the status says what the record MEANS, never what it says.
describe('the status and the group record', () => {
  let home: string | null = null
  afterEach(() => {
    if (home !== null) rmSync(home, { recursive: true, force: true })
    home = null
  })

  it('prints on and the key names, and no source address, grant id or consent', async () => {
    home = realpathSync(mkdtempSync(join(tmpdir(), 'support-status-home-')))
    const supportDir = join(home, '.marveen', 'support')
    mkdirSync(supportDir, { recursive: true, mode: 0o700 })
    writeSupportToken(supportDir, 'mst_' + 'TESTONLY'.repeat(5) + '_-0')
    writeGroupRecord(supportDir, {
      grantId: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
      // A consent version this release does not have: the status must not echo the RECORD's consent.
      consentVersion: 7,
      consentAt: '2026-11-15T06:10:00Z',
      keys: TEST_ONLY_KEYS.map((k) => ({ name: k.name, fingerprint: k.fingerprint })),
      fromCidrs: [...TEST_ONLY_FROM],
      dispatchPath: join(supportDir, 'kit', 'support-dispatch.sh'),
      sshd: { major: 9, minor: 6 },
    })
    const real = createStatusDeps({ name: 'marveen', isRoot: false, home })
    const text = formatSupportStatus(await supportStatus({ ...real, pins: { keys: [], fromCidrs: [] } }))
    expect(text).toContain('standby=on\nstandby_keys=key1,key2\n')
    for (const secret of ['203.0.113.7', '3f2504e0', '2026-11-15', TEST_ONLY_KEYS[0].fingerprint, 'mst_']) {
      expect(text).not.toContain(secret)
    }
    // The consent lines are the routine's own version, the launcher's language and that text's sha256 (Samu 78475,
    // 79440, 79453), not the record's.
    expect(text.split('\n').filter((l) => l.includes('consent'))).toEqual(['consent_version=2', 'consent_lang=hu', 'consent_sha256=1edde713149d360f3aef27d51e3e379557ece268f8716380acbfee7621e1152b'])
  })
})

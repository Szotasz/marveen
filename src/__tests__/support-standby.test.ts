import { describe, it, expect, afterEach } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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
import { createStatusDeps, runSupportCli, SUPPORT_CLI_USAGE } from '../support-standby-cli.js'
import { KitError } from '../support-kit.js'
import { buildSupportGrantLines } from '../support-access-line.js'
import type { SshdAssessment } from '../support-access-sshd.js'
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
const SSHD_OK: SshdAssessment = { ok: true, version: { major: 10, minor: 0 }, keysFiles: ['authorized_keys', 'authorized_keys2'] }

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
    })
    expect(d.probed).toEqual([[...TEST_ONLY_FROM]])
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
        'support_lines=2\nsupport_lines_second_file=absent\n',
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
        'curl=missing\nsupport_lines=unreadable\nsupport_lines_second_file=unreadable\n',
    )
  })
})

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
    expect(await runSupportCli(['status'], c.io, { status: () => deps().deps, installKit: noInstall })).toBe(0)
    expect(c.out.join('')).toContain('sshd=ok\n')
    expect(c.err).toEqual([])
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
  // probe ask sshd as root, which a non-root test run cannot get an answer to; the process's own account
  // would be refused before that, for not being root.
  it.skipIf(!existsSync('/usr/sbin/sshd') || process.getuid?.() === 0)('hands its account to the probe', async () => {
    const made = createStatusDeps({ name: 'support-test-root', isRoot: true, home: '/nonexistent-home' })
    expect(await made.probeSshd(TEST_ONLY_FROM)).toMatchObject({ ok: false, problem: 'sshd_config_unknown' })
    const own = createStatusDeps({ ...currentLoginUser() })
    expect(await own.probeSshd(TEST_ONLY_FROM)).toMatchObject({ ok: false, problem: 'sshd_config_not_fully_readable' })
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

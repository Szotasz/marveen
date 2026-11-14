import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  checkDaemon,
  includeArguments,
  includeTarget,
  listenerTitleProblem,
  NONROOT_MAX_DEPTH,
  NONROOT_MAX_FILE_BYTES,
  patternMatches,
  pidfileOf,
  walkIncludes,
  type DaemonFs,
} from '../support-access-sshd-nonroot.js'
import { realNonRootFs } from '../support-access-sshd-run.js'

/** A machine as a map of files (text + mtime, or unreadable) and folders (names, or unlistable). */
function fsOf(files: Record<string, string | [string, bigint] | 'UNREADABLE'>, dirs: Record<string, string[] | 'UNLISTABLE'> = {}): DaemonFs {
  return {
    readText: (path) => {
      const f = files[path]
      if (f === undefined) return { kind: 'missing' }
      if (f === 'UNREADABLE') return { kind: 'unreadable' }
      return Array.isArray(f) ? { kind: 'ok', text: f[0], mtimeNs: f[1] } : { kind: 'ok', text: f, mtimeNs: 1n }
    },
    listDir: (path) => {
      const d = dirs[path]
      if (d === undefined) return { kind: 'missing' }
      return d === 'UNLISTABLE' ? { kind: 'unlistable' } : { kind: 'ok', names: d }
    },
    mtimeNs: (path) => {
      const f = files[path]
      return f === undefined || f === 'UNREADABLE' ? null : Array.isArray(f) ? f[1] : 1n
    },
  }
}

describe('includeArguments', () => {
  it('reads every Include line, in any letter case, with = or spaces, under a Match block too, and ignores the rest', () => {
    const text = [
      '# Include /commented/out.conf',
      'Include /etc/ssh/sshd_config.d/*.conf',
      '  include   a.conf   b.conf',
      'INCLUDE=/x/y.conf',
      'Include = /p/q.conf',
      'Match User marveen',
      '    Include /m/*.conf',
      'PasswordAuthentication no',
      'Includes /not/a/keyword.conf',
      '',
    ].join('\n')
    expect(includeArguments(text)).toEqual(['/etc/ssh/sshd_config.d/*.conf', 'a.conf', 'b.conf', '/x/y.conf', '/p/q.conf', '/m/*.conf'])
    expect(includeArguments('Port 22\r\nInclude /a.conf\r\n')).toEqual(['/a.conf'])
  })

  // Measured: sshd takes ~, %h and ${HOME} literally; quotes are a sshd feature this does not imitate.
  it.each(['Include "/etc/ssh/a b.conf"', "Include '/x.conf'", 'Include ~/x.conf', 'Include %h/x.conf', 'Include ${HOME}/x.conf', 'Include /a\\ b.conf', 'Include /x.conf # note', 'Include', 'Include ='])(
    'does not interpret %s',
    (line) => {
      expect(includeArguments(line + '\n')).toBeNull()
    },
  )
})

describe('includeTarget and patternMatches', () => {
  it('reads a relative path against /etc/ssh and splits the folder from the file pattern', () => {
    expect(includeTarget('sshd_config.d/*.conf')).toEqual({ dir: '/etc/ssh/sshd_config.d', pattern: '*.conf' })
    expect(includeTarget('/etc/ssh/sshd_config.d/*.conf')).toEqual({ dir: '/etc/ssh/sshd_config.d', pattern: '*.conf' })
    expect(includeTarget('rel.conf')).toEqual({ dir: '/etc/ssh', pattern: 'rel.conf' })
  })

  it.each(['/etc/*/x.conf', '/etc/ss?/x.conf', '/etc/ssh/[ab].conf', '/etc/ssh/{a,b}.conf', '/etc/ssh/../x.conf', '/etc/ssh/./x.conf', '/etc//ssh/x.conf', '/etc/ssh/', ''])(
    'does not interpret %j',
    (arg) => {
      expect(includeTarget(arg)).toBeNull()
    },
  )

  it('matches * and ? as glob does, everything else literally', () => {
    expect(patternMatches('*.conf', '50-cloud.conf')).toBe(true)
    expect(patternMatches('*.conf', '50-cloud.conf.bak')).toBe(false)
    expect(patternMatches('t?.conf', 't1.conf')).toBe(true)
    expect(patternMatches('t?.conf', 't12.conf')).toBe(false)
    expect(patternMatches('a.conf', 'abconf')).toBe(false)
    expect(patternMatches('a+b.conf', 'a+b.conf')).toBe(true)
    expect(patternMatches('a+b.conf', 'aab.conf')).toBe(false)
  })
})

describe('walkIncludes', () => {
  it('follows every Include, nested ones and those under Match, and reports each file with its mtime', () => {
    const fs = fsOf(
      {
        '/etc/ssh/sshd_config': ['Include /etc/ssh/sshd_config.d/*.conf\nMatch User u\n  Include /etc/ssh/m.d/*.conf\n', 10n],
        '/etc/ssh/sshd_config.d/10-a.conf': ['Include /etc/ssh/inner.d/*.conf\n', 20n],
        '/etc/ssh/sshd_config.d/20-b.conf': ['X yes\n', 30n],
        '/etc/ssh/inner.d/t.conf': ['PermitTunnel yes\n', 40n],
        '/etc/ssh/m.d/m.conf': ['PermitTunnel yes\n', 50n],
      },
      {
        '/etc/ssh/sshd_config.d': ['20-b.conf', '10-a.conf', 'README'],
        '/etc/ssh/inner.d': ['t.conf'],
        '/etc/ssh/m.d': ['m.conf'],
      },
    )
    expect(walkIncludes(fs)).toEqual({
      ok: true,
      files: [
        { path: '/etc/ssh/sshd_config', mtimeNs: 10n },
        { path: '/etc/ssh/sshd_config.d/10-a.conf', mtimeNs: 20n },
        { path: '/etc/ssh/inner.d/t.conf', mtimeNs: 40n },
        { path: '/etc/ssh/sshd_config.d/20-b.conf', mtimeNs: 30n },
        { path: '/etc/ssh/m.d/m.conf', mtimeNs: 50n },
      ],
    })
  })

  it.each<[string, Parameters<typeof fsOf>[0], Parameters<typeof fsOf>[1], string]>([
    ['the main file is missing', {}, {}, 'sshd_config_unknown'],
    ['the main file cannot be read', { '/etc/ssh/sshd_config': 'UNREADABLE' }, {}, 'sshd_config_unknown'],
    ['a matching drop-in cannot be read', { '/etc/ssh/sshd_config': 'Include /d/*.conf\n', '/d/a.conf': 'UNREADABLE' }, { '/d': ['a.conf'] }, 'sshd_config_unknown'],
    ['an Include folder cannot be listed', { '/etc/ssh/sshd_config': 'Include /d/*.conf\n' }, { '/d': 'UNLISTABLE' }, 'sshd_config_include_unlistable'],
    ['a nested folder cannot be listed', { '/etc/ssh/sshd_config': 'Include /d/*.conf\n', '/d/a.conf': 'Include /e/x.conf\n' }, { '/d': ['a.conf'], '/e': 'UNLISTABLE' }, 'sshd_config_include_unlistable'],
    ['a literal Include in a folder that cannot be listed', { '/etc/ssh/sshd_config': 'Include /d/x.conf\n', '/d/x.conf': 'X y\n' }, { '/d': 'UNLISTABLE' }, 'sshd_config_include_unlistable'],
    ['an Include in a form not interpreted', { '/etc/ssh/sshd_config': 'Include ~/x.conf\n' }, {}, 'sshd_config_include_unparsed'],
    ['a glob in the folder part', { '/etc/ssh/sshd_config': 'Include /etc/*/x.conf\n' }, {}, 'sshd_config_include_unparsed'],
  ])('refuses when %s', (_label, files, dirs, problem) => {
    expect(walkIncludes(fsOf(files, dirs))).toEqual({ ok: false, problem })
  })

  it('is fine with an Include whose folder or file does not exist (nothing hides there, measured), and with a non-matching name', () => {
    const fs = fsOf({ '/etc/ssh/sshd_config': 'Include /nope/*.conf\nInclude /d/missing.conf\nInclude /d/*.conf\n' }, { '/d': ['readme.txt'] })
    expect(walkIncludes(fs)).toEqual({ ok: true, files: [{ path: '/etc/ssh/sshd_config', mtimeNs: 1n }] })
  })

  it('reads a file that two Includes name once, does not loop, and stops at the depth limit', () => {
    const looping = fsOf({ '/etc/ssh/sshd_config': 'Include /etc/ssh/sshd_config\nInclude /etc/ssh/sshd_config\n' }, { '/etc/ssh': ['sshd_config'] })
    expect(walkIncludes(looping)).toEqual({ ok: true, files: [{ path: '/etc/ssh/sshd_config', mtimeNs: 1n }] })
    const files: Record<string, string> = {}
    for (let i = 0; i <= NONROOT_MAX_DEPTH + 1; i++) files[i === 0 ? '/etc/ssh/sshd_config' : '/c/' + i + '.conf'] = 'Include /c/' + (i + 1) + '.conf\n'
    const names = Array.from({ length: NONROOT_MAX_DEPTH + 3 }, (_, i) => i + '.conf')
    expect(walkIncludes(fsOf(files, { '/c': names }))).toEqual({ ok: false, problem: 'sshd_config_include_unparsed' })
  })
})

describe('the daemon', () => {
  it('reads the pidfile line of sshd -T, and only a plain absolute path', () => {
    expect(pidfileOf('port 22\npidfile /run/sshd.pid\n')).toBe('/run/sshd.pid')
    expect(pidfileOf('pidfile none\n')).toBeNull()
    expect(pidfileOf('port 22\n')).toBeNull()
    expect(pidfileOf('pidfile /run/a.pid\npidfile /run/b.pid\n')).toBeNull()
  })

  // The title is what /proc shows of a listener (measured on 8.9 to 10.0), not the raw argv.
  it.each<[string, string | null]>([
    ['sshd: /usr/sbin/sshd -D [listener] 0 of 10-100 startups', null],
    ['sshd: /usr/sbin/sshd [listener] 0 of 10-100 startups\0\0\0', null],
    ['sshd: /usr/sbin/sshd -D -e [listener] 0 of 10-100 startups', null],
    ['sshd: /usr/sbin/sshd -o PermitTunnel=yes -p 2222 [listener] 0 of 10-100 startups', 'sshd_daemon_options'],
    ['sshd: /usr/sbin/sshd -D -f /tmp/other.conf [listener] 0 of 10-100 startups', 'sshd_daemon_options'],
    ['sshd: /usr/sbin/sshd -D', 'sshd_daemon_unknown'],
    ['/usr/sbin/sshd -D', 'sshd_daemon_unknown'],
    ['sshd: marveen [priv]', 'sshd_daemon_unknown'],
    ['sshd: usr/sbin/sshd -D [listener] 0 of 10', 'sshd_daemon_unknown'],
  ])('title %j -> %s', (title, problem) => {
    expect(listenerTitleProblem(title)).toBe(problem)
  })

  const daemon = (over: Parameters<typeof fsOf>[0] = {}): DaemonFs =>
    fsOf({
      '/run/sshd.pid': ['812\n', 200n],
      '/proc/812/comm': 'sshd\n',
      '/proc/812/cmdline': 'sshd: /usr/sbin/sshd -D [listener] 0 of 10-100 startups',
      ...over,
    })

  it('accepts a live plain listener with no configuration file newer than its pidfile', () => {
    expect(checkDaemon(daemon(), '/run/sshd.pid', [{ mtimeNs: 100n }, { mtimeNs: 200n }])).toEqual({ ok: true })
  })

  it('refuses an edit newer than the pidfile (the last start or reload, measured)', () => {
    expect(checkDaemon(daemon(), '/run/sshd.pid', [{ mtimeNs: 100n }, { mtimeNs: 201n }])).toEqual({ ok: false, problem: 'sshd_reload_pending' })
  })

  it.each<[string, Parameters<typeof fsOf>[0] | null, string | null]>([
    ['no pidfile line', {}, null],
    ['a missing pidfile', { '/run/sshd.pid': undefined as unknown as string }, '/run/sshd.pid'],
    ['a pidfile that is not a number', { '/run/sshd.pid': ['abc\n', 200n] }, '/run/sshd.pid'],
    ['a pidfile with two lines', { '/run/sshd.pid': ['812\n813\n', 200n] }, '/run/sshd.pid'],
    ['a dead process', { '/proc/812/comm': undefined as unknown as string }, '/run/sshd.pid'],
    ['another program behind the PID', { '/proc/812/comm': 'nginx\n' }, '/run/sshd.pid'],
    ['an unreadable title', { '/proc/812/cmdline': 'UNREADABLE' }, '/run/sshd.pid'],
  ])('refuses %s', (_label, over, pidfile) => {
    expect(checkDaemon(daemon(over ?? {}), pidfile, [])).toEqual({ ok: false, problem: 'sshd_daemon_unknown' })
  })
})

describe('realNonRootFs, on a real folder', () => {
  let root: string
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'nonroot-fs-')))
  })
  afterEach(() => {
    try {
      chmodSync(join(root, 'closed'), 0o755)
    } catch {
      /* not made in every test */
    }
    rmSync(root, { recursive: true, force: true })
  })

  it('reads a file with its mtime in nanoseconds, follows a link as sshd does, and caps the size', () => {
    writeFileSync(join(root, 'a.conf'), 'X yes\n')
    utimesSync(join(root, 'a.conf'), 1000, 1000)
    symlinkSync(join(root, 'a.conf'), join(root, 'link.conf'))
    expect(realNonRootFs.readText(join(root, 'a.conf'), 100)).toEqual({ kind: 'ok', text: 'X yes\n', mtimeNs: 1_000_000_000_000n })
    expect(realNonRootFs.readText(join(root, 'link.conf'), 100)).toMatchObject({ kind: 'ok', text: 'X yes\n' })
    expect(realNonRootFs.readText(join(root, 'missing.conf'), 100)).toEqual({ kind: 'missing' })
    writeFileSync(join(root, 'big.conf'), 'x'.repeat(NONROOT_MAX_FILE_BYTES + 1))
    expect(realNonRootFs.readText(join(root, 'big.conf'), NONROOT_MAX_FILE_BYTES)).toEqual({ kind: 'unreadable' })
    mkdirSync(join(root, 'dir.conf'))
    expect(realNonRootFs.readText(join(root, 'dir.conf'), 100)).toEqual({ kind: 'unreadable' })
    expect(realNonRootFs.mtimeNs(join(root, 'a.conf'))).toBe(1_000_000_000_000n)
    expect(realNonRootFs.mtimeNs(join(root, 'missing.conf'))).toBeNull()
  })

  it.skipIf(process.getuid?.() === 0)('tells a folder it cannot list from a missing one, and a file it cannot read', () => {
    mkdirSync(join(root, 'open'))
    writeFileSync(join(root, 'open', 'x.conf'), 'X\n')
    expect(realNonRootFs.listDir(join(root, 'open'))).toEqual({ kind: 'ok', names: ['x.conf'] })
    expect(realNonRootFs.listDir(join(root, 'none'))).toEqual({ kind: 'missing' })
    mkdirSync(join(root, 'closed'))
    // Searchable, not listable for this user: the case that hides drop-ins from a non-root sshd -T (measured on a
    // root-owned 0711 folder; here the folder is ours, so the owner's read bit is what has to go).
    chmodSync(join(root, 'closed'), 0o311)
    expect(realNonRootFs.listDir(join(root, 'closed'))).toEqual({ kind: 'unlistable' })
    writeFileSync(join(root, 'secret.conf'), 'X\n', { mode: 0o000 })
    expect(realNonRootFs.readText(join(root, 'secret.conf'), 100)).toEqual({ kind: 'unreadable' })
  })
})

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  checkDarwinDaemon,
  darwinEnabledCheck,
  darwinJobCheck,
  darwinListenersCheck,
  darwinPlistCheck,
  darwinWalkOwnerCheck,
} from '../support-access-sshd-darwin.js'

// MEASURED on macOS 26.5.2 (meres/EREDMENY.md 5.17, 5.18), verbatim: the plist as plutil prints it, and launchd's
// view of the job. The print-disabled and netstat texts carry the measured lines among other lines of their usual
// shape (only the measured lines were captured).
const DIR = join(__dirname, 'fixtures', 'support-sshd-darwin')
const PLIST = readFileSync(join(DIR, 'ssh-plist.json'), 'utf8')
const JOB = readFileSync(join(DIR, 'launchctl-print-job.txt'), 'utf8')
const DISABLED = 'disabled services = {\n\t\t"com.apple.example" => disabled\n\t\t"com.openssh.sshd" => enabled\n\t}\n'
const NETSTAT =
  'Active Internet connections (including servers)\n' +
  'Proto Recv-Q Send-Q  Local Address          Foreign Address        (state)\n' +
  'tcp4       0      0  192.168.1.20.52344     203.0.113.9.443        ESTABLISHED\n' +
  'tcp4       0      0  *.22                   *.*                    LISTEN     \n' +
  'tcp6       0      0  *.22                   *.*                    LISTEN     \n' +
  'tcp4       0      0  127.0.0.1.3420         *.*                    LISTEN     \n' +
  'tcp4       0      0  *.2222                 *.*                    LISTEN     \n' +
  'udp4       0      0  *.5353                 *.*                               \n'
const ROOT_FILE = { uid: 0, mode: 0o100644 }
const ROOT_DIR = { uid: 0, mode: 0o40755 }

const plistWith = (edit: (p: Record<string, unknown>) => void): string => {
  const p = JSON.parse(PLIST) as Record<string, unknown>
  edit(p)
  return JSON.stringify(p)
}

describe('macOS: the daemon check of the non-root probe (D1-D4, Dani 78522)', () => {
  it('passes on what macOS 26 measured', () => {
    expect(darwinPlistCheck(PLIST)).toEqual({ ok: true })
    expect(darwinEnabledCheck(DISABLED)).toEqual({ ok: true })
    expect(darwinJobCheck(JOB)).toEqual({ ok: true })
    expect(darwinListenersCheck(NETSTAT)).toEqual({ ok: true })
    expect(checkDarwinDaemon({ plistJson: PLIST, printDisabled: DISABLED, printJob: JOB, netstat: NETSTAT, walkOwners: [ROOT_DIR, ROOT_FILE] })).toEqual({ ok: true })
  })

  it('D1: does not read the plist\'s own Disabled key (it says true while the port listens, measured)', () => {
    expect(JSON.parse(PLIST).Disabled).toBe(true)
    expect(darwinPlistCheck(plistWith((p) => delete p.Disabled))).toEqual({ ok: true })
  })

  it.each<[string, (p: Record<string, unknown>) => void, string]>([
    ['another argument to the wrapper', (p) => (p.ProgramArguments = ['sshd-keygen-wrapper', '-f', '/tmp/x']), 'sshd_daemon_options'],
    ['another program', (p) => (p.Program = '/opt/homebrew/sbin/sshd'), 'sshd_daemon_unknown'],
    ['another first argument', (p) => (p.ProgramArguments = ['sshd']), 'sshd_daemon_unknown'],
    ['another label', (p) => (p.Label = 'homebrew.mxcl.openssh'), 'sshd_daemon_unknown'],
    ['a key the measured plist does not have', (p) => (p.EnvironmentVariables = { X: '1' }), 'sshd_daemon_unknown'],
    ['inetd mode with Wait', (p) => (p.inetdCompatibility = { Wait: true }), 'sshd_daemon_unknown'],
    ['no inetd mode', (p) => delete p.inetdCompatibility, 'sshd_daemon_unknown'],
    ['a listener on another service', (p) => (p.Sockets = { Listeners: { SockServiceName: '2222' } }), 'sshd_daemon_unknown'],
    ['a listener bound to one address', (p) => (p.Sockets = { Listeners: { SockServiceName: 'ssh', SockNodeName: '127.0.0.1' } }), 'sshd_daemon_unknown'],
    ['a second socket group', (p) => (p.Sockets = { Listeners: { SockServiceName: 'ssh' }, Other: { SockServiceName: 'ssh' } }), 'sshd_daemon_unknown'],
  ])('D1: refuses %s', (_label, edit, problem) => {
    expect(darwinPlistCheck(plistWith(edit))).toEqual({ ok: false, problem })
  })

  it('D1: refuses no answer and an answer that is not a plist object', () => {
    for (const text of [null, '', 'not json', '[]', 'null']) expect(darwinPlistCheck(text)).toEqual({ ok: false, problem: 'sshd_daemon_unknown' })
  })

  it('D2: only an enabled override counts (Remote Login off, or no override, is not a daemon to trust)', () => {
    expect(darwinEnabledCheck(DISABLED.replace('"com.openssh.sshd" => enabled', '"com.openssh.sshd" => disabled'))).toEqual({ ok: false, problem: 'sshd_daemon_unknown' })
    expect(darwinEnabledCheck(DISABLED.replace('\t\t"com.openssh.sshd" => enabled\n', ''))).toEqual({ ok: false, problem: 'sshd_daemon_unknown' })
    expect(darwinEnabledCheck(DISABLED + '\t\t"com.openssh.sshd" => disabled\n')).toEqual({ ok: false, problem: 'sshd_daemon_unknown' })
    expect(darwinEnabledCheck(null)).toEqual({ ok: false, problem: 'sshd_daemon_unknown' })
  })

  it.each<[string, (t: string) => string, string]>([
    ['another plist', (t) => t.replace('path = /System/Library/LaunchDaemons/ssh.plist', 'path = /Library/LaunchDaemons/ssh.plist'), 'sshd_daemon_unknown'],
    ['another program', (t) => t.replace('program = /usr/libexec/sshd-keygen-wrapper', 'program = /usr/sbin/sshd'), 'sshd_daemon_unknown'],
    ['another argument', (t) => t.replace('\t\tsshd-keygen-wrapper\n', '\t\tsshd-keygen-wrapper\n\t\t-o\n'), 'sshd_daemon_options'],
    ['another first argument', (t) => t.replace('\t\tsshd-keygen-wrapper\n', '\t\tsshd\n'), 'sshd_daemon_unknown'],
    ['no arguments block', (t) => t.replace('\targuments = {', '\targs = {'), 'sshd_daemon_unknown'],
    ['no inetd-compatible', (t) => t.replace('inetd-compatible | ', ''), 'sshd_daemon_unknown'],
    ['no sockets', (t) => t.replace('\tsockets = {', '\tsockz = {'), 'sshd_daemon_unknown'],
    ['a listener on another service', (t) => t.replace('service name = ssh', 'service name = 2222'), 'sshd_daemon_unknown'],
  ])('D3: refuses a loaded job with %s', (_label, edit, problem) => {
    expect(darwinJobCheck(edit(JOB))).toEqual({ ok: false, problem })
  })

  it.each<[string, string]>([
    ['a third listener on 22, bound to one address', NETSTAT + 'tcp4       0      0  127.0.0.1.22           *.*                    LISTEN\n'],
    ['only the tcp4 one', NETSTAT.replace(/tcp6 .*\*\.22 .*\n/, '')],
    ['none', NETSTAT.replace(/tcp[46] .*\*\.22 .*\n/g, '')],
    ['the same pair twice', NETSTAT + 'tcp4       0      0  *.22                   *.*                    LISTEN\n'],
    ['an IPv6 listener on one address', NETSTAT + 'tcp6       0      0  ::1.22                 *.*                    LISTEN\n'],
    ['a dual-stack listener on 22 (tcp46)', NETSTAT + 'tcp46      0      0  *.22                   *.*                    LISTEN\n'],
    ['a listener written with the port after a colon (a form macOS does not print: it must count, not slip past)', NETSTAT + 'tcp6       0      0  [::1]:22               *.*                    LISTEN\n'],
  ])('D4: refuses %s', (_label, text) => {
    expect(darwinListenersCheck(text)).toEqual({ ok: false, problem: 'sshd_daemon_unknown' })
  })

  it('D4: a connection on 22 is not a listener, and port 2222 is not 22', () => {
    expect(darwinListenersCheck(NETSTAT + 'tcp4       0      0  192.168.1.20.22        203.0.113.9.50000      ESTABLISHED\n')).toEqual({ ok: true })
    expect(darwinListenersCheck(null)).toEqual({ ok: false, problem: 'sshd_daemon_unknown' })
  })

  it('B1 on macOS: everything the walk read belongs to root and is writable by nobody else (Dani 78522 (2))', () => {
    expect(darwinWalkOwnerCheck([ROOT_DIR, ROOT_FILE])).toEqual({ ok: true })
    for (const bad of [{ uid: 501, mode: 0o100644 }, { uid: 0, mode: 0o100664 }, { uid: 0, mode: 0o100646 }, { uid: 0, mode: 0o40775 }, null]) {
      expect(darwinWalkOwnerCheck([ROOT_DIR, bad])).toEqual({ ok: false, problem: 'sshd_daemon_unknown' })
    }
  })

  it('checks every one: the first that fails is the answer', () => {
    const good = { plistJson: PLIST, printDisabled: DISABLED, printJob: JOB, netstat: NETSTAT, walkOwners: [ROOT_FILE] }
    expect(checkDarwinDaemon({ ...good, walkOwners: [null] })).toEqual({ ok: false, problem: 'sshd_daemon_unknown' })
    expect(checkDarwinDaemon({ ...good, plistJson: plistWith((p) => (p.ProgramArguments = ['sshd-keygen-wrapper', '-x'])) })).toEqual({ ok: false, problem: 'sshd_daemon_options' })
    expect(checkDarwinDaemon({ ...good, printDisabled: null })).toEqual({ ok: false, problem: 'sshd_daemon_unknown' })
    expect(checkDarwinDaemon({ ...good, printJob: null })).toEqual({ ok: false, problem: 'sshd_daemon_unknown' })
    expect(checkDarwinDaemon({ ...good, netstat: null })).toEqual({ ok: false, problem: 'sshd_daemon_unknown' })
  })
})

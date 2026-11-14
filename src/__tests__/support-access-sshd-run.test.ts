import { describe, it, expect } from 'vitest'
import {
  probeSshd,
  reachableLocalAddresses,
  SSHD_PROBE_MAX_QUERIES,
  SSHD_PROBE_TIMEOUT_MS,
  SSHD_PROGRAM,
  type LocalInterfaceAddress,
  type ProgramResult,
  type SshdProbeDeps,
} from '../support-access-sshd-run.js'

const V_10_0 = 'OpenSSH_10.0p2 Debian-7+deb13u4, OpenSSL 3.5.7 9 Jun 2026\n'
// What 8.9 answers to -V: exit code 1, everything on the error output (measured).
const V_8_9_USAGE = `unknown option -- V
OpenSSH_8.9p1 Ubuntu-3ubuntu0.18, OpenSSL 3.0.2 15 Mar 2022
usage: sshd [-46DdeiqTt] [-C connection_spec] [-c host_cert_file]
`

/** The lines of a real `sshd -T` answer that matter here (order as sshd prints them). */
function sshdT(
  over: { ports?: number[]; tunnel?: string; usedns?: string; listen?: string[]; keysFile?: string; force?: string; acceptEnv?: string[] } = {},
): string {
  const ports = over.ports ?? [22]
  return (
    ports.map((p) => 'port ' + p + '\n').join('') +
    'addressfamily any\n' +
    ports.map((p) => 'listenaddress [::]:' + p + '\nlistenaddress 0.0.0.0:' + p + '\n').join('') +
    (over.listen ?? []).map((a) => 'listenaddress ' + a + ':' + ports[0] + '\n').join('') +
    'permitrootlogin without-password\n' +
    'usedns ' + (over.usedns ?? 'no') + '\n' +
    'trustedusercakeys none\n' +
    'authorizedkeyscommand none\n' +
    'authorizedkeysfile ' + (over.keysFile ?? '.ssh/authorized_keys .ssh/authorized_keys2') + '\n' +
    'permittunnel ' + (over.tunnel ?? 'no') + '\n' +
    'forcecommand ' + (over.force ?? 'none') + '\n' +
    // The stock Debian line, as 9.6 prints it: one line per pattern (measured).
    (over.acceptEnv ?? ['LANG', 'LC_*']).map((p) => 'acceptenv ' + p + '\n').join('')
  )
}

const SOURCES = ['203.0.113.7/32', '2001:db8::7/128']
const INTERFACES: LocalInterfaceAddress[] = [
  { address: '127.0.0.1', internal: true },
  { address: '::1', internal: true },
  { address: '192.0.2.10', internal: false },
  { address: '2001:db8::10', internal: false },
  { address: 'fe80::1c2b:3aff:fe4d:5e6f', internal: false },
]

interface Call {
  file: string
  args: string[]
  timeoutMs: number
}

/** The value of one `key=` part of the `-C` argument of a call, or null. */
function part(args: readonly string[], key: string): string | null {
  const c = args.indexOf('-C')
  if (c === -1) return null
  const found = args[c + 1].split(',').find((p) => p.startsWith(key + '='))
  return found === undefined ? null : found.slice(key.length + 1)
}

function fake(
  over: {
    isRoot?: boolean
    home?: string
    interfaces?: LocalInterfaceAddress[]
    version?: ProgramResult
    answer?: (args: readonly string[]) => ProgramResult | string
    interfacesThrow?: boolean
  } = {},
): { deps: SshdProbeDeps; calls: Call[] } {
  const calls: Call[] = []
  const deps: SshdProbeDeps = {
    run: async (file, args, timeoutMs) => {
      calls.push({ file, args: [...args], timeoutMs })
      if (args[0] === '-V') return over.version ?? { code: 0, stdout: V_10_0, stderr: '' }
      const out = over.answer === undefined ? sshdT() : over.answer(args)
      return typeof out === 'string' ? { code: 0, stdout: out, stderr: '' } : out
    },
    user: {
      name: over.isRoot === false ? 'marveen' : 'root',
      isRoot: over.isRoot !== false,
      home: over.home ?? (over.isRoot === false ? '/home/marveen' : '/root'),
    },
    interfaceAddresses: () => {
      if (over.interfacesThrow === true) throw new Error('interface list exploded')
      return over.interfaces ?? INTERFACES
    },
  }
  return { deps, calls }
}

const queries = (calls: Call[]): Call[] => calls.filter((c) => c.file === SSHD_PROGRAM && c.args[0] === '-T')

describe('reachableLocalAddresses', () => {
  it('keeps the routable addresses, sorted, once each', () => {
    expect(
      reachableLocalAddresses([
        ...INTERFACES,
        { address: '2001:DB8::10', internal: false },
        { address: '192.0.2.10', internal: false },
        { address: '10.0.0.5', internal: false },
      ]),
    ).toEqual(['10.0.0.5', '192.0.2.10', '2001:db8::10'])
  })

  it.each([
    ['a loopback interface address', { address: '192.0.2.99', internal: true }],
    ['an IPv4 loopback address on another interface', { address: '127.0.0.53', internal: false }],
    ['the IPv6 loopback address on another interface', { address: '::1', internal: false }],
    ['an IPv4 link-local address', { address: '169.254.10.20', internal: false }],
    ['an IPv6 link-local address', { address: 'fe80::1', internal: false }],
    ['an IPv6 link-local address from the upper part of the range', { address: 'febf::1', internal: false }],
    ['an address with a zone id', { address: '2001:db8::1%eth0', internal: false }],
    ['something that is not an address', { address: 'eth0', internal: false }],
  ])('leaves out %s', (_label, entry) => {
    expect(reachableLocalAddresses([entry])).toEqual([])
  })

  it('keeps an address that only looks like a link-local one', () => {
    expect(reachableLocalAddresses([{ address: 'fec0::1', internal: false }, { address: '169.25.4.1', internal: false }])).toEqual([
      '169.25.4.1',
      'fec0::1',
    ])
  })
})

describe('probeSshd', () => {
  it('as root: asks the version, then about every connection, by absolute path, with fixed arguments and no host key', async () => {
    const { deps, calls } = fake()
    expect(await probeSshd({ fromCidrs: SOURCES }, deps)).toEqual({
      ok: true,
      version: { major: 10, minor: 0 },
      keysFiles: ['authorized_keys', 'authorized_keys2'],
    })
    expect(SSHD_PROGRAM).toBe('/usr/sbin/sshd')
    expect(calls[0]).toEqual({ file: '/usr/sbin/sshd', args: ['-V'], timeoutMs: 5000 })
    expect(calls.every((c) => c.file === '/usr/sbin/sshd' && c.timeoutMs === SSHD_PROBE_TIMEOUT_MS)).toBe(true)
    expect(queries(calls).map((c) => c.args)).toEqual([
      ['-T', '-C', 'user=root,addr=203.0.113.7,host=203.0.113.7,laddr=192.0.2.10,lport=22'],
      ['-T', '-C', 'user=root,addr=203.0.113.7,host=203.0.113.7,laddr=2001:db8::10,lport=22'],
      ['-T', '-C', 'user=root,addr=2001:db8::7,host=2001:db8::7,laddr=192.0.2.10,lport=22'],
      ['-T', '-C', 'user=root,addr=2001:db8::7,host=2001:db8::7,laddr=2001:db8::10,lport=22'],
    ])
  })

  it('reads the version from the usage text an older sshd prints with exit code 1', async () => {
    const { deps } = fake({ version: { code: 1, stdout: '', stderr: V_8_9_USAGE } })
    expect(await probeSshd({ fromCidrs: SOURCES }, deps)).toMatchObject({ ok: true, version: { major: 8, minor: 9 } })
  })

  // B2 of Dani's review: a non-root sshd -T can miss a drop-in the daemon applies.
  it('as another user: asks the version only, starts nothing else, and refuses with its own reason', async () => {
    const { deps, calls } = fake({ isRoot: false })
    expect(await probeSshd({ fromCidrs: SOURCES }, deps)).toEqual({
      ok: false,
      problem: 'sshd_config_not_fully_readable',
      version: { major: 10, minor: 0 },
    })
    expect(calls).toEqual([{ file: '/usr/sbin/sshd', args: ['-V'], timeoutMs: 5000 }])
  })

  it('as another user: a version that cannot be read or is too old is still named first', async () => {
    expect(await probeSshd({ fromCidrs: SOURCES }, fake({ isRoot: false, version: { code: null, stdout: '', stderr: '' } }).deps)).toMatchObject({
      problem: 'sshd_version_unknown',
    })
    const old = { code: 0, stdout: 'OpenSSH_8.3p1 Debian-1\n', stderr: '' }
    expect(await probeSshd({ fromCidrs: SOURCES }, fake({ isRoot: false, version: old }).deps)).toMatchObject({ problem: 'sshd_too_old' })
  })

  it('refuses, and starts nothing else, when sshd cannot be run', async () => {
    for (const version of [
      { code: null, stdout: '', stderr: '' },
      { code: null, stdout: V_10_0, stderr: '' },
    ]) {
      const { deps, calls } = fake({ version })
      expect(await probeSshd({ fromCidrs: SOURCES }, deps)).toMatchObject({ ok: false, problem: 'sshd_version_unknown' })
      expect(calls).toHaveLength(1)
    }
  })

  // S5 of Dani's review: the contract is a refusal, never a rejection.
  it('resolves with a refusal when a dependency throws, wherever it throws', async () => {
    const exploding = fake({
      answer: () => {
        throw new Error('spawn exploded')
      },
    })
    expect(await probeSshd({ fromCidrs: SOURCES }, exploding.deps)).toEqual({ ok: false, problem: 'sshd_config_unknown', version: null })
    expect(await probeSshd({ fromCidrs: SOURCES }, fake({ interfacesThrow: true }).deps)).toEqual({
      ok: false,
      problem: 'sshd_config_unknown',
      version: null,
    })
    const versionThrows: SshdProbeDeps = {
      ...fake().deps,
      run: async () => {
        throw new Error('no fork')
      },
    }
    expect(await probeSshd({ fromCidrs: SOURCES }, versionThrows)).toMatchObject({ ok: false, problem: 'sshd_config_unknown' })
  })

  // B1 of Dani's review, end to end: a ForceCommand replaces the bound command of the line.
  it.each<[string, string | null, string | null]>([
    ['global', null, null],
    ['Match User root', 'user', 'root'],
    ['Match Address 2001:db8::7', 'addr', '2001:db8::7'],
  ])('REFUSES when a ForceCommand is set (%s)', async (_label, key, value) => {
    const answer = (args: readonly string[]): string =>
      sshdT({ force: key === null || part(args, key) === value ? '/bin/echo FORCED here' : 'none' })
    expect(await probeSshd({ fromCidrs: SOURCES }, fake({ answer }).deps)).toMatchObject({ ok: false, problem: 'force_command_set' })
  })

  it('REFUSES when a client may send an environment name that can run code before the dispatcher', async () => {
    const wide = fake({ answer: () => sshdT({ acceptEnv: ['LANG', 'LC_*', '*'] }) })
    expect(await probeSshd({ fromCidrs: SOURCES }, wide.deps)).toMatchObject({ ok: false, problem: 'accept_env_too_wide' })
    const ubuntu = fake({ answer: () => sshdT({ acceptEnv: ['LANG', 'LC_*', 'COLORTERM', 'NO_COLOR'] }) })
    expect(await probeSshd({ fromCidrs: SOURCES }, ubuntu.deps)).toMatchObject({ ok: true })
    const none = fake({ answer: () => sshdT({ acceptEnv: [] }) })
    expect(await probeSshd({ fromCidrs: SOURCES }, none.deps)).toMatchObject({ ok: true })
  })

  it('refuses when the first answer cannot be read, and asks nothing more', async () => {
    for (const answer of [{ code: 255, stdout: '', stderr: 'no hostkeys available' }, { code: null, stdout: sshdT(), stderr: '' }, '']) {
      const { deps, calls } = fake({ answer: () => answer })
      expect(await probeSshd({ fromCidrs: SOURCES }, deps)).toMatchObject({ ok: false, problem: 'sshd_config_unknown' })
      expect(queries(calls)).toHaveLength(1)
    }
  })

  it('does not take the text of a query that did not exit with 0, even a complete one', async () => {
    let n = 0
    const { deps } = fake({ answer: () => (++n === 3 ? { code: 1, stdout: sshdT(), stderr: '' } : sshdT()) })
    expect(await probeSshd({ fromCidrs: SOURCES }, deps)).toMatchObject({ ok: false, problem: 'sshd_config_unknown' })
  })

  it('asks about EVERY port the first answer names', async () => {
    const { deps, calls } = fake({ answer: () => sshdT({ ports: [22, 2222] }) })
    expect(await probeSshd({ fromCidrs: SOURCES }, deps)).toMatchObject({ ok: true })
    // Two sources, two local addresses, two ports; the first answer is used, not asked for again.
    expect(queries(calls)).toHaveLength(8)
    expect(queries(calls).filter((c) => part(c.args, 'lport') === '2222')).toHaveLength(4)
    expect(new Set(queries(calls).map((c) => c.args.join(' '))).size).toBe(8)
  })

  // POSITIVE CONTROLS, end to end: the tunnel is switched on only inside one
  // Match block, the global value is no. Measured: sshd prints the block's value
  // only for a query that names the matching criterion.
  it.each<[string, string, string]>([
    ['Match LocalPort 2222', 'lport', '2222'],
    ['Match LocalAddress 2001:db8::10', 'laddr', '2001:db8::10'],
    ['Match Address 2001:db8::7', 'addr', '2001:db8::7'],
    ['Match Host 203.0.113.7', 'host', '203.0.113.7'],
    ['Match User root', 'user', 'root'],
  ])('REFUSES when the tunnel is on only under "%s"', async (_block, key, value) => {
    const answer = (args: readonly string[]): string =>
      sshdT({ ports: [22, 2222], tunnel: part(args, key) === value ? 'yes' : 'no' })
    const { deps } = fake({ answer })
    expect(await probeSshd({ fromCidrs: SOURCES }, deps)).toMatchObject({ ok: false, problem: 'tunnel_permitted' })
    // Control: the same machine without the block is accepted.
    const clean = fake({ answer: () => sshdT({ ports: [22, 2222] }) })
    expect(await probeSshd({ fromCidrs: SOURCES }, clean.deps)).toMatchObject({ ok: true })
  })

  it('asks about an address sshd listens on that no interface has, on top of the interface addresses', async () => {
    const { deps, calls } = fake({ answer: () => sshdT({ listen: ['198.51.100.5', '127.0.0.1', '[2001:db8::99]'] }) })
    expect(await probeSshd({ fromCidrs: SOURCES }, deps)).toMatchObject({ ok: true })
    // Two sources, two interface addresses and two listen addresses (the loopback one is not asked about), one port.
    expect(queries(calls)).toHaveLength(8)
    expect([...new Set(queries(calls).map((c) => part(c.args, 'laddr')))].sort()).toEqual([
      '192.0.2.10',
      '198.51.100.5',
      '2001:db8::10',
      '2001:db8::99',
    ])
  })

  it('REFUSES when the tunnel is on only under a Match LocalAddress block for such a listen address', async () => {
    const answer = (args: readonly string[]): string =>
      sshdT({ listen: ['198.51.100.5'], tunnel: part(args, 'laddr') === '198.51.100.5' ? 'yes' : 'no' })
    const { deps } = fake({ answer })
    expect(await probeSshd({ fromCidrs: SOURCES }, deps)).toMatchObject({ ok: false, problem: 'tunnel_permitted' })
  })

  it('counts the listen addresses towards the limit', async () => {
    const many = Array.from({ length: 15 }, (_, i) => ({ address: '192.0.2.' + (i + 1), internal: false }))
    // 2 sources x (15 interface + 2 listen addresses) x 2 ports = 68.
    const over = fake({ interfaces: many, answer: () => sshdT({ ports: [22, 2222], listen: ['198.51.100.5', '198.51.100.6'] }) })
    expect(await probeSshd({ fromCidrs: SOURCES }, over.deps)).toMatchObject({ ok: false, problem: 'sshd_config_unknown' })
    expect(queries(over.calls)).toHaveLength(1)
  })

  it('reads the keys file setting against the home of the user database', async () => {
    const own = { answer: () => sshdT({ keysFile: '/root/.ssh/authorized_keys' }) }
    expect(await probeSshd({ fromCidrs: SOURCES }, fake({ ...own }).deps)).toMatchObject({ ok: true, keysFiles: ['authorized_keys'] })
    const other = { answer: () => sshdT({ keysFile: '/home/marveen/.ssh/authorized_keys' }) }
    expect(await probeSshd({ fromCidrs: SOURCES }, fake({ ...other }).deps)).toMatchObject({
      ok: false,
      problem: 'authorized_keys_path_unsupported',
    })
    expect(await probeSshd({ fromCidrs: SOURCES }, fake({ home: '/srv/root', ...own }).deps)).toMatchObject({
      ok: false,
      problem: 'authorized_keys_path_unsupported',
    })
  })

  it('refuses when the machine has no address a pinned source could reach, and asks nothing', async () => {
    const { deps, calls } = fake({
      interfaces: [
        { address: '127.0.0.1', internal: true },
        { address: 'fe80::1', internal: false },
      ],
    })
    expect(await probeSshd({ fromCidrs: SOURCES }, deps)).toMatchObject({ ok: false, problem: 'sshd_config_unknown' })
    expect(queries(calls)).toHaveLength(0)
  })

  it('refuses when there is no pinned source, and asks nothing', async () => {
    const { deps, calls } = fake()
    expect(await probeSshd({ fromCidrs: [] }, deps)).toMatchObject({ ok: false, problem: 'sshd_config_unknown' })
    expect(queries(calls)).toHaveLength(0)
  })

  it('refuses rather than ask about more connections than the limit', async () => {
    expect(SSHD_PROBE_MAX_QUERIES).toBe(64)
    const many = Array.from({ length: 17 }, (_, i) => ({ address: '192.0.2.' + (i + 1), internal: false }))
    // 2 sources x 17 addresses x 2 ports = 68.
    const over = fake({ interfaces: many, answer: () => sshdT({ ports: [22, 2222] }) })
    expect(await probeSshd({ fromCidrs: SOURCES }, over.deps)).toMatchObject({ ok: false, problem: 'sshd_config_unknown' })
    expect(queries(over.calls)).toHaveLength(1)
    // 2 x 16 x 2 = 64 is still asked.
    const at = fake({ interfaces: many.slice(0, 16), answer: () => sshdT({ ports: [22, 2222] }) })
    expect(await probeSshd({ fromCidrs: SOURCES }, at.deps)).toMatchObject({ ok: true })
    expect(queries(at.calls)).toHaveLength(64)
  })

  it('refuses when UseDNS is on', async () => {
    const { deps } = fake({ answer: () => sshdT({ usedns: 'yes' }) })
    expect(await probeSshd({ fromCidrs: SOURCES }, deps)).toMatchObject({ ok: false, problem: 'sshd_usedns_enabled' })
  })
})

import { describe, it, expect } from 'vitest'
import {
  assessSshd,
  formatSshdConnectionSpec,
  parseSshdEffectiveConfig,
  parseSshdVersion,
  planSshdProbes,
  supportKeysFiles,
  SSHD_DISCOVERY_PORT,
  type SshdAssessmentInput,
  type SshdConnectionSpec,
  type SshdProbeAnswer,
} from '../support-access-sshd.js'

// What `sshd -V` printed in throwaway containers (2026-11-14), verbatim.
const V_7_6 = `unknown option -- V
OpenSSH_7.6p1 Ubuntu-4ubuntu0.7, OpenSSL 1.0.2n  7 Dec 2017
usage: sshd [-46DdeiqTt] [-C connection_spec] [-c host_cert_file]
            [-E log_file] [-f config_file] [-g login_grace_time]
            [-h host_key_file] [-o option] [-p port] [-u len]
`
const V_8_9 = `unknown option -- V
OpenSSH_8.9p1 Ubuntu-3ubuntu0.18, OpenSSL 3.0.2 15 Mar 2022
usage: sshd [-46DdeiqTt] [-C connection_spec] [-c host_cert_file]
            [-E log_file] [-f config_file] [-g login_grace_time]
            [-h host_key_file] [-o option] [-p port] [-u len]
`
const V_10_0 = 'OpenSSH_10.0p2 Debian-7+deb13u4, OpenSSL 3.5.7 9 Jun 2026\n'

// Lines of `sshd -T` on OpenSSH 10.0p2 (Debian 13 defaults), verbatim, in the order sshd printed them.
const T_DEFAULT = `port 22
addressfamily any
listenaddress [::]:22
listenaddress 0.0.0.0:22
permitrootlogin without-password
pubkeyauthentication yes
x11forwarding yes
gatewayports no
usedns no
allowtcpforwarding yes
trustedusercakeys none
authorizedkeyscommand none
authorizedkeysfile .ssh/authorized_keys .ssh/authorized_keys2
hostkey /etc/ssh/ssh_host_rsa_key
hostkey /etc/ssh/ssh_host_ecdsa_key
hostkey /etc/ssh/ssh_host_ed25519_key
acceptenv LANG
acceptenv LC_*
subsystem sftp /usr/lib/openssh/sftp-server
permittunnel no
permituserenvironment no
`

function config(over: Record<string, string>): string {
  let text = T_DEFAULT
  for (const [key, value] of Object.entries(over)) {
    const line = new RegExp('^' + key + ' .*$', 'm')
    if (!line.test(text)) throw new Error('the fixture has no ' + key + ' line')
    text = text.replace(line, value === '' ? '' : key + ' ' + value)
  }
  return text
}

describe('parseSshdVersion', () => {
  it('reads the version from the plain -V answer and from the usage text of older builds', () => {
    expect(parseSshdVersion(V_10_0)).toEqual({ major: 10, minor: 0 })
    expect(parseSshdVersion(V_8_9)).toEqual({ major: 8, minor: 9 })
    expect(parseSshdVersion(V_7_6)).toEqual({ major: 7, minor: 6 })
  })

  it('reads a two-digit minor as a number, not as a decimal', () => {
    expect(parseSshdVersion('OpenSSH_8.10p1\n')).toEqual({ major: 8, minor: 10 })
  })

  it.each([
    ['an empty text', ''],
    ['another implementation', 'Dropbear v2022.83\n'],
    ['the name in the middle of a line', 'usage: this is not OpenSSH_9.6p1 at all\n'],
    ['a version without a minor part', 'OpenSSH_9\n'],
    ['a banner form', 'SSH-2.0-OpenSSH_9.6p1 Ubuntu-3ubuntu13\n'],
    ['two different versions', 'OpenSSH_9.6p1 a\nOpenSSH_8.2p1 b\n'],
  ])('answers null for %s', (_label, text) => {
    expect(parseSshdVersion(text)).toBeNull()
  })

  it('accepts the same version printed twice', () => {
    expect(parseSshdVersion('OpenSSH_9.6p1 a\nOpenSSH_9.6p1 a\n')).toEqual({ major: 9, minor: 6 })
  })
})

describe('parseSshdEffectiveConfig', () => {
  it('reads the settings out of the real output', () => {
    expect(parseSshdEffectiveConfig(T_DEFAULT)).toEqual({
      permitRootLogin: 'without-password',
      permitTunnel: 'no',
      useDns: 'no',
      authorizedKeysFiles: ['.ssh/authorized_keys', '.ssh/authorized_keys2'],
      authorizedKeysCommand: 'none',
      trustedUserCaKeys: 'none',
      listenPorts: [22],
    })
  })

  it.each(['permitrootlogin', 'permittunnel', 'usedns', 'authorizedkeysfile', 'authorizedkeyscommand', 'trustedusercakeys'])(
    'answers null when the %s line is missing',
    (key) => {
      expect(parseSshdEffectiveConfig(config({ [key]: '' }))).toBeNull()
    },
  )

  it('answers null when a setting appears twice (the second line could be the one sshd does not use)', () => {
    expect(parseSshdEffectiveConfig(T_DEFAULT + 'permittunnel yes\n')).toBeNull()
    expect(parseSshdEffectiveConfig('permittunnel yes\n' + T_DEFAULT)).toBeNull()
    expect(parseSshdEffectiveConfig(T_DEFAULT + 'permittunnel no\n')).toBeNull()
    expect(parseSshdEffectiveConfig(T_DEFAULT + 'usedns no\n')).toBeNull()
  })

  it('answers null for a value with unexpected characters or two values where one is expected', () => {
    expect(parseSshdEffectiveConfig(config({ permittunnel: 'no yes' }))).toBeNull()
    expect(parseSshdEffectiveConfig(config({ permittunnel: '"no"' }))).toBeNull()
    expect(parseSshdEffectiveConfig(config({ permitrootlogin: 'yes;no' }))).toBeNull()
    expect(parseSshdEffectiveConfig(config({ usedns: 'no no' }))).toBeNull()
    expect(parseSshdEffectiveConfig(config({ authorizedkeysfile: '.ssh/authorized_keys "x y"' }))).toBeNull()
  })

  it('answers null for the text sshd prints when it cannot answer', () => {
    expect(parseSshdEffectiveConfig('sshd: no hostkeys available -- exiting.\n')).toBeNull()
    expect(parseSshdEffectiveConfig("'Match LocalPort' in configuration but 'lport' not in connection test specification.\n")).toBeNull()
    expect(parseSshdEffectiveConfig('')).toBeNull()
  })

  it('reads a setting name in any letter case, so a differently printed line cannot hide a permitted tunnel', () => {
    const parsed = parseSshdEffectiveConfig(config({ permittunnel: '' }) + 'PermitTunnel Yes\n')
    expect(parsed?.permitTunnel).toBe('yes')
    expect(parseSshdEffectiveConfig(T_DEFAULT + 'PermitTunnel yes\n')).toBeNull()
  })

  it('does not take a setting whose name only starts the same', () => {
    expect(parseSshdEffectiveConfig(config({ permittunnel: '' }) + 'permittunnelx no\n')).toBeNull()
  })

  it('takes a keys command with its arguments as one value', () => {
    const parsed = parseSshdEffectiveConfig(config({ authorizedkeyscommand: '/usr/bin/sss_ssh_authorizedkeys %u "x"' }))
    expect(parsed?.authorizedKeysCommand).toBe('/usr/bin/sss_ssh_authorizedkeys %u "x"')
  })

  // Measured: `Port 2200` with `ListenAddress 127.0.0.1:2201` and `ListenAddress 127.0.0.2` prints these three lines.
  const LISTEN_MIXED = 'port 2200\nlistenaddress 127.0.0.1:2201\nlistenaddress 127.0.0.2:2200\n'
  const withoutListen = T_DEFAULT.replace(/^(port|listenaddress) .*\n/gm, '')

  it('collects the ports from the port lines AND from the listenaddress lines', () => {
    expect(parseSshdEffectiveConfig(LISTEN_MIXED + withoutListen)?.listenPorts).toEqual([2200, 2201])
    expect(parseSshdEffectiveConfig('listenaddress [2001:db8::1]:2022\n' + withoutListen)?.listenPorts).toEqual([2022])
    expect(parseSshdEffectiveConfig('port 2222\nport 22\n' + withoutListen)?.listenPorts).toEqual([22, 2222])
  })

  it.each([
    ['no port and no listenaddress line at all', ''],
    ['a port that is not a number', 'port ssh\n'],
    ['a port that is not a number next to one that is', 'port 22\nport ssh\n'],
    ['port 0', 'port 0\n'],
    ['a port above 65535', 'port 65536\n'],
    ['a listenaddress without a port', 'port 22\nlistenaddress 0.0.0.0\n'],
    ['a listenaddress that names a routing domain', 'port 22\nlistenaddress 0.0.0.0:22 rdomain blue\n'],
    ['a listenaddress with a port above 65535', 'port 22\nlistenaddress 0.0.0.0:70000\n'],
  ])('answers null for %s', (_label, listen) => {
    expect(parseSshdEffectiveConfig(listen + withoutListen)).toBeNull()
  })
})

describe('formatSshdConnectionSpec', () => {
  const spec: SshdConnectionSpec = { user: 'marveen', addr: '203.0.113.7', laddr: '192.0.2.10', lport: 22 }

  it('names every criterion a Match block can use, with the source address as the host', () => {
    expect(formatSshdConnectionSpec(spec)).toBe('user=marveen,addr=203.0.113.7,host=203.0.113.7,laddr=192.0.2.10,lport=22')
    expect(formatSshdConnectionSpec({ user: 'root', addr: '2001:db8::7', laddr: '2001:db8::10', lport: 2222 })).toBe(
      'user=root,addr=2001:db8::7,host=2001:db8::7,laddr=2001:db8::10,lport=2222',
    )
  })

  it.each([
    ['a user with a comma', { user: 'a,addr=198.51.100.9' }],
    ['a user with a space', { user: 'a b' }],
    ['a user that starts with a dash', { user: '-x' }],
    ['an empty user', { user: '' }],
    ['a user of 65 characters', { user: 'a'.repeat(65) }],
    ['a source that is a host name', { addr: 'support.example' }],
    ['a source that is a word of hexadecimal letters', { addr: 'beef' }],
    ['a source with three numbers', { addr: '203.0.113' }],
    ['a source with a number above 255', { addr: '203.0.113.700' }],
    ['a local address of colons only', { laddr: ':::' }],
    ['a source with a prefix length', { addr: '203.0.113.7/32' }],
    ['a source that carries a second criterion', { addr: '203.0.113.7,user=root' }],
    ['a local address with a zone id', { laddr: 'fe80::1%eth0' }],
    ['a local address that is empty', { laddr: '' }],
    ['port 0', { lport: 0 }],
    ['a port above 65535', { lport: 65536 }],
    ['a port that is not a whole number', { lport: 22.5 }],
  ])('answers null for %s', (_label, over) => {
    expect(formatSshdConnectionSpec({ ...spec, ...over })).toBeNull()
  })

  it('accepts the user names a system really has', () => {
    for (const user of ['root', 'ubuntu', 'marveen_1', 'first.last', 'Admin', '_svc', 'a'.repeat(64)]) {
      expect(formatSshdConnectionSpec({ ...spec, user })).not.toBeNull()
    }
  })
})

const SOURCES = ['203.0.113.7/32', '2001:db8::7/128']
const LOCALS = ['192.0.2.10', '2001:db8::10']

describe('planSshdProbes', () => {
  const base = { loginUser: 'marveen', fromCidrs: SOURCES, localAddresses: LOCALS }

  it('asks ONE question before the ports are known, on the discovery port', () => {
    expect(SSHD_DISCOVERY_PORT).toBe(22)
    expect(planSshdProbes({ ...base, listenPorts: null })).toEqual([
      { user: 'marveen', addr: '203.0.113.7', laddr: '192.0.2.10', lport: 22 },
    ])
  })

  it('then asks about EVERY source on EVERY local address on EVERY port', () => {
    const plan = planSshdProbes({ ...base, listenPorts: [22, 2222] }) ?? []
    expect(plan).toHaveLength(8)
    expect(plan.map((s) => formatSshdConnectionSpec(s)).sort()).toEqual(
      [
        'user=marveen,addr=2001:db8::7,host=2001:db8::7,laddr=192.0.2.10,lport=22',
        'user=marveen,addr=2001:db8::7,host=2001:db8::7,laddr=192.0.2.10,lport=2222',
        'user=marveen,addr=2001:db8::7,host=2001:db8::7,laddr=2001:db8::10,lport=22',
        'user=marveen,addr=2001:db8::7,host=2001:db8::7,laddr=2001:db8::10,lport=2222',
        'user=marveen,addr=203.0.113.7,host=203.0.113.7,laddr=192.0.2.10,lport=22',
        'user=marveen,addr=203.0.113.7,host=203.0.113.7,laddr=192.0.2.10,lport=2222',
        'user=marveen,addr=203.0.113.7,host=203.0.113.7,laddr=2001:db8::10,lport=22',
        'user=marveen,addr=203.0.113.7,host=203.0.113.7,laddr=2001:db8::10,lport=2222',
      ].sort(),
    )
  })

  it.each([
    ['no source', { fromCidrs: [] }],
    ['no local address', { localAddresses: [] }],
    ['no port', { listenPorts: [] }],
    ['a source that is a range', { fromCidrs: ['203.0.113.0/24'] }],
    ['a second source that is not an address', { fromCidrs: ['203.0.113.7/32', 'x'] }],
    ['a local address that cannot be carried', { localAddresses: ['192.0.2.10', 'fe80::1%eth0'] }],
    ['a login user that cannot be carried', { loginUser: 'a,b' }],
    ['a port that is not a port', { listenPorts: [22, 0] }],
  ])('answers null, rather than asking about less, for %s', (_label, over) => {
    expect(planSshdProbes({ ...base, listenPorts: [22], ...over })).toBeNull()
  })
})

describe('supportKeysFiles', () => {
  it('names the file the line goes into, and the second file when sshd reads it too', () => {
    expect(supportKeysFiles(['.ssh/authorized_keys'])).toEqual(['authorized_keys'])
    expect(supportKeysFiles(['%h/.ssh/authorized_keys'])).toEqual(['authorized_keys'])
    expect(supportKeysFiles(['.ssh/authorized_keys', '.ssh/authorized_keys2'])).toEqual(['authorized_keys', 'authorized_keys2'])
    expect(supportKeysFiles(['%h/.ssh/authorized_keys2', '.ssh/authorized_keys'])).toEqual(['authorized_keys', 'authorized_keys2'])
  })

  it.each([
    ['only the second file', ['.ssh/authorized_keys2']],
    ['a per-user directory elsewhere', ['/etc/ssh/keys/%u']],
    ['an absolute path, even to the same file', ['/root/.ssh/authorized_keys']],
    ['a name that only ends the same', ['x.ssh/authorized_keys']],
    ['the right file next to a path elsewhere', ['/etc/ssh/keys/%u', '%h/.ssh/authorized_keys']],
    ['the right file next to a third file', ['.ssh/authorized_keys', '.ssh/authorized_keys3']],
    ['nothing', []],
  ])('answers null for %s', (_label, entries) => {
    expect(supportKeysFiles(entries)).toBeNull()
  })
})

describe('assessSshd', () => {
  /** One answer per planned connection for port 22; `textFor` decides what sshd said for each. */
  function answers(textFor: (spec: SshdConnectionSpec) => string | null = () => T_DEFAULT, ports: number[] = [22]): SshdProbeAnswer[] {
    const plan = planSshdProbes({ loginUser: 'root', fromCidrs: SOURCES, localAddresses: LOCALS, listenPorts: ports }) ?? []
    return plan.map((spec) => ({ spec, text: textFor(spec) }))
  }
  const ok: SshdAssessmentInput = {
    versionText: V_10_0,
    loginIsRoot: true,
    loginUser: 'root',
    fromCidrs: SOURCES,
    localAddresses: LOCALS,
    answers: answers(),
  }
  const every = (text: string | null): SshdAssessmentInput => ({ ...ok, answers: answers(() => text) })

  it('accepts the measured defaults from 8.9 and 10.0, and says which files a removal has to clean', () => {
    expect(assessSshd(ok)).toEqual({ ok: true, version: { major: 10, minor: 0 }, keysFiles: ['authorized_keys', 'authorized_keys2'] })
    expect(assessSshd({ ...ok, versionText: V_8_9 })).toMatchObject({ ok: true, version: { major: 8, minor: 9 } })
    // The macOS setting names one file.
    expect(assessSshd(every(config({ authorizedkeysfile: '.ssh/authorized_keys' })))).toMatchObject({
      ok: true,
      keysFiles: ['authorized_keys'],
    })
  })

  it('refuses when the version cannot be read', () => {
    expect(assessSshd({ ...ok, versionText: null })).toMatchObject({ ok: false, problem: 'sshd_version_unknown' })
    expect(assessSshd({ ...ok, versionText: 'Dropbear v2022.83\n' })).toMatchObject({ ok: false, problem: 'sshd_version_unknown' })
  })

  it('refuses below 8.4, where verify-required makes sshd drop the whole line', () => {
    expect(assessSshd({ ...ok, versionText: V_7_6 })).toMatchObject({ ok: false, problem: 'sshd_too_old' })
    expect(assessSshd({ ...ok, versionText: 'OpenSSH_8.3p1\n' })).toMatchObject({ ok: false, problem: 'sshd_too_old' })
    expect(assessSshd({ ...ok, versionText: 'OpenSSH_8.4p1\n' })).toMatchObject({ ok: true })
  })

  it('refuses when there is no answer at all', () => {
    expect(assessSshd({ ...ok, answers: [] })).toMatchObject({ ok: false, problem: 'sshd_config_unknown' })
  })

  it('refuses when the configuration cannot be read, for every connection or for ONE of them', () => {
    expect(assessSshd(every(null))).toMatchObject({ ok: false, problem: 'sshd_config_unknown' })
    expect(assessSshd(every(''))).toMatchObject({ ok: false, problem: 'sshd_config_unknown' })
    expect(assessSshd(every('sshd: no hostkeys available -- exiting.\n'))).toMatchObject({ ok: false, problem: 'sshd_config_unknown' })
    const last = answers().length - 1
    for (const bad of [null, '', 'permittunnel no\n']) {
      const some = answers().map((a, i) => (i === last ? { ...a, text: bad } : a))
      expect(assessSshd({ ...ok, answers: some })).toMatchObject({ ok: false, problem: 'sshd_config_unknown' })
    }
  })

  // POSITIVE CONTROL. Measured on OpenSSH 8.9, 9.2, 9.6 and 10.0: with the tunnel
  // switched on ONLY inside a Match block, the plain `sshd -T` prints
  // `permittunnel no`, and the query that names the matching criterion prints
  // the block's value. Each case below is one such block.
  it.each<[string, (spec: SshdConnectionSpec) => boolean, string]>([
    ['Match User root', (s) => s.user === 'root', 'yes'],
    ['Match Address 203.0.113.7', (s) => s.addr === '203.0.113.7', 'yes'],
    ['Match Host 2001:db8::7', (s) => s.addr === '2001:db8::7', 'yes'],
    ['Match User root Address 203.0.113.7', (s) => s.user === 'root' && s.addr === '203.0.113.7', 'point-to-point'],
    ['Match LocalAddress 2001:db8::10', (s) => s.laddr === '2001:db8::10', 'yes'],
    ['Match Address 2001:db8::7 LocalAddress 192.0.2.10', (s) => s.addr === '2001:db8::7' && s.laddr === '192.0.2.10', 'ethernet'],
  ])('REFUSES when the tunnel is on only under "%s", though the global value is no', (_block, matches, value) => {
    const input = { ...ok, answers: answers((spec) => (matches(spec) ? config({ permittunnel: value }) : T_DEFAULT)) }
    expect(input.answers.some((a) => a.text === T_DEFAULT) || _block === 'Match User root').toBe(true)
    expect(assessSshd(input)).toMatchObject({ ok: false, problem: 'tunnel_permitted' })
  })

  it('REFUSES when the tunnel is on only for one PORT (Match LocalPort)', () => {
    const twoPorts = T_DEFAULT.replace('port 22\n', 'port 22\nport 2222\n')
    const input = {
      ...ok,
      answers: answers((spec) => (spec.lport === 2222 ? twoPorts.replace('permittunnel no', 'permittunnel yes') : twoPorts), [22, 2222]),
    }
    expect(assessSshd(input)).toMatchObject({ ok: false, problem: 'tunnel_permitted' })
    // The same machine with the block gone is accepted: the refusal came from the one port.
    expect(assessSshd({ ...ok, answers: answers(() => twoPorts, [22, 2222]) })).toMatchObject({ ok: true })
  })

  it('refuses when sshd names a port nobody asked about', () => {
    const twoPorts = T_DEFAULT.replace('port 22\n', 'port 22\nport 2222\n')
    expect(assessSshd({ ...ok, answers: answers(() => twoPorts, [22]) })).toMatchObject({ ok: false, problem: 'sshd_config_unknown' })
  })

  it.each<[string, (spec: SshdConnectionSpec) => boolean]>([
    ['one pinned source', (s) => s.addr === '2001:db8::7'],
    ['one local address', (s) => s.laddr === '192.0.2.10'],
    ['one single combination', (s) => s.addr === '203.0.113.7' && s.laddr === '2001:db8::10'],
  ])('refuses when %s was not asked about', (_label, dropped) => {
    const fewer = answers().filter((a) => !dropped(a.spec))
    expect(fewer.length).toBeGreaterThan(0)
    expect(assessSshd({ ...ok, answers: fewer })).toMatchObject({ ok: false, problem: 'sshd_config_unknown' })
  })

  it('refuses when the answers were asked for another user than the login user', () => {
    const other = answers().map((a) => ({ ...a, spec: { ...a.spec, user: 'ubuntu' } }))
    expect(assessSshd({ ...ok, answers: other })).toMatchObject({ ok: false, problem: 'sshd_config_unknown' })
  })

  it('refuses when the answers disagree about the ports, whichever answer names the extra one', () => {
    const twoPorts = T_DEFAULT.replace('port 22\n', 'port 22\nport 2222\n')
    for (const odd of [0, answers().length - 1]) {
      const input = { ...ok, answers: answers().map((a, i) => (i === odd ? { ...a, text: twoPorts } : a)) }
      expect(assessSshd(input)).toMatchObject({ ok: false, problem: 'sshd_config_unknown' })
    }
  })

  it('refuses when UseDNS is on, for every connection or for one', () => {
    expect(assessSshd(every(config({ usedns: 'yes' })))).toMatchObject({ ok: false, problem: 'sshd_usedns_enabled' })
    const one = answers().map((a, i) => (i === 1 ? { ...a, text: config({ usedns: 'yes' }) } : a))
    expect(assessSshd({ ...ok, answers: one })).toMatchObject({ ok: false, problem: 'sshd_usedns_enabled' })
  })

  it.each(['yes', 'point-to-point', 'ethernet', 'maybe'])('REFUSES when tunnels are permitted (permittunnel %s)', (value) => {
    expect(assessSshd(every(config({ permittunnel: value })))).toMatchObject({ ok: false, problem: 'tunnel_permitted' })
    // The login user does not change this: the refusal is not a root-only rule.
    expect(assessSshd({ ...every(config({ permittunnel: value })), loginIsRoot: false })).toMatchObject({
      ok: false,
      problem: 'tunnel_permitted',
    })
  })

  it('refuses a root install when root cannot log in with a key', () => {
    expect(assessSshd(every(config({ permitrootlogin: 'no' })))).toMatchObject({ ok: false, problem: 'root_login_disabled' })
    expect(assessSshd(every(config({ permitrootlogin: 'sometimes' })))).toMatchObject({ ok: false, problem: 'root_login_disabled' })
    const one = answers().map((a, i) => (i === 2 ? { ...a, text: config({ permitrootlogin: 'no' }) } : a))
    expect(assessSshd({ ...ok, answers: one })).toMatchObject({ ok: false, problem: 'root_login_disabled' })
  })

  it.each(['yes', 'without-password', 'prohibit-password', 'forced-commands-only'])(
    'accepts a root install with permitrootlogin %s',
    (value) => {
      expect(assessSshd(every(config({ permitrootlogin: value })))).toMatchObject({ ok: true })
    },
  )

  it('does not look at the root login setting when the login user is not root', () => {
    expect(assessSshd({ ...every(config({ permitrootlogin: 'no' })), loginIsRoot: false })).toMatchObject({ ok: true })
  })

  it('refuses when sshd reads keys from anywhere but the two files under the login user\'s .ssh', () => {
    for (const value of [
      '/etc/ssh/keys/%u',
      '.ssh/authorized_keys2',
      '/root/.ssh/authorized_keys',
      'x.ssh/authorized_keys',
      '/etc/ssh/keys/%u %h/.ssh/authorized_keys',
    ]) {
      expect(assessSshd(every(config({ authorizedkeysfile: value })))).toMatchObject({
        ok: false,
        problem: 'authorized_keys_path_unsupported',
      })
    }
  })

  it('refuses when a Match block names another keys file for ONE connection', () => {
    const one = answers().map((a, i) => (i === 3 ? { ...a, text: config({ authorizedkeysfile: '.ssh/authorized_keys' }) } : a))
    expect(assessSshd({ ...ok, answers: one })).toMatchObject({ ok: false, problem: 'authorized_keys_path_unsupported' })
  })

  it('refuses when keys can also come from a command or from a user CA', () => {
    expect(assessSshd(every(config({ authorizedkeyscommand: '/usr/bin/sss_ssh_authorizedkeys %u' })))).toMatchObject({
      ok: false,
      problem: 'other_key_source',
    })
    expect(assessSshd(every(config({ trustedusercakeys: '/etc/ssh/user_ca.pub' })))).toMatchObject({
      ok: false,
      problem: 'other_key_source',
    })
    const one = answers().map((a, i) => (i === 1 ? { ...a, text: config({ trustedusercakeys: '/etc/ssh/user_ca.pub' }) } : a))
    expect(assessSshd({ ...ok, answers: one })).toMatchObject({ ok: false, problem: 'other_key_source' })
  })

  it('names the FIRST failing check', () => {
    expect(assessSshd({ ...every(config({ permittunnel: 'yes' })), versionText: V_7_6 })).toMatchObject({
      ok: false,
      problem: 'sshd_too_old',
      version: { major: 7, minor: 6 },
    })
    expect(assessSshd(every(config({ permittunnel: 'yes', authorizedkeysfile: '/etc/ssh/keys/%u' })))).toMatchObject({
      ok: false,
      problem: 'tunnel_permitted',
    })
    expect(assessSshd(every(config({ usedns: 'yes', permittunnel: 'yes' })))).toMatchObject({ ok: false, problem: 'sshd_usedns_enabled' })
  })
})

import { describe, it, expect } from 'vitest'
import { assessSshd, parseSshdEffectiveConfig, parseSshdVersion } from '../support-access-sshd.js'

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
permitrootlogin without-password
pubkeyauthentication yes
x11forwarding yes
gatewayports no
allowtcpforwarding yes
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
  it('reads the three settings out of the real output', () => {
    expect(parseSshdEffectiveConfig(T_DEFAULT)).toEqual({
      permitRootLogin: 'without-password',
      permitTunnel: 'no',
      authorizedKeysFiles: ['.ssh/authorized_keys', '.ssh/authorized_keys2'],
    })
  })

  it.each(['permitrootlogin', 'permittunnel', 'authorizedkeysfile'])('answers null when the %s line is missing', (key) => {
    expect(parseSshdEffectiveConfig(config({ [key]: '' }))).toBeNull()
  })

  it('answers null when a setting appears twice (the second line could be the one sshd does not use)', () => {
    expect(parseSshdEffectiveConfig(T_DEFAULT + 'permittunnel yes\n')).toBeNull()
    expect(parseSshdEffectiveConfig('permittunnel yes\n' + T_DEFAULT)).toBeNull()
    expect(parseSshdEffectiveConfig(T_DEFAULT + 'permittunnel no\n')).toBeNull()
  })

  it('answers null for a value with unexpected characters or two values where one is expected', () => {
    expect(parseSshdEffectiveConfig(config({ permittunnel: 'no yes' }))).toBeNull()
    expect(parseSshdEffectiveConfig(config({ permittunnel: '"no"' }))).toBeNull()
    expect(parseSshdEffectiveConfig(config({ permitrootlogin: 'yes;no' }))).toBeNull()
  })

  it('answers null for the text sshd prints when it cannot answer', () => {
    expect(parseSshdEffectiveConfig('sshd: no hostkeys available -- exiting.\n')).toBeNull()
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
})

describe('assessSshd', () => {
  const ok = { versionText: V_10_0, configText: T_DEFAULT, loginIsRoot: true }

  it('accepts the measured defaults from 8.9 and 10.0', () => {
    expect(assessSshd(ok)).toEqual({ ok: true, version: { major: 10, minor: 0 } })
    expect(assessSshd({ ...ok, versionText: V_8_9 })).toEqual({ ok: true, version: { major: 8, minor: 9 } })
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

  it('refuses when the configuration cannot be read', () => {
    expect(assessSshd({ ...ok, configText: null })).toMatchObject({ ok: false, problem: 'sshd_config_unknown' })
    expect(assessSshd({ ...ok, configText: 'sshd: no hostkeys available -- exiting.\n' })).toMatchObject({
      ok: false,
      problem: 'sshd_config_unknown',
    })
  })

  it.each(['yes', 'point-to-point', 'ethernet', 'maybe'])('REFUSES when tunnels are permitted (permittunnel %s)', (value) => {
    expect(assessSshd({ ...ok, configText: config({ permittunnel: value }) })).toMatchObject({
      ok: false,
      problem: 'tunnel_permitted',
    })
    // The login user does not change this: the refusal is not a root-only rule.
    expect(assessSshd({ ...ok, loginIsRoot: false, configText: config({ permittunnel: value }) })).toMatchObject({
      ok: false,
      problem: 'tunnel_permitted',
    })
  })

  it('refuses a root install when root cannot log in with a key', () => {
    expect(assessSshd({ ...ok, configText: config({ permitrootlogin: 'no' }) })).toMatchObject({
      ok: false,
      problem: 'root_login_disabled',
    })
    expect(assessSshd({ ...ok, configText: config({ permitrootlogin: 'sometimes' }) })).toMatchObject({
      ok: false,
      problem: 'root_login_disabled',
    })
  })

  it.each(['yes', 'without-password', 'prohibit-password', 'forced-commands-only'])(
    'accepts a root install with permitrootlogin %s',
    (value) => {
      expect(assessSshd({ ...ok, configText: config({ permitrootlogin: value }) })).toMatchObject({ ok: true })
    },
  )

  it('does not look at the root login setting when the login user is not root', () => {
    expect(assessSshd({ ...ok, loginIsRoot: false, configText: config({ permitrootlogin: 'no' }) })).toMatchObject({ ok: true })
  })

  it('refuses when sshd does not read .ssh/authorized_keys of the login user', () => {
    for (const value of ['/etc/ssh/keys/%u', '.ssh/authorized_keys2', '/root/.ssh/authorized_keys', 'x.ssh/authorized_keys']) {
      expect(assessSshd({ ...ok, configText: config({ authorizedkeysfile: value }) })).toMatchObject({
        ok: false,
        problem: 'authorized_keys_path_unsupported',
      })
    }
    expect(assessSshd({ ...ok, configText: config({ authorizedkeysfile: '/etc/ssh/keys/%u %h/.ssh/authorized_keys' }) })).toMatchObject({
      ok: true,
    })
  })

  it('names the FIRST failing check: an old sshd with tunnels on is "too old"', () => {
    expect(assessSshd({ ...ok, versionText: V_7_6, configText: config({ permittunnel: 'yes' }) })).toMatchObject({
      ok: false,
      problem: 'sshd_too_old',
      version: { major: 7, minor: 6 },
    })
  })
})

import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  confirmsAsRootFile,
  DEFAULT_ED25519_HOST_KEY_PUB,
  hostKeyPubCandidates,
  keyOfPub,
  readOwnHostKey,
  readRootOwnedPub,
  ed25519HostKey,
  hostKeyFingerprint,
  hostKeyFromKeyscan,
  scanOwnHostKey,
  sendSupportHostKey,
  SSH_KEYSCAN_PROGRAM,
  SUPPORT_HOST_KEY_MAX_BODY_BYTES,
  SUPPORT_HOST_KEY_PATH,
  SUPPORT_HOST_KEY_SCAN_RUN_MS,
  SUPPORT_HOST_KEY_TIMEOUT_MS,
} from '../support-access-hostkey.js'
import type { RedeemRequest, RedeemTransport } from '../support-access-redeem.js'
import { SSHD_PROGRAM, type ProgramResult } from '../support-access-sshd-run.js'

// TEST ONLY keys: the right shape, issued by nobody (32 bytes of 0x09 and of 0x0a).
const B64 = 'AAAAC3NzaC1lZDI1NTE5AAAAIAkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJ'
const B64_OTHER = 'AAAAC3NzaC1lZDI1NTE5AAAAIAoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoK'
const KEY = 'ssh-ed25519 ' + B64
const TOKEN = 'mst_' + 'TESTONLY'.repeat(5) + '_-0'

/** The base64 of a blob made of these parts: a length-prefixed type string, then a length-prefixed key. */
function blob(type: string, keyLen: number, typeLen = type.length): string {
  const head = Buffer.alloc(4)
  head.writeUInt32BE(typeLen)
  const mid = Buffer.alloc(4)
  mid.writeUInt32BE(keyLen)
  return Buffer.concat([head, Buffer.from(type, 'latin1'), mid, Buffer.alloc(keyLen, 9)]).toString('base64')
}

describe('the host key shape (support-hostkey-v1)', () => {
  it('accepts exactly "ssh-ed25519 " and 68 base64 characters that hold the type and 32 bytes', () => {
    expect(blob('ssh-ed25519', 32)).toBe(B64)
    expect(ed25519HostKey(KEY)).toBe(KEY)
  })

  it.each<[string, string]>([
    ['a comment', KEY + ' root@host'],
    ['a trailing space', KEY + ' '],
    ['a line end', KEY + '\n'],
    ['a leading space', ' ' + KEY],
    ['two spaces', 'ssh-ed25519  ' + B64],
    ['another type', 'ssh-rsa ' + B64],
    ['an sk key type', 'sk-ssh-ed25519@openssh.com ' + B64],
    ['one character short', 'ssh-ed25519 ' + B64.slice(0, 67)],
    ['one character more', 'ssh-ed25519 ' + B64 + 'A'],
    ['padding in place of the last character', 'ssh-ed25519 ' + B64.slice(0, 67) + '='],
    ['a character outside base64', 'ssh-ed25519 ' + B64.slice(0, 67) + '-'],
    ['another type string inside', 'ssh-ed25519 ' + blob('ssh-ed25518', 32)],
    ['a wrong type length inside', 'ssh-ed25519 ' + blob('ssh-ed25519', 32, 12)],
    ['a wrong key length inside', 'ssh-ed25519 ' + blob('ssh-ed25519', 32).slice(0, 20) + 'h' + blob('ssh-ed25519', 32).slice(21)],
    ['empty', ''],
  ])('refuses %s', (_label, text) => {
    expect(ed25519HostKey(text)).toBeNull()
  })

  it('the wrong-key-length case really changes only the length field', () => {
    const bad = Buffer.from(blob('ssh-ed25519', 32).slice(0, 20) + 'h' + blob('ssh-ed25519', 32).slice(21), 'base64')
    expect(bad.subarray(4, 15).toString('latin1')).toBe('ssh-ed25519')
    expect(bad.readUInt32BE(15)).not.toBe(32)
  })

  it('the fingerprint is the one ssh-keygen -lf prints, and never the key', () => {
    // measured: ssh-keygen -lf on a file with KEY prints SHA256:xcTb/ZL8NmQsvo9k2j/c7dIyp7nvDnswfPZHlzcZwz0
    expect(hostKeyFingerprint(KEY)).toBe('SHA256:xcTb/ZL8NmQsvo9k2j/c7dIyp7nvDnswfPZHlzcZwz0')
    expect(hostKeyFingerprint(KEY)).not.toContain(B64)
  })
})

describe('the ssh-keyscan answer (Samu 79773: exactly one ed25519 line)', () => {
  it('takes the one key line, skipping the "#" banner line (port 22 and another port)', () => {
    expect(hostKeyFromKeyscan('# 127.0.0.1:22 SSH-2.0-OpenSSH_10.2\n127.0.0.1 ' + KEY + '\n')).toBe(KEY)
    expect(hostKeyFromKeyscan('# 127.0.0.1:2222 SSH-2.0-OpenSSH_9.6\n[127.0.0.1]:2222 ' + KEY + '\n')).toBe(KEY)
  })

  it.each<[string, string]>([
    ['no line (no sshd)', ''],
    ['only the banner', '# 127.0.0.1:22 SSH-2.0-OpenSSH_10.2\n'],
    ['two lines with two keys', '127.0.0.1 ' + KEY + '\n127.0.0.1 ssh-ed25519 ' + B64_OTHER + '\n'],
    ['two lines with the same key', '127.0.0.1 ' + KEY + '\n127.0.0.1 ' + KEY + '\n'],
    ['another type', '127.0.0.1 ssh-rsa ' + B64 + '\n'],
    ['a key line and another line', '127.0.0.1 ' + KEY + '\nsomething else\n'],
    ['a comment after the key', '127.0.0.1 ' + KEY + ' root@host\n'],
    ['no host field', KEY + '\n'],
    ['an empty host field', ' ' + KEY + '\n'],
    ['a key of the wrong shape', '127.0.0.1 ssh-ed25519 ' + B64.slice(0, 67) + '\n'],
  ])('is no key for %s', (_label, out) => {
    expect(hostKeyFromKeyscan(out)).toBeNull()
  })
})

describe('asking the local sshd', () => {
  const runner = (result: ProgramResult | 'throw') => {
    const calls: { file: string; args: readonly string[]; timeoutMs: number }[] = []
    const run = async (file: string, args: readonly string[], timeoutMs: number): Promise<ProgramResult> => {
      calls.push({ file, args, timeoutMs })
      if (result === 'throw') throw new Error('spawn failed')
      return result
    }
    return { calls, run }
  }

  it('runs ONLY ssh-keyscan, by absolute path, ed25519 only, a time limit, 127.0.0.1 on the given port', async () => {
    const r = runner({ code: 0, stdout: '# banner\n[127.0.0.1]:2222 ' + KEY + '\n', stderr: '' })
    expect(await scanOwnHostKey(2222, r.run)).toBe(KEY)
    expect(r.calls).toEqual([{ file: SSH_KEYSCAN_PROGRAM, args: ['-T', '5', '-t', 'ed25519', '-p', '2222', '127.0.0.1'], timeoutMs: SUPPORT_HOST_KEY_SCAN_RUN_MS }])
    expect(SSH_KEYSCAN_PROGRAM).toBe('/usr/bin/ssh-keyscan')
  })

  // The non-root case: the probe hands sshd a throwaway key with -h (support-access-sshd-run.ts). That key lives
  // only in the probe's own run of sshd; the key read here comes from the daemon over the wire, and sshd itself is
  // never started here, so the throwaway key cannot be what is sent.
  it('never starts sshd: the probe\'s throwaway -h key cannot reach the key that is sent', async () => {
    const r = runner({ code: 0, stdout: '127.0.0.1 ' + KEY + '\n', stderr: '' })
    await scanOwnHostKey(22, r.run)
    expect(r.calls.map((c) => c.file)).not.toContain(SSHD_PROGRAM)
    expect(r.calls.flatMap((c) => c.args)).not.toContain('-h')
  })

  it.each<[string, ProgramResult | 'throw']>([
    // measured on macOS 26 against a closed port: exit 1, "write (127.0.0.1): Broken pipe" on stderr, nothing on stdout
    ['no running sshd (exit 1, nothing printed)', { code: 1, stdout: '', stderr: 'write (127.0.0.1): Broken pipe\n' }],
    ['a key printed but a failing exit', { code: 1, stdout: '127.0.0.1 ' + KEY + '\n', stderr: '' }],
    ['the time limit (code null)', { code: null, stdout: '', stderr: '' }],
    ['a run that throws', 'throw'],
    ['two lines', { code: 0, stdout: '127.0.0.1 ' + KEY + '\n127.0.0.1 ' + KEY + '\n', stderr: '' }],
    ['a wrong shape', { code: 0, stdout: '127.0.0.1 ' + KEY + ' c\n', stderr: '' }],
  ])('is null for %s', async (_label, result) => {
    expect(await scanOwnHostKey(22, runner(result).run)).toBeNull()
  })

  it.each([0, 65536, 22.5, Number.NaN])('asks nothing for the port %s', async (port) => {
    const r = runner({ code: 0, stdout: '127.0.0.1 ' + KEY + '\n', stderr: '' })
    expect(await scanOwnHostKey(port, r.run)).toBeNull()
    expect(r.calls).toEqual([])
  })
})

describe('sending the key to marveen.io', () => {
  const transportOf = (answer: { status: number; body: string } | 'throw') => {
    const sent: RedeemRequest[] = []
    const transport: RedeemTransport = async (req) => {
      sent.push(req)
      if (answer === 'throw') throw new Error('timeout')
      return answer
    }
    return { sent, transport }
  }

  it('posts exactly {"host_key":"..."} to the fixed origin, the token as bearer; 200 is stored', async () => {
    const t = transportOf({ status: 200, body: '{"stored":true}' })
    expect(await sendSupportHostKey({ token: TOKEN, hostKey: KEY }, t.transport)).toBe('stored')
    expect(t.sent).toEqual([
      {
        origin: 'https://api.marveen.io',
        path: SUPPORT_HOST_KEY_PATH,
        body: '{"host_key":"' + KEY + '"}',
        timeoutMs: SUPPORT_HOST_KEY_TIMEOUT_MS,
        maxBodyBytes: SUPPORT_HOST_KEY_MAX_BODY_BYTES,
        bearer: TOKEN,
      },
    ])
    expect(SUPPORT_HOST_KEY_PATH).toBe('/support/v1/host-key')
  })

  it('only the status counts: a 200 with another body is stored too', async () => {
    expect(await sendSupportHostKey({ token: TOKEN, hostKey: KEY }, transportOf({ status: 200, body: '' }).transport)).toBe('stored')
  })

  it.each<[string, { status: number; body: string } | 'throw']>([
    ['201', { status: 201, body: '{"stored":true}' }],
    ['400', { status: 400, body: '{"error":"invalid_request"}' }],
    ['401 invalid token', { status: 401, body: '{"error":"invalid_status_token"}' }],
    ['401 revoked', { status: 401, body: '{"error":"token_revoked"}' }],
    ['429', { status: 429, body: '{"error":"rate_limited"}' }],
    ['503', { status: 503, body: '{"error":"unavailable"}' }],
    ['no answer', 'throw'],
  ])('%s is not stored, and nothing throws', async (_label, answer) => {
    expect(await sendSupportHostKey({ token: TOKEN, hostKey: KEY }, transportOf(answer).transport)).toBe('not_stored')
  })
})

describe('the cross-check with a root-owned .pub (Dani 79778, Samu 79780)', () => {
  const scanning = (stdout: string, code: number | null = 0) => {
    const files: string[] = []
    return {
      files,
      run: async (): Promise<ProgramResult> => ({ code, stdout, stderr: '' }),
      reader: (pubs: Record<string, string>) => (path: string): string | null => {
        files.push(path)
        return pubs[path] ?? null
      },
    }
  }
  const SSHD = { listenPorts: [22], hostKeyFiles: [] as string[] }

  it('a root-owned file: owner root, a plain file, no write bit for group or others', () => {
    expect(confirmsAsRootFile({ uid: 0, mode: 0o100644, isFile: true })).toBe(true)
    expect(confirmsAsRootFile({ uid: 0, mode: 0o100600, isFile: true })).toBe(true)
    expect(confirmsAsRootFile({ uid: 501, mode: 0o100644, isFile: true })).toBe(false)
    expect(confirmsAsRootFile({ uid: 0, mode: 0o100664, isFile: true })).toBe(false)
    expect(confirmsAsRootFile({ uid: 0, mode: 0o100646, isFile: true })).toBe(false)
    expect(confirmsAsRootFile({ uid: 0, mode: 0o100644, isFile: false })).toBe(false)
  })

  describe('reading the file for real', () => {
    let dir: string | null = null
    afterEach(() => {
      if (dir !== null) rmSync(dir, { recursive: true, force: true })
      dir = null
    })

    it('reads a root-owned file (/etc/hosts stands in: root, 0644 and small on Linux and macOS)', () => {
      expect(readRootOwnedPub('/etc/hosts')).not.toBeNull()
    })

    it('refuses a file of this user, a link to a root-owned file, a folder, and a missing path', () => {
      if (process.getuid?.() === 0) return // as root, an own file IS root-owned; the rule is covered above
      dir = mkdtempSync(join(tmpdir(), 'hostkey-pub-'))
      const own = join(dir, 'own.pub')
      writeFileSync(own, KEY + ' me@here\n', { mode: 0o644 })
      symlinkSync('/etc/hosts', join(dir, 'link.pub'))
      mkdirSync(join(dir, 'folder.pub'))
      expect(readRootOwnedPub(own)).toBeNull()
      expect(readRootOwnedPub(join(dir, 'link.pub'))).toBeNull()
      expect(readRootOwnedPub(join(dir, 'folder.pub'))).toBeNull()
      expect(readRootOwnedPub(join(dir, 'missing.pub'))).toBeNull()
    })
  })

  it('the key of a .pub: with or without a comment and a line end; nothing else', () => {
    expect(keyOfPub(KEY + ' root@host\n')).toBe(KEY)
    expect(keyOfPub(KEY + '\n')).toBe(KEY)
    expect(keyOfPub(KEY)).toBe(KEY)
    expect(keyOfPub('ssh-rsa ' + B64 + '\n')).toBeNull()
    expect(keyOfPub(B64)).toBeNull()
    expect(keyOfPub('')).toBeNull()
  })

  it('the candidates: the .pub of every absolute hostkey path, then the ed25519 default, without repeats', () => {
    expect(DEFAULT_ED25519_HOST_KEY_PUB).toBe('/etc/ssh/ssh_host_ed25519_key.pub')
    expect(hostKeyPubCandidates([])).toEqual(['/etc/ssh/ssh_host_ed25519_key.pub'])
    expect(hostKeyPubCandidates(['/etc/ssh/ssh_host_rsa_key', '/etc/ssh/ssh_host_ed25519_key', 'relative/key', '/srv/k'])).toEqual([
      '/etc/ssh/ssh_host_rsa_key.pub',
      '/etc/ssh/ssh_host_ed25519_key.pub',
      '/srv/k.pub',
    ])
  })

  it('ok: the key on the wire is the key of the default root-owned .pub', async () => {
    const s = scanning('127.0.0.1 ' + KEY + '\n')
    expect(await readOwnHostKey(SSHD, { run: s.run, readRootPub: s.reader({ [DEFAULT_ED25519_HOST_KEY_PUB]: KEY + ' root@mac\n' }) })).toEqual({ kind: 'ok', key: KEY })
  })

  it('ok: confirmed by the .pub of a configured hostkey path', async () => {
    const s = scanning('[127.0.0.1]:2222 ' + KEY + '\n')
    const sshd = { listenPorts: [2222], hostKeyFiles: ['/srv/ssh/host_ed25519'] }
    expect(await readOwnHostKey(sshd, { run: s.run, readRootPub: s.reader({ '/srv/ssh/host_ed25519.pub': KEY + '\n' }) })).toEqual({ kind: 'ok', key: KEY })
    expect(s.files[0]).toBe('/srv/ssh/host_ed25519.pub')
  })

  // The case the check is for: another process listens on the port and offers its own key.
  it('unverified: the key on the wire is not the key of any root-owned .pub (another listener on the port)', async () => {
    const s = scanning('127.0.0.1 ssh-ed25519 ' + B64_OTHER + '\n')
    const sshd = { listenPorts: [22], hostKeyFiles: ['/etc/ssh/ssh_host_ed25519_key'] }
    expect(await readOwnHostKey(sshd, { run: s.run, readRootPub: s.reader({ [DEFAULT_ED25519_HOST_KEY_PUB]: KEY + ' root@mac\n' }) })).toEqual({ kind: 'unverified' })
  })

  it('unverified: no candidate can be read as a root-owned file, or one throws', async () => {
    const s = scanning('127.0.0.1 ' + KEY + '\n')
    expect(await readOwnHostKey(SSHD, { run: s.run, readRootPub: s.reader({}) })).toEqual({ kind: 'unverified' })
    const throwing = (): string | null => {
      throw new Error('EACCES')
    }
    expect(await readOwnHostKey(SSHD, { run: s.run, readRootPub: throwing })).toEqual({ kind: 'unverified' })
  })

  it('missing: no key on the wire; then no file is read', async () => {
    const s = scanning('', 1)
    expect(await readOwnHostKey(SSHD, { run: s.run, readRootPub: s.reader({ [DEFAULT_ED25519_HOST_KEY_PUB]: KEY + '\n' }) })).toEqual({ kind: 'missing' })
    expect(s.files).toEqual([])
  })

  it('asks ssh-keyscan on the first listen port', async () => {
    const args: (readonly string[])[] = []
    const run = async (_f: string, a: readonly string[]): Promise<ProgramResult> => {
      args.push(a)
      return { code: 0, stdout: '[127.0.0.1]:2200 ' + KEY + '\n', stderr: '' }
    }
    await readOwnHostKey({ listenPorts: [2200, 2222], hostKeyFiles: [] }, { run, readRootPub: () => KEY + '\n' })
    expect(args).toEqual([['-T', '5', '-t', 'ed25519', '-p', '2200', '127.0.0.1']])
  })
})

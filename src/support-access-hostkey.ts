// Support access: this machine's SSH host key, told to marveen.io (SUPPORTKULCS1109;
// Mira's frozen schema support-hostkey-v1, Samu 79773: the key comes from ssh-keyscan).
//
// The fleet host connects to this machine with ONE pinned host key and strict
// checking; the key it pins is the one this file sends. So the key is the one
// sshd really offers on the wire, asked from sshd itself with ssh-keyscan,
// not read from a path: a non-root `sshd -T` names only the probe's throwaway
// key (it passes `-h`), and the built-in default paths it does not print at all
// (measured on OpenSSH 10.2p1, 2026-11-16). HostKey cannot be set under a Match
// block, so every address gives the same key; 127.0.0.1 is asked, on the port
// the probe confirmed.
//
// - ssh-keyscan runs by absolute path, without a shell, with `-t ed25519` and a
//   short time limit. Its answer counts only with exit code 0 and EXACTLY ONE
//   line of the exact shape below; "#" lines are skipped; zero lines, two lines,
//   or any other line is no key (host_key_missing at enable).
// - THE CROSS-CHECK (Dani 79778, Samu 79780): ssh-keyscan reports whatever
//   process listens on that port, and on macOS a port below 1024 is not
//   reserved for root: while sshd does not listen there, any process can. So
//   the key counts only when it is byte for byte the key of a root-owned .pub
//   file: the .pub of a `hostkey` line of the probe's answer (its throwaway key
//   left out), or the ed25519 default. The file is checked on the open file
//   itself: no link followed, a plain file, owner root, not writable by group
//   or others. No match, or no such file: host_key_unverified, fail-closed.
//   The file only confirms; the key itself is the one on the wire.
// - The exact shape (the schema, checked byte for byte by the server too):
//   "ssh-ed25519 " + 68 base64 characters (51 bytes need no padding): the
//   type string "ssh-ed25519" with its length, then 32 bytes of key.
// - The send: POST /support/v1/host-key {"host_key":"..."} with the status
//   token as bearer, the redeem's transport (fixed https origin, certificate
//   verified, no redirect). Only the status code counts: 200 is stored, every
//   other answer (and a network error) is "not stored", and enable goes on; the
//   daily reconcile sends it again. Logs carry the SHA256 fingerprint, never the key.
import { createHash } from 'node:crypto'
import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs'
import { SUPPORT_SERVICE_ORIGIN, type RedeemTransport } from './support-access-redeem.js'
import type { ProgramResult } from './support-access-sshd-run.js'

/** The ed25519 host key sshd uses when the configuration names none (OpenSSH's default, here the confirming file). */
export const DEFAULT_ED25519_HOST_KEY_PUB = '/etc/ssh/ssh_host_ed25519_key.pub'
/** A .pub file is a line of under 200 bytes; anything larger is not read. */
export const HOST_KEY_PUB_MAX_BYTES = 4096

export const SSH_KEYSCAN_PROGRAM = '/usr/bin/ssh-keyscan'
/** ssh-keyscan's own time limit (-T, seconds); the run gets a little more before it is killed. */
export const SUPPORT_HOST_KEY_SCAN_TIMEOUT_S = 5
export const SUPPORT_HOST_KEY_SCAN_RUN_MS = 7_000
/** The address asked: the key does not depend on it (HostKey is not a Match keyword). */
export const SUPPORT_HOST_KEY_SCAN_ADDRESS = '127.0.0.1'
export const SUPPORT_HOST_KEY_PATH = '/support/v1/host-key'
export const SUPPORT_HOST_KEY_TIMEOUT_MS = 10_000
export const SUPPORT_HOST_KEY_MAX_BODY_BYTES = 2048

const ED25519_TYPE = 'ssh-ed25519'
const ED25519_LINE = /^ssh-ed25519 ([A-Za-z0-9+/]{68})$/

/**
 * The key as the schema wants it, "ssh-ed25519 <68 base64 chars>", or null
 * for anything else: another type, a comment, white space, a blob that does
 * not decode to the type string and 32 bytes.
 */
export function ed25519HostKey(text: string): string | null {
  const m = ED25519_LINE.exec(text)
  if (m === null) return null
  // 68 characters of the base64 alphabet are always exactly 51 bytes, with no spare bits.
  const blob = Buffer.from(m[1], 'base64')
  if (blob.readUInt32BE(0) !== ED25519_TYPE.length || blob.subarray(4, 15).toString('latin1') !== ED25519_TYPE) return null
  if (blob.readUInt32BE(15) !== 32) return null
  return text
}

/** The OpenSSH fingerprint of a key that ed25519HostKey accepted: "SHA256:" and the unpadded base64 digest. */
export function hostKeyFingerprint(hostKey: string): string {
  const blob = Buffer.from(hostKey.slice(ED25519_TYPE.length + 1), 'base64')
  return 'SHA256:' + createHash('sha256').update(blob).digest('base64').replace(/=+$/, '')
}

/**
 * The one ed25519 key in an ssh-keyscan answer, or null. A line is
 * "<host> ssh-ed25519 <base64>"; the host field is not looked at beyond
 * being there. Exactly one key line, nothing else but "#" lines and empty ones.
 */
export function hostKeyFromKeyscan(stdout: string): string | null {
  let found: string | null = null
  for (const line of stdout.split('\n')) {
    if (line === '' || line.startsWith('#')) continue
    const fields = line.split(' ')
    if (fields.length !== 3 || fields[0] === '') return null
    const key = ed25519HostKey(fields[1] + ' ' + fields[2])
    if (key === null || found !== null) return null
    found = key
  }
  return found
}

/** Ask the local sshd for the ed25519 key it offers on `port`. Never rejects: any failure is null. */
export async function scanOwnHostKey(
  port: number,
  run: (file: string, args: readonly string[], timeoutMs: number) => Promise<ProgramResult>,
): Promise<string | null> {
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null
  try {
    const out = await run(
      SSH_KEYSCAN_PROGRAM,
      ['-T', String(SUPPORT_HOST_KEY_SCAN_TIMEOUT_S), '-t', 'ed25519', '-p', String(port), SUPPORT_HOST_KEY_SCAN_ADDRESS],
      SUPPORT_HOST_KEY_SCAN_RUN_MS,
    )
    return out.code === 0 ? hostKeyFromKeyscan(out.stdout) : null
  } catch {
    return null
  }
}

/** May a file with this owner and mode confirm a host key? Owner root, a plain file, no write bit for group or others. */
export function confirmsAsRootFile(st: { readonly uid: number; readonly mode: number; readonly isFile: boolean }): boolean {
  return st.isFile && st.uid === 0 && (st.mode & 0o022) === 0
}

/** The text of a root-owned .pub file (confirmsAsRootFile), read without following a link; null for anything else. */
export function readRootOwnedPub(path: string): string | null {
  let fd: number
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  } catch {
    return null
  }
  try {
    const st = fstatSync(fd)
    if (!confirmsAsRootFile({ uid: st.uid, mode: st.mode, isFile: st.isFile() })) return null
    const buf = Buffer.alloc(HOST_KEY_PUB_MAX_BYTES + 1)
    let n = 0
    for (;;) {
      const got = readSync(fd, buf, n, buf.length - n, n)
      if (got === 0) break
      n += got
      if (n > HOST_KEY_PUB_MAX_BYTES) return null
    }
    return buf.subarray(0, n).toString('latin1')
  } catch {
    return null
  } finally {
    closeSync(fd)
  }
}

/** The key of a .pub file's text ("ssh-ed25519 <base64>", a comment and a line end allowed), or null. */
export function keyOfPub(text: string): string | null {
  const fields = text.replace(/\n$/, '').split(' ')
  return fields.length < 2 ? null : ed25519HostKey(fields[0] + ' ' + fields[1])
}

/**
 * The files that may confirm the key: the .pub of every absolute `hostkey`
 * path of the probe's answer, then the ed25519 default; without repeats.
 */
export function hostKeyPubCandidates(hostKeyFiles: readonly string[]): string[] {
  const out = hostKeyFiles.filter((p) => p.startsWith('/')).map((p) => p + '.pub')
  out.push(DEFAULT_ED25519_HOST_KEY_PUB)
  return [...new Set(out)]
}

export type OwnHostKey =
  | { readonly kind: 'ok'; readonly key: string }
  /** ssh-keyscan gave no key, or not exactly one of the right shape. */
  | { readonly kind: 'missing' }
  /** It gave one, and no root-owned .pub file has it. */
  | { readonly kind: 'unverified' }

/**
 * The host key to send: the one sshd offers on `port` (scanOwnHostKey),
 * confirmed by a root-owned .pub file. Never rejects.
 */
export async function readOwnHostKey(
  sshd: { readonly listenPorts: readonly number[]; readonly hostKeyFiles: readonly string[] },
  deps: {
    readonly run: (file: string, args: readonly string[], timeoutMs: number) => Promise<ProgramResult>
    readonly readRootPub: (path: string) => string | null
  },
): Promise<OwnHostKey> {
  const key = await scanOwnHostKey(sshd.listenPorts[0], deps.run)
  if (key === null) return { kind: 'missing' }
  for (const path of hostKeyPubCandidates(sshd.hostKeyFiles)) {
    let text: string | null
    try {
      text = deps.readRootPub(path)
    } catch {
      text = null
    }
    if (text !== null && keyOfPub(text) === key) return { kind: 'ok', key }
  }
  return { kind: 'unverified' }
}

export type HostKeySendResult = 'stored' | 'not_stored'

/** Send the key once with the status token. Only HTTP 200 is "stored". Never rejects. */
export async function sendSupportHostKey(
  input: { readonly token: string; readonly hostKey: string },
  transport: RedeemTransport,
): Promise<HostKeySendResult> {
  try {
    const res = await transport({
      origin: SUPPORT_SERVICE_ORIGIN,
      path: SUPPORT_HOST_KEY_PATH,
      body: JSON.stringify({ host_key: input.hostKey }),
      timeoutMs: SUPPORT_HOST_KEY_TIMEOUT_MS,
      maxBodyBytes: SUPPORT_HOST_KEY_MAX_BODY_BYTES,
      bearer: input.token,
    })
    return res.status === 200 ? 'stored' : 'not_stored'
  } catch {
    return 'not_stored'
  }
}

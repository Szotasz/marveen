// TEST ONLY. Syntactically valid sk-ssh-ed25519 PUBLIC blobs built from fixed
// bytes. No private half exists for any of them and none is a real security
// key. They must never appear in SUPPORT_KEYS (support-access-pins.test.ts
// asserts exactly that).
import { fingerprintOfBlob, type SupportKeyPin } from '../../support-access-pins.js'

function str(bytes: Buffer): Buffer {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(bytes.length, 0)
  return Buffer.concat([len, bytes])
}

/** Build an sk-ssh-ed25519 public blob from arbitrary parts (also used to build MALFORMED ones). */
export function skBlob(
  parts: { type?: string; key?: Buffer; application?: string | null; trailing?: Buffer } = {},
): string {
  const type = parts.type ?? 'sk-ssh-ed25519@openssh.com'
  const key = parts.key ?? Buffer.from(Array.from({ length: 32 }, (_, i) => i + 1))
  const fields = [str(Buffer.from(type, 'latin1')), str(key)]
  if (parts.application !== null) fields.push(str(Buffer.from(parts.application ?? 'ssh:marveen-support-test', 'latin1')))
  if (parts.trailing) fields.push(parts.trailing)
  return Buffer.concat(fields).toString('base64')
}

/** TEST ONLY key 1: key bytes 1..32. `ssh-keygen -l` (OpenSSH 10.2) prints the fingerprint below for this blob. */
export const TEST_ONLY_BLOB_1 = skBlob()
export const TEST_ONLY_FINGERPRINT_1 = 'SHA256:LlwUFMfX2vt8uypcnNiigyXCVRNn7AQcmKfB/6k7/S0'

/** TEST ONLY key 2: key bytes all 0x42. */
export const TEST_ONLY_BLOB_2 = skBlob({ key: Buffer.alloc(32, 0x42) })

export const TEST_ONLY_KEYS: readonly SupportKeyPin[] = [
  { name: 'key1', pub: TEST_ONLY_BLOB_1, fingerprint: TEST_ONLY_FINGERPRINT_1 },
  { name: 'key2', pub: TEST_ONLY_BLOB_2, fingerprint: fingerprintOfBlob(TEST_ONLY_BLOB_2) },
]

/** Documentation address ranges only (RFC 5737, RFC 3849). */
export const TEST_ONLY_FROM = ['203.0.113.7/32'] as const
export const TEST_ONLY_FROM_V6 = '2001:db8::7/128'

export const TEST_ONLY_BLOBS: ReadonlySet<string> = new Set(TEST_ONLY_KEYS.map((k) => k.pub))

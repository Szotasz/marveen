// Password hashing for the optional dashboard browser login.
//
// v1 algorithm: node:crypto scrypt in PHC string format. Chosen because it is
// zero-dependency, memory-hard, and behaves identically under node and Bun (the
// dashboard ships as dist/index.js and may be launched by either runtime). The
// verifier is prefix-dispatched so an argon2id hash (minted only under a Bun
// runtime via Bun.password) can be added later as a purely additive path with
// no migration of existing scrypt hashes.
//
// PHC string: $scrypt$ln=<log2N>,r=<r>,p=<p>$<b64salt>$<b64key>
// Params: N=2^16 (65536), r=8, p=1 => ~64 MiB work factor; keyLen 32; salt 16B.
// scrypt is always ASYNC here (never the *Sync variant): this is a single
// process HTTP server and a synchronous 64 MiB KDF would stall every other
// request for the duration of the hash.

import { scrypt as scryptCb, randomBytes, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'
import { logger } from '../logger.js'

const scrypt = promisify(scryptCb) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>

const SCRYPT_LN = 16 // log2(N)
const SCRYPT_N = 2 ** SCRYPT_LN
const SCRYPT_R = 8
const SCRYPT_P = 1
const KEY_LEN = 32
const SALT_LEN = 16
// N=2^16, r=8 needs ~128*N*r ~= 67 MiB; node's default maxmem (32 MiB) throws,
// so an explicit, comfortably larger ceiling is mandatory.
const MAXMEM = 128 * 1024 * 1024

export const MIN_PASSWORD_LENGTH = 10
export const MAX_PASSWORD_LENGTH = 128

export class PasswordPolicyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PasswordPolicyError'
  }
}

// Length-only policy (10..128). No composition rules: for a throttled,
// loopback-fronted single-operator login, a length floor is the meaningful
// control and composition rules mostly push users toward weaker, patterned
// passwords.
export function assertPasswordPolicy(pw: unknown): asserts pw is string {
  if (typeof pw !== 'string') throw new PasswordPolicyError('Password must be a string')
  if (pw.length < MIN_PASSWORD_LENGTH) {
    throw new PasswordPolicyError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`)
  }
  if (pw.length > MAX_PASSWORD_LENGTH) {
    throw new PasswordPolicyError(`Password must be at most ${MAX_PASSWORD_LENGTH} characters`)
  }
}

export async function hashPassword(pw: string): Promise<string> {
  assertPasswordPolicy(pw)
  const salt = randomBytes(SALT_LEN)
  const key = await scrypt(pw, salt, KEY_LEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: MAXMEM })
  return `$scrypt$ln=${SCRYPT_LN},r=${SCRYPT_R},p=${SCRYPT_P}$${salt.toString('base64')}$${key.toString('base64')}`
}

interface ScryptParams { ln: number; r: number; p: number }

// Parse the "ln=16,r=8,p=1" segment strictly. Any missing/duplicate/out-of-range
// field returns null so a malformed hash verifies as false rather than throwing.
function parseScryptParams(segment: string): ScryptParams | null {
  const out: Partial<ScryptParams> = {}
  for (const kv of segment.split(',')) {
    const [k, v] = kv.split('=')
    const n = Number(v)
    if (!Number.isInteger(n) || n <= 0) return null
    if (k === 'ln') out.ln = n
    else if (k === 'r') out.r = n
    else if (k === 'p') out.p = n
    else return null
  }
  if (out.ln === undefined || out.r === undefined || out.p === undefined) return null
  // Bound ln so a hostile stored hash can't request an absurd N and OOM/hang.
  if (out.ln < 1 || out.ln > 20) return null
  return out as ScryptParams
}

async function verifyScrypt(pw: string, phc: string): Promise<boolean> {
  // $scrypt$ln=16,r=8,p=1$<b64salt>$<b64key> -> ['', 'scrypt', params, salt, key]
  const parts = phc.split('$')
  if (parts.length !== 5 || parts[1] !== 'scrypt') return false
  const params = parseScryptParams(parts[2])
  if (!params) return false
  let salt: Buffer
  let expected: Buffer
  try {
    salt = Buffer.from(parts[3], 'base64')
    expected = Buffer.from(parts[4], 'base64')
  } catch {
    return false
  }
  if (salt.length === 0 || expected.length === 0) return false
  let derived: Buffer
  try {
    // Recompute with the STORED params (2^ln, r, p), not the current defaults --
    // otherwise a params change would invalidate every existing hash.
    derived = await scrypt(pw, salt, expected.length, { N: 2 ** params.ln, r: params.r, p: params.p, maxmem: MAXMEM })
  } catch {
    return false
  }
  if (derived.length !== expected.length) return false
  return timingSafeEqual(derived, expected)
}

export async function verifyPassword(pw: string, phc: string): Promise<boolean> {
  if (typeof pw !== 'string' || typeof phc !== 'string' || phc.length === 0) return false
  if (phc.startsWith('$scrypt$')) return verifyScrypt(pw, phc)
  if (phc.startsWith('$argon2')) {
    // Additive upgrade path: argon2id hashes are only mintable/verifiable under
    // a Bun runtime (Bun.password). Under node there is no core argon2, so such
    // a hash is unverifiable here -- fail closed and tell the operator how to
    // recover rather than throwing.
    const g = globalThis as unknown as { Bun?: { password?: { verify?: (pw: string, hash: string) => Promise<boolean> } } }
    if (typeof g.Bun !== 'undefined' && g.Bun.password?.verify) {
      try {
        return await g.Bun.password.verify(pw, phc)
      } catch {
        return false
      }
    }
    logger.warn('argon2 password hash requires the Bun runtime; reset the password via the dashboard-user CLI')
    return false
  }
  return false
}

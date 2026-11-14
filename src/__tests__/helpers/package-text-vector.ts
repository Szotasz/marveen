// The shared package text vector (MIOAGENTINSTALL1114, plan 10.1), copied from
// marveen-io (supabase/functions/_shared/package-text-vector.json, PR 371 head
// ba64679c). Swapping in the next vector is ONE edit here: the file name and
// its sha256 below. The test pins the copy to this hash, so a changed file
// without a changed hash is red.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const PACKAGE_TEXT_VECTOR_FILE = 'package-text-vector.json'
export const PACKAGE_TEXT_VECTOR_SHA256 = 'fbfb67a336f685c7e49b31cb400c553f093b77a72027ae963d01a619eed0c810'

export interface TextVectorCase {
  name: string
  stage: string | string[]
  path: string
  bytes_b64: string
  note?: string
  expect:
    | { ok: true }
    | { reason: string; findings: Array<{ rule: string; line: number; key?: string }> }
}

export interface TextVector {
  schema: number
  profile: string
  cases: TextVectorCase[]
}

const HERE = dirname(fileURLToPath(import.meta.url))

export function textVectorBytes(): Buffer {
  return readFileSync(join(HERE, '..', 'fixtures', PACKAGE_TEXT_VECTOR_FILE))
}

export function loadTextVector(): TextVector {
  return JSON.parse(textVectorBytes().toString('utf8')) as TextVector
}

/** The install side runs every case whose stage is, or lists, `install`. */
export function isInstallCase(c: TextVectorCase): boolean {
  return Array.isArray(c.stage) ? c.stage.includes('install') : c.stage === 'install'
}

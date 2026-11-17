// The shared package text vector (MIOAGENTINSTALL1114, plan 10.1), copied from
// marveen-io (supabase/functions/_shared/package-text-vector.json, PR 372 head
// ae6c3dac). Swapping in the next vector is ONE edit here: the file name and
// its sha256 below. The test pins the copy to this hash, so a changed file
// without a changed hash is red.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const PACKAGE_TEXT_VECTOR_FILE = 'package-text-vector.json'
export const PACKAGE_TEXT_VECTOR_SHA256 = '2e5278dbc809ccf1601a292558828911578997713c93418936b90d29e7a4121d'

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

/**
 * A manifest free-text case (schema 1, added by the publishing side's PR 372): one field, its text as the bytes of
 * a JSON string LITERAL (so a lone surrogate can travel as an escape), and the first rule that refuses it.
 */
export interface ManifestTextCase {
  name: string
  stage: string | string[]
  field: 'title' | 'description' | 'agent.display_name' | 'connectors[].reason'
  text_json_b64: string
  note?: string
  expect: { ok: true } | { reason: string; rule: string }
}

export interface TextVector {
  schema: number
  profile: string
  cases: TextVectorCase[]
  /** Absent in vectors before PR 372. */
  manifest_cases?: ManifestTextCase[]
}

const HERE = dirname(fileURLToPath(import.meta.url))

export function textVectorBytes(): Buffer {
  return readFileSync(join(HERE, '..', 'fixtures', PACKAGE_TEXT_VECTOR_FILE))
}

export function loadTextVector(): TextVector {
  return JSON.parse(textVectorBytes().toString('utf8')) as TextVector
}

/** The install side runs every case whose stage is, or lists, `install`. */
export function isInstallCase(c: { stage: string | string[] }): boolean {
  return Array.isArray(c.stage) ? c.stage.includes('install') : c.stage === 'install'
}

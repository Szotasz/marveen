// The shared package PUBLISH vector (MIOAGENTPUBVEC1122), copied byte for byte from
// marveen-io (supabase/functions/_shared/package-publish-vector.json, merge
// commit 3ee7459f8f of PR 389). The publisher runs its "upload" cases, the
// installer its "install" cases. Swapping in the next vector is ONE edit here:
// the file name and its sha256 below (the publisher's test pins the same hash).
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const PACKAGE_PUBLISH_VECTOR_FILE = 'package-publish-vector.json'
export const PACKAGE_PUBLISH_VECTOR_SHA256 = 'f6488f8bbad2c71d133c7d2f445c8581c6486b982280b1b69e9c1311be95abeb'

/** An avatar or a cover image; the expectation is the publisher's rule name, which is the installer's for S20. */
export interface PublishImageCase {
  name: string
  stage: string[]
  kind: 'avatar' | 'cover'
  bytes_b64: string
  note: string
  expect: { ok: true } | { rule: string }
}

/** The author's manifest.json as bytes; a refusal names its reason, the rule (if any) and the field. */
export interface PublishManifestCase {
  name: string
  stage: string[]
  bytes_b64: string
  note: string
  expect: { ok: true } | { refusals: Array<{ reason: string; rule?: string; field: string }> }
}

export interface PublishVector {
  schema: number
  about: string
  image_cases: PublishImageCase[]
  manifest_cases: PublishManifestCase[]
}

const HERE = dirname(fileURLToPath(import.meta.url))

export function publishVectorBytes(): Buffer {
  return readFileSync(join(HERE, '..', 'fixtures', PACKAGE_PUBLISH_VECTOR_FILE))
}

export function loadPublishVector(): PublishVector {
  return JSON.parse(publishVectorBytes().toString('utf8')) as PublishVector
}

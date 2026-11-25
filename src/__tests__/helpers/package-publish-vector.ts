// The shared package PUBLISH vector (MIOAGENTPUBVEC1122), copied byte for byte from
// marveen-io (supabase/functions/_shared/package-publish-vector.json, squash
// commit 44af4f7 of PR 390, PR-3b). The publisher runs its "upload" cases, the
// installer its "install" cases. Swapping in the next vector is ONE edit here:
// the file name and its sha256 below (the publisher's test pins the same hash).
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const PACKAGE_PUBLISH_VECTOR_FILE = 'package-publish-vector.json'
export const PACKAGE_PUBLISH_VECTOR_SHA256 = 'd8aaf5d4427338d3b7436e97ec2f3b9ea91fff8d45755abd61fcb3a913401ab3'

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

// Reads the quota snapshot scripts/usage-collect.py writes to
// store/usage-latest.json and hands it to the pure gate in quota-gate.ts.
//
// Everything here degrades to null: a missing file, a half-written file, a
// shape we do not recognise. Null means "we do not know", and the gate treats
// not-knowing as permission to run (see quota-gate.ts, FAIL OPEN).

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { STORE_DIR } from './config.js'
import type { QuotaSnapshot } from './quota-gate.js'

export const USAGE_SNAPSHOT_PATH = join(STORE_DIR, 'usage-latest.json')

/**
 * Map the collector's on-disk JSON onto the gate's input shape.
 * Exported separately from the file read so the mapping is unit-testable.
 */
export function parseQuotaSnapshot(raw: unknown): QuotaSnapshot | null {
  if (!raw || typeof raw !== 'object') return null
  const root = raw as Record<string, unknown>
  const claude = root.claude
  if (!claude || typeof claude !== 'object') return null
  const c = claude as Record<string, unknown>

  // generated_at is an ISO-8601 string on disk; the gate wants epoch ms.
  let generatedAtMs: number | null = null
  if (typeof root.generated_at === 'string') {
    const parsed = Date.parse(root.generated_at)
    if (!Number.isNaN(parsed)) generatedAtMs = parsed
  }

  const windows = c.windows && typeof c.windows === 'object'
    ? (c.windows as QuotaSnapshot['windows'])
    : null

  return {
    source: typeof c.source === 'string' ? c.source : null,
    generatedAtMs,
    windows,
  }
}

export function readQuotaSnapshot(path: string = USAGE_SNAPSHOT_PATH): QuotaSnapshot | null {
  try {
    return parseQuotaSnapshot(JSON.parse(readFileSync(path, 'utf-8')))
  } catch {
    return null
  }
}

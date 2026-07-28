// Security-section endpoints (AUTHPLAN1 #2): Bridge pairing from the UI.
//
// POST /api/security/bridge-enroll takes a pasted public-key line + device
// name and returns the connection bundle. Everything heavy is delegated to
// bridge-enroll.ts (which reuses the remote-access-enroll CLI's core); this
// module owns the HTTP concerns: the credential-kind allowlist, input
// validation, the audit row and the operator notification.
//
// Principal discipline (same as routes/auth.ts): enrollment GRANTS access
// (SSH tunnel + a fresh device key), so it is allowlisted to token+session.
// A device key must never enroll further devices -- one leaked Bridge would
// otherwise become unlimited Bridges.

import { readBody, json } from '../http-helpers.js'
import { logger } from '../../logger.js'
import { logConfigChange } from '../../db.js'
import { notifySecurityEvent } from '../../notify.js'
import { bridgeEnroll, sshDirOverride, RemoteEnrollError } from '../bridge-enroll.js'
import type { RouteContext } from './types.js'

const BODY_MAX_BYTES = 8 * 1024
const NAME_RE = /^[\p{L}\p{N} ._-]{1,64}$/u
const ENROLL_KINDS = ['token', 'session'] as const

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

export async function tryHandleSecurity(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method, auth } = ctx

  if (path !== '/api/security/bridge-enroll' || method !== 'POST') return false

  if (auth === undefined || !ENROLL_KINDS.includes(auth.kind as (typeof ENROLL_KINDS)[number])) {
    json(res, { error: 'Forbidden for this credential type' }, 403)
    return true
  }

  let body: Record<string, unknown>
  try {
    const raw = (await readBody(req, { maxBytes: BODY_MAX_BYTES })).toString().trim()
    const parsed = raw ? JSON.parse(raw) : {}
    body = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
  } catch {
    json(res, { error: 'Invalid JSON' }, 400)
    return true
  }

  const keyLine = str(body.key_line).trim()
  const name = str(body.name).trim()
  if (!keyLine) {
    json(res, { error: 'key_line is required (the ssh-ed25519 ... marveen-remote:<uuid> line shown by the Bridge)' }, 400)
    return true
  }
  if (!NAME_RE.test(name)) {
    json(res, { error: 'Invalid device name (1-64 chars: letters, digits, space, . _ -)' }, 400)
    return true
  }
  const host = str(body.host).trim() || undefined
  let sshPort: number | undefined
  if (body.ssh_port !== undefined && body.ssh_port !== null && body.ssh_port !== '') {
    const n = Number(body.ssh_port)
    if (!Number.isInteger(n) || n < 1 || n > 65535) {
      json(res, { error: 'Invalid ssh_port (1-65535)' }, 400)
      return true
    }
    sshPort = n
  }

  try {
    const outcome = await bridgeEnroll({ keyLine, name, host, sshPort })
    // Metadata only into the trail -- never the bundle or key material. An
    // active MARVEEN_SSH_DIR override (test seam) is flagged so an incident
    // where pairing "succeeded but does not work" is explainable from the
    // audit row alone.
    const overrideNote = sshDirOverride() ? ' sshdir_override=1' : ''
    logConfigChange('security.bridge_enroll', null, `${name} (${outcome.installId}) ${outcome.action}${overrideNote}`, auth.kind)
    logger.info({ name, installId: outcome.installId, action: outcome.action, deviceKeyId: outcome.deviceKeyId }, 'bridge device enrolled')
    void notifySecurityEvent(
      `🔗 Bridge-párosítás a dashboardról: "${name}" (${outcome.action === 'replaced' ? 'újrapárosítás' : 'új eszköz'}). ` +
        'Az eszköz SSH-alagút + saját eszközkulcs hozzáférést kapott. Ha nem te voltál, vond vissza a Biztonság fülön.',
    )
    json(res, {
      ok: true,
      bundle: outcome.bundle,
      action: outcome.action,
      device_key_id: outcome.deviceKeyId,
      replaced_device_key: outcome.replacedDeviceKey,
      install_id: outcome.installId,
      host: outcome.host,
      host_key_source: outcome.hostKeySource,
      warnings: outcome.warnings,
    }, 201)
  } catch (err) {
    if (err instanceof RemoteEnrollError) {
      json(res, { error: err.message }, 400)
      return true
    }
    logger.error({ err }, 'bridge enroll failed')
    json(res, { error: 'Enrollment failed' }, 500)
  }
  return true
}

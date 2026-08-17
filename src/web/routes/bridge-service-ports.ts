// Bridge service-port allowlist endpoints (BRIDGEPORT817).
//
// The Bridge lets the owner open additional host loopback services on
// separate tabs, but the REAL boundary is the enrolled key's permitopen list
// in authorized_keys -- and that list is managed here, never client-side. The
// Bridge REQUESTS a desired port list; this route VALIDATES it (explicit
// ports only, never a wildcard, privileged ports refused, capped), rewrites
// the key's options field, writes the change to the config-change ledger and
// notifies the owner. A rule that only exists in the client is not a rule.
//
// Principal discipline:
//   - device key WITH install_id: self-scoped -- a Bridge can only manage the
//     permitopen set of ITS OWN enrolled key. This is the normal caller.
//   - dashboard token / session: owner tooling; must name the install_id
//     explicitly. A device key can never widen another device's grant.
//
// PUT is DECLARATIVE (the full desired list), not add/remove deltas: the
// permitopen set becomes {webPort} + exactly the validated list, so client
// and server can never drift apart entry-by-entry.
//
// The change applies to NEW ssh connections only (sshd evaluates
// authorized_keys options at auth time); the Bridge reconnects after a
// successful PUT. Narrowing therefore also requires the Bridge-side
// reconnect -- stated in the response so the caller cannot miss it.

import { readBody, json } from '../http-helpers.js'
import { logger } from '../../logger.js'
import { logConfigChange } from '../../db.js'
import { notifySecurityEvent } from '../../notify.js'
import { WEB_PORT } from '../../config.js'
import { validateBridgeServicePorts, extractServicePorts, COMMENT_PREFIX, ACCEPTED_KEY_TYPE } from '../../remote-enroll-core.js'
import { updateEnrolledServicePorts } from '../../remote-enroll-fs.js'
import { getDeviceKey } from '../auth-device-keys.js'
import { sshDirOverride } from '../bridge-enroll.js'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import type { RouteContext } from './types.js'

const BODY_MAX_BYTES = 8 * 1024
const PATH = '/api/bridge/service-ports'

function resolveSshDir(): string {
  const override = sshDirOverride()
  if (override) {
    logger.warn({ sshDir: override }, 'MARVEEN_SSH_DIR override active for service-port update (test seam; must be unset in production)')
    return override
  }
  return join(homedir(), '.ssh')
}

/** The caller's install scope, or null with the response already written. */
function resolveInstallId(ctx: RouteContext, explicit: string | undefined): string | null {
  const { res, auth } = ctx
  if (auth?.kind === 'device') {
    if (auth.deviceId === undefined) {
      json(res, { error: 'Device principal without id' }, 500)
      return null
    }
    const info = getDeviceKey(auth.deviceId)
    if (!info || !info.installId) {
      // Pre-per-device-key bundles (shared token) and non-bridge device keys
      // have no install binding; they cannot manage permitopen. Re-pairing
      // mints a bound key.
      json(res, { error: 'This device key is not bound to a Bridge enrollment. Re-pair the device.' }, 403)
      return null
    }
    if (explicit && explicit !== info.installId) {
      // Self-scope is not negotiable for device callers.
      json(res, { error: 'A device may only manage its own service ports' }, 403)
      return null
    }
    return info.installId
  }
  if (auth?.kind === 'token' || auth?.kind === 'session') {
    if (!explicit) {
      json(res, { error: 'install_id is required for token/session callers' }, 400)
      return null
    }
    return explicit
  }
  json(res, { error: 'Forbidden for this credential type' }, 403)
  return null
}

/** Current service ports straight from authorized_keys (the ground truth). */
function readCurrentPorts(installId: string): { found: boolean; ports: number[] } {
  try {
    const content = readFileSync(join(resolveSshDir(), 'authorized_keys'), 'utf8')
    const target = `${COMMENT_PREFIX}${installId}`
    for (const line of content.split('\n')) {
      const fields = line.trim().split(/\s+/)
      if (fields.length === 4 && fields[3] === target && fields[1] === ACCEPTED_KEY_TYPE) {
        return { found: true, ports: extractServicePorts(fields[0], WEB_PORT) }
      }
    }
  } catch {
    /* missing file = not enrolled */
  }
  return { found: false, ports: [] }
}

export async function tryHandleBridgeServicePorts(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method, url, auth } = ctx
  if (path !== PATH) return false

  if (method === 'GET') {
    const installId = resolveInstallId(ctx, url.searchParams.get('install_id') || undefined)
    if (installId === null) return true
    const current = readCurrentPorts(installId)
    if (!current.found) {
      json(res, { error: 'No enrollment found for this install id' }, 404)
      return true
    }
    json(res, { ok: true, install_id: installId, web_port: WEB_PORT, ports: current.ports })
    return true
  }

  if (method !== 'PUT') return false

  let body: Record<string, unknown>
  try {
    const raw = (await readBody(req, { maxBytes: BODY_MAX_BYTES })).toString().trim()
    const parsed = raw ? JSON.parse(raw) : {}
    body = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
  } catch {
    json(res, { error: 'Invalid JSON' }, 400)
    return true
  }

  const installId = resolveInstallId(ctx, typeof body.install_id === 'string' ? body.install_id : undefined)
  if (installId === null) return true

  // Accept [{name, port}] (the Bridge's shape -- names enrich the ledger) or
  // bare numbers. POLICY runs on the ports alone, server-side, always.
  const rawList = Array.isArray(body.ports) ? body.ports : null
  if (!rawList) {
    json(res, { error: 'ports must be an array' }, 400)
    return true
  }
  const portNumbers = rawList.map((e) =>
    typeof e === 'number' ? e : e && typeof e === 'object' ? (e as { port?: unknown }).port : undefined,
  )
  const verdict = validateBridgeServicePorts(portNumbers, WEB_PORT)
  if (!verdict.ok) {
    json(res, { error: verdict.error }, 400)
    return true
  }
  const names = new Map<number, string>()
  for (const e of rawList) {
    if (e && typeof e === 'object') {
      const { name, port } = e as { name?: unknown; port?: unknown }
      if (typeof name === 'string' && typeof port === 'number' && name.trim()) {
        names.set(port, name.trim().slice(0, 32))
      }
    }
  }

  try {
    const result = await updateEnrolledServicePorts({
      sshDir: resolveSshDir(),
      installId,
      webPort: WEB_PORT,
      ports: verdict.ports,
    })
    if (!result.found) {
      json(res, { error: 'No enrollment found for this install id' }, 404)
      return true
    }

    const label = (p: number) => (names.has(p) ? `${names.get(p)}:${p}` : String(p))
    const added = result.after.filter((p) => !result.before.includes(p))
    const removed = result.before.filter((p) => !result.after.includes(p))
    if (added.length || removed.length) {
      // Ledger row: who, what changed, from what to what. A quiet widening of
      // an SSH grant must be reconstructable from the trail alone.
      logConfigChange(
        'security.bridge_service_ports',
        `[${result.before.join(',')}]`,
        `[${result.after.map(label).join(',')}] (install ${installId})` +
          (added.length ? ` added=[${added.map(label).join(',')}]` : '') +
          (removed.length ? ` removed=[${removed.join(',')}]` : '') +
          (sshDirOverride() ? ' sshdir_override=1' : ''),
        auth!.kind,
      )
      logger.info({ installId, before: result.before, after: result.after, actor: auth!.kind }, 'bridge service ports updated')
      // Latency, said out loud -- and ONLY what the system can actually do:
      // sshd applies authorized_keys options at AUTH time, so neither a
      // narrowing nor a pairing revocation touches an already-established
      // session (removeBridgeSshAccess only deletes the line; nothing kills
      // the live tunnel). A device-initiated change is followed by the
      // Bridge's own reconnect; a dashboard/token-side narrowing is not.
      // This is a security notification the owner reads MID-INCIDENT: it
      // must not promise an immediate cut that does not exist. Killing the
      // live session on revoke would be real work, tracked separately.
      const narrowingLatency =
        removed.length && auth!.kind !== 'device'
          ? ' FIGYELEM: a szűkítés az eszköz KÖVETKEZŐ újrakapcsolódásakor lép életbe -- az élő kapcsolat addig a régi listát használja.'
          : ''
      void notifySecurityEvent(
        `🔌 Bridge port-lista változott (${auth!.kind === 'device' ? 'a Bridge-ből' : 'a dashboardról'}): ` +
          (added.length ? `+ ${added.map(label).join(', ')} ` : '') +
          (removed.length ? `- ${removed.join(', ')} ` : '') +
          `-- az eszköz SSH-kulcsa mostantól ezekre a helyi portokra forwardolhat. Ha nem te voltál, vond vissza a párosítást a Biztonság fülön -- ez minden TOVÁBBI kapcsolódást megakadályoz; a már élő kapcsolat a saját megszakadásáig él.` +
          narrowingLatency,
      )
    }

    json(res, {
      ok: true,
      install_id: installId,
      web_port: WEB_PORT,
      ports: result.after,
      // sshd applies authorized_keys options at AUTH time.
      reconnect_required: true,
    })
  } catch (err) {
    logger.error({ err, installId }, 'bridge service-port update failed')
    json(res, { error: 'Update failed' }, 500)
  }
  return true
}

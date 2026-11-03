// Server-side Bridge device-key issuance (BRIDGEINSTKEY1020).
//
// The remote installer pairs the Bridge it installs from on the server itself
// (remote-enroll), and later backfills the bundle's dashboard credential once
// the service is up. Both paths used to hand out the SHARED dashboard token:
// such a device is missing from the device-key list, so it cannot be revoked
// from the dashboard, and revoking it by hand still leaves the token valid.
//
// The dashboard's own pairing path never had that gap: it mints a per-device
// key bound to the marveen-remote:<uuid> install id. This module gives the
// server-side CLIs the same thing, through the SAME mint (mintBridgeDeviceKey),
// so a device is listed and revocable however it was paired.
//
// Pure decisions live here (testable without a CLI process); the scripts own
// argv, the real database and the real ~/.ssh.

import { dashboardTokenDecision, isInstallId, removeAuthorizedKey } from './remote-enroll-core.js'
import { DEVICE_NAME_RE, type MintedDeviceKey } from './web/auth-device-keys.js'

/** Marker lines around the raw key on stdout (the installer parses them). */
export const DEVICE_KEY_BEGIN = '----- BEGIN DEVICE KEY -----'
export const DEVICE_KEY_END = '----- END DEVICE KEY -----'

/** Where a bundle's dashboard credential comes from. */
export type BundleTokenMode = 'device' | 'shared' | 'none'

export type BundleTokenChoice =
  | { ok: true; source: 'device'; token: string; deviceKeyId: number; replaced: boolean }
  | { ok: true; source: 'shared'; token: string }
  | { ok: true; source: 'none' }
  | { ok: false; reason: string }

export interface BundleTokenDeps {
  /** The shared dashboard token (DASHBOARD_TOKEN env / store/.dashboard-token). */
  readSharedToken: () => string | null
  /** Mint this device's own key (mintBridgeDeviceKey for the parsed install id). */
  mintDeviceKey: () => { minted: MintedDeviceKey; replaced: boolean }
}

/**
 * Pick the credential a connection bundle carries.
 *
 * `device` never consults the shared token: falling back to it would hand out
 * exactly the unrevocable credential this mode exists to replace, and the
 * caller would not be able to tell. A mint failure is a failure.
 * `shared` keeps the pre-existing behavior (INSTNODE806: a missing token is a
 * hard failure, not a silent token-free bundle). `none` is the deliberate
 * token-free bundle of --no-dashboard-token.
 */
export function chooseBundleToken(mode: BundleTokenMode, deps: BundleTokenDeps): BundleTokenChoice {
  if (mode === 'device') {
    const { minted, replaced } = deps.mintDeviceKey()
    return { ok: true, source: 'device', token: minted.key, deviceKeyId: minted.id, replaced }
  }
  if (mode === 'none') return { ok: true, source: 'none' }
  const decision = dashboardTokenDecision(true, deps.readSharedToken())
  if ('ok' in decision) return { ok: false, reason: decision.reason }
  if (!decision.include) return { ok: true, source: 'none' }
  return { ok: true, source: 'shared', token: decision.token }
}

/**
 * Put the chosen credential into the bundle input: exactly the chosen token,
 * nothing else. Pure, and deliberately without access to the shared token --
 * a device choice can only ever carry the device key.
 */
export function withCredential<T extends { dashboardToken?: string }>(input: T, choice: BundleTokenChoice): T {
  const { dashboardToken: _drop, ...rest } = input
  if (choice.ok && (choice.source === 'device' || choice.source === 'shared')) {
    return { ...rest, dashboardToken: choice.token } as T
  }
  return rest as T
}

/** Default device-key name for an installer-paired Bridge. */
export function defaultDeviceName(installId: string): string {
  return `Bridge ${installId.slice(0, 8)}`
}

export type DeviceKeyRequest =
  | { ok: true; installId: string; name: string }
  | { ok: false; reason: string }

/**
 * Validate a standalone issuance request (`bridge-device-key`).
 *
 * The install id must belong to a device ENROLLED on this machine (its
 * restricted marveen-remote:<uuid> line is in authorized_keys). A key minted
 * for an id with no SSH line would be a dashboard credential no pairing
 * explains, and the dashboard's revoke (which drops both halves by id) would
 * have nothing to pair it with.
 */
export function checkDeviceKeyRequest(
  installId: string | undefined,
  name: string | undefined,
  authorizedKeys: string | null,
): DeviceKeyRequest {
  const id = (installId ?? '').trim()
  if (!isInstallId(id)) return { ok: false, reason: '--install-id must be a marveen-remote install id (uuid v4)' }
  const chosen = (name ?? '').trim() || defaultDeviceName(id)
  if (!DEVICE_NAME_RE.test(chosen)) {
    return { ok: false, reason: '--name must be 1-64 characters: letters, digits, space, . _ -' }
  }
  if (authorizedKeys === null || !removeAuthorizedKey(authorizedKeys, id).removed) {
    return {
      ok: false,
      reason: `no enrolled Bridge device marveen-remote:${id} in authorized_keys; pair it first (npm run remote-enroll)`,
    }
  }
  return { ok: true, installId: id, name: chosen }
}

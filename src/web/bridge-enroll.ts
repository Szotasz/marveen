// Bridge pairing from the dashboard (AUTHPLAN1 #2).
//
// Orchestrates one enrollment: validate the pasted public-key line, write the
// restricted authorized_keys entry (remote-enroll-core/fs -- the SAME logic
// the remote-access-enroll CLI uses, not a second implementation), mint a
// per-device dashboard key, and build the connection bundle.
//
// The NEW bundle embeds the freshly minted device key in the bundle's
// dashboardToken field instead of the shared dashboard token. The Bridge just
// presents it as a Bearer -- wire-compatible -- but revocation now means
// something: dropping THIS key cuts THIS device only. Old bundles carrying the
// shared token keep working unchanged (backward compatibility is not
// negotiable); they simply do not gain per-device revocation.
//
// Re-pairing the same device (same marveen-remote:<uuid>) REPLACES both sides:
// the authorized_keys line (merge-by-id, existing behavior) and the device key
// (the old row is revoked, a fresh key is minted) -- so a device never
// accumulates keys.
//
// ssh-keyscan runs ASYNC (execFile, not execFileSync): this code runs inside
// the dashboard's event loop, and a 5-15s blocking keyscan would freeze every
// request in flight.

import { readFileSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { homedir, hostname, userInfo, networkInterfaces } from 'node:os'
import { join } from 'node:path'
import { logger } from '../logger.js'
import {
  validatePublicKeyLine,
  buildRestrictedLine,
  buildBundle,
  encodeBundle,
  resolveHostKey,
  RemoteEnrollError,
} from '../remote-enroll-core.js'
import { enrollAuthorizedKey, removeEnrolledKey, type EnrollResult } from '../remote-enroll-fs.js'
import { createDeviceKey, findDeviceKeyByInstallId, revokeDeviceKey } from './auth-device-keys.js'

export { RemoteEnrollError }

export interface BridgeEnrollInput {
  /** The pasted `ssh-ed25519 <base64> marveen-remote:<uuid>` line. */
  keyLine: string
  /** Display name for the device key (shown in the device-key list). */
  name: string
  /** Optional host override; defaults to the primary non-loopback IPv4. */
  host?: string
  /** Optional SSH port override; defaults to 22. */
  sshPort?: number
}

export interface BridgeEnrollDeps {
  /** .ssh directory to write into. Injectable so tests and isolated e2e
   *  instances never touch the real ~/.ssh. */
  sshDir: string
  /** Async ssh-keyscan against loopback; resolves to stdout or null. */
  keyscan: () => Promise<string | null>
  /** File reader for the host-key candidate paths. */
  readFile: (path: string) => string | null
}

export interface BridgeEnrollOutcome {
  action: EnrollResult['action']
  warnings: string[]
  installId: string
  deviceKeyId: number
  /** True when a previous key for the same installId was revoked (re-pair). */
  replacedDeviceKey: boolean
  host: string
  hostKeySource: string
  /** The encoded connection bundle -- contains the raw device key, disclosed
   *  exactly once here. */
  bundle: string
}

/** MARVEEN_SSH_DIR is a test seam for isolated e2e instances (a scratch
 * server must never write the real ~/.ssh). It lives in a production code
 * path, so if it ever leaks into a real environment (inherited env, copied
 * .env, launchd plist) enrollment would silently write elsewhere and pairing
 * would "succeed but not work". Every use is therefore loudly logged and
 * flagged into the audit row (see sshDirOverride() callers). */
export function sshDirOverride(): string | null {
  return process.env.MARVEEN_SSH_DIR || null
}

function resolveSshDir(): string {
  const override = sshDirOverride()
  if (override) {
    logger.warn({ sshDir: override }, 'MARVEEN_SSH_DIR override active -- authorized_keys writes are redirected (test seam; must be unset in production)')
    return override
  }
  return join(homedir(), '.ssh')
}

export function defaultBridgeEnrollDeps(): BridgeEnrollDeps {
  return {
    sshDir: resolveSshDir(),
    readFile: (path) => {
      try {
        return readFileSync(path, 'utf8')
      } catch {
        return null
      }
    },
    keyscan: () =>
      new Promise((resolve) => {
        execFile(
          'ssh-keyscan',
          ['-T', '5', '-t', 'ed25519', '127.0.0.1'],
          { encoding: 'utf8', timeout: 15000 },
          (err, stdout) => resolve(err ? null : stdout),
        )
      }),
  }
}

/** Best-effort primary non-loopback IPv4 address of this machine. */
function primaryIPv4(): string | null {
  const ifaces = networkInterfaces()
  for (const name of Object.keys(ifaces)) {
    for (const info of ifaces[name] ?? []) {
      const family = info.family as string | number
      if ((family === 'IPv4' || family === 4) && !info.internal) {
        return info.address
      }
    }
  }
  return null
}

export async function bridgeEnroll(
  input: BridgeEnrollInput,
  deps: BridgeEnrollDeps = defaultBridgeEnrollDeps(),
): Promise<BridgeEnrollOutcome> {
  const parsed = validatePublicKeyLine(input.keyLine)

  // Resolve the host key FIRST: a bundle without one is unusable by the
  // consuming side, and failing before any write keeps the operation atomic
  // from the operator's point of view (nothing to clean up on error).
  const keyscanOutput = await deps.keyscan()
  const resolved = resolveHostKey({
    readFile: deps.readFile,
    keyscan: () => keyscanOutput,
  })
  if (resolved === null) {
    throw new RemoteEnrollError(
      "could not obtain this machine's ssh-ed25519 host key; ensure the SSH server is running (macOS: System Settings > General > Sharing > Remote Login)",
    )
  }

  const enrollResult = await enrollAuthorizedKey({
    sshDir: deps.sshDir,
    restrictedLine: buildRestrictedLine(parsed),
    installId: parsed.installId,
  })

  // Replace-by-id on the device-key side too: a re-paired device must not
  // keep its previous (possibly lost) key alive.
  const prior = findDeviceKeyByInstallId(parsed.installId)
  if (prior) revokeDeviceKey(prior.id)
  const minted = createDeviceKey(input.name, { installId: parsed.installId })

  const host = input.host ?? primaryIPv4() ?? hostname()
  const bundle = encodeBundle(
    buildBundle({
      displayName: hostname(),
      host,
      sshPort: input.sshPort ?? 22,
      sshUser: userInfo().username,
      installId: parsed.installId,
      hostKey: resolved.body,
      dashboardToken: minted.key,
    }),
  )

  return {
    action: enrollResult.action,
    warnings: enrollResult.warnings,
    installId: parsed.installId,
    deviceKeyId: minted.id,
    replacedDeviceKey: prior !== null,
    host,
    hostKeySource: resolved.source,
    bundle,
  }
}

/**
 * Revoke the SSH side of a Bridge pairing: drop the authorized_keys line for
 * the installId. Called by the device-key DELETE endpoint for keys that carry
 * an install_id; idempotent (removed:false when the line is already gone).
 */
export async function removeBridgeSshAccess(
  installId: string,
  deps?: Pick<BridgeEnrollDeps, 'sshDir'>,
): Promise<boolean> {
  const sshDir = deps?.sshDir ?? resolveSshDir()
  const result = await removeEnrolledKey({ sshDir, installId })
  return result.removed
}

// Issue the dashboard device key of an already-enrolled Bridge device
// (BRIDGEINSTKEY1020).
//
// Usage:
//   npm run bridge-device-key -- --install-id <uuid> [--name "<device name>"]
//
// The remote installer pairs its Bridge on the server while the dashboard may
// not be up yet, and fills the bundle's dashboard credential in later, over
// SSH. It used to read the SHARED token for that; this command gives it the
// device's own key instead: bound to the marveen-remote:<uuid> install id,
// listed under the dashboard device keys and revocable there (one revoke drops
// the key and the authorized_keys line together). A previous key of the same
// device is revoked (replace-by-id), exactly as on dashboard re-pairing.
//
// Refuses an install id with no enrolled authorized_keys line: see
// checkDeviceKeyRequest. Talks to SQLite directly (like dashboard-user), so a
// running dashboard is not required; it accepts the new key on first use.
//
// stdout carries ONLY the raw key, between marker lines; everything else goes
// to stderr. The key is a secret: never log or forward stdout.

import { readFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { checkDeviceKeyRequest, DEVICE_KEY_BEGIN, DEVICE_KEY_END } from '../src/bridge-device-key.js'
import { mintBridgeDeviceKey } from '../src/web/auth-device-keys.js'
import { initDatabase, logConfigChange } from '../src/db.js'
import { resolveSshDir } from '../src/ssh-dir.js'

function fail(message: string): never {
  process.stderr.write(`error: ${message}\n`)
  process.exit(1)
}

export function parseArgs(argv: string[]): { installId?: string; name?: string } {
  const out: { installId?: string; name?: string } = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--install-id') {
      const v = argv[++i]
      if (!v) fail('--install-id requires a value')
      out.installId = v
    } else if (a === '--name') {
      const v = argv[++i]
      if (!v) fail('--name requires a value')
      out.name = v
    } else {
      fail(`unknown argument: ${a}. Usage: npm run bridge-device-key -- --install-id <uuid> [--name "<device name>"]`)
    }
  }
  return out
}

export type IssueResult =
  | { ok: true; installId: string; name: string; key: string; replaced: boolean }
  | { ok: false; reason: string }

/**
 * Validate, then mint. `openDb` exists for the tests: they open an in-memory
 * database first and pass a no-op, so the mint runs end to end without ever
 * opening the install's real store/claudeclaw.db. A refused request never
 * opens the database at all.
 */
export function issueDeviceKey(
  args: { installId?: string; name?: string },
  authorizedKeys: string | null,
  openDb: () => void = () => initDatabase(),
): IssueResult {
  const request = checkDeviceKeyRequest(args.installId, args.name, authorizedKeys)
  if (!request.ok) return request
  openDb()
  const { minted, replaced } = mintBridgeDeviceKey(request.name, request.installId)
  logConfigChange('security.bridge_enroll', null, `${request.name} (${request.installId}) device_key_cli ${replaced ? 'replaced' : 'minted'}`, 'cli')
  return { ok: true, installId: request.installId, name: request.name, key: minted.key, replaced }
}

function main(): void {
  const args = parseArgs(process.argv.slice(2))
  const sshDir = resolveSshDir((dir) => {
    process.stderr.write(`warning: MARVEEN_SSH_DIR override active -- reading ${dir}, not the real ~/.ssh\n`)
  })
  let authorizedKeys: string | null
  try {
    authorizedKeys = readFileSync(join(sshDir, 'authorized_keys'), 'utf8')
  } catch {
    authorizedKeys = null
  }
  const issued = issueDeviceKey(args, authorizedKeys)
  if (!issued.ok) fail(issued.reason)
  process.stderr.write(
    `device key ${issued.replaced ? 'replaced' : 'minted'} for marveen-remote:${issued.installId} ("${issued.name}"); ` +
      'it is listed and revocable under the dashboard device keys.\n',
  )
  process.stdout.write(`${DEVICE_KEY_BEGIN}\n${issued.key}\n${DEVICE_KEY_END}\n`)
}

// Import-guard, same idiom and reasons as remote-access-enroll.ts: tests import
// parseArgs, and an unguarded main() would mint a key at import time.
function isInvokedDirectly(): boolean {
  const argv1 = process.argv[1]
  if (!argv1) return false
  try {
    return realpathSync(argv1) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return import.meta.url === pathToFileURL(argv1).href
  }
}

if (isInvokedDirectly()) {
  try {
    main()
  } catch (err) {
    process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`)
    process.exit(1)
  }
}

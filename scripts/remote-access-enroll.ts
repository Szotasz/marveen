// Remote access key enrollment helper.
//
// Enrolls a device's SSH public key into the invoking user's authorized_keys
// with a tightly restricted entry, then prints a base64 connection bundle the
// operator can hand back to the device.
//
// Usage:
//   npm run remote-enroll -- "ssh-ed25519 <base64 key> marveen-remote:<uuid>"
//   npm run remote-enroll -- --host 203.0.113.10 --port 2222 "<public key line>"
//   npm run remote-enroll -- --web-port 3421 "<public key line>"
//   npm run remote-enroll -- --no-dashboard-token "<public key line>"
//
// --port is the SSH port; --web-port is the dashboard port the enrolled key may
// tunnel to (permitopen) AND the port encoded in the bundle. It defaults to the
// WEB_PORT env / .env value, falling back to REMOTE_PORT. A mismatch between the
// permitopen and the actual dashboard port silently locks the device out
// (INSTUX1): the tunnel opens a dead port and the app reports "dashboard not
// running" forever.
//
// The bundle includes the dashboard bearer token (store/.dashboard-token) by
// default so the connecting app can authenticate against the dashboard. Such a
// bundle is a SECRET: hand it over on a private channel only, never by email.
// Pass --no-dashboard-token to emit a token-free bundle (the device user must
// then obtain the dashboard access URL out of band).

import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { homedir, hostname, userInfo, networkInterfaces } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isIP } from 'node:net'
import {
  validatePublicKeyLine,
  buildRestrictedLine,
  buildBundle,
  checkEnrollHost,
  dashboardTokenDecision,
  encodeBundle,
  resolveHostKey,
  HOST_KEY_PUB_CANDIDATES,
  RemoteEnrollError,
  REMOTE_PORT,
  type ConnectionBundleInput,
} from '../src/remote-enroll-core.js'
import { enrollAuthorizedKey } from '../src/remote-enroll-fs.js'
import { WEB_PORT as ENV_WEB_PORT } from '../src/config.js'

interface Args {
  keyLine?: string
  host?: string
  port: number
  webPort: number
  includeDashboardToken: boolean
}

/** Dashboard port default: the install's actual WEB_PORT, read from the same
 * .env the service loads (config resolves config-overrides.json > .env), so a
 * manual `remote-enroll` with no --web-port still targets the real port instead
 * of the 3420 default. Explicit --web-port overrides. Falls back to REMOTE_PORT
 * only when .env carries no WEB_PORT (config already applies that default). */
function defaultWebPort(): number {
  const n = ENV_WEB_PORT
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : REMOTE_PORT
}

function parseArgs(argv: string[]): Args {
  const out: Args = { port: 22, webPort: defaultWebPort(), includeDashboardToken: true }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--host') {
      const v = argv[++i]
      if (!v) fail('--host requires a value')
      // Same check as the dashboard route: this is the SECOND way a target
      // address enters a bundle, and leaving it open would mean the next
      // person has to find the same bug twice.
      const checked = checkEnrollHost(v, isIP)
      if (!checked.ok) fail(`--host: ${checked.reason}`)
      out.host = v
    } else if (a === '--no-dashboard-token') {
      out.includeDashboardToken = false
    } else if (a === '--port') {
      const v = argv[++i]
      if (!v) fail('--port requires a value')
      const n = Number(v)
      if (!Number.isInteger(n) || n < 1 || n > 65535) fail('--port must be 1..65535')
      out.port = n
    } else if (a === '--web-port') {
      const v = argv[++i]
      if (!v) fail('--web-port requires a value')
      const n = Number(v)
      if (!Number.isInteger(n) || n < 1 || n > 65535) fail('--web-port must be 1..65535')
      out.webPort = n
    } else if (a.startsWith('--')) {
      fail(`unknown flag: ${a}`)
    } else if (out.keyLine === undefined) {
      out.keyLine = a
    } else {
      fail('unexpected extra argument; pass the public key line as a single quoted argument')
    }
  }
  return out
}

function fail(message: string): never {
  process.stderr.write(`error: ${message}\n`)
  process.exit(1)
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

/**
 * Obtain the machine's ed25519 host key: known public-key file locations
 * first, then ssh-keyscan against loopback (covers hosts -- macOS among them
 * -- where the running SSH server's key is not at the conventional path).
 */
function obtainHostKey(): { body: string; source: string } | null {
  return resolveHostKey({
    readFile: (path) => {
      try {
        return readFileSync(path, 'utf8')
      } catch {
        return null
      }
    },
    keyscan: () => {
      try {
        return execFileSync('ssh-keyscan', ['-T', '5', '-t', 'ed25519', '127.0.0.1'], {
          encoding: 'utf8',
          timeout: 15000,
          stdio: ['ignore', 'pipe', 'ignore'],
        })
      } catch {
        return null
      }
    },
  })
}

/**
 * Read the dashboard bearer token the same way the running dashboard resolves
 * it: DASHBOARD_TOKEN env first, then store/.dashboard-token relative to the
 * repo root (this script lives in scripts/). Returns null when neither exists;
 * enrollment still succeeds, the bundle just carries no token.
 */
function readDashboardToken(): string | null {
  const fromEnv = process.env.DASHBOARD_TOKEN?.trim()
  if (fromEnv) return fromEnv
  const scriptDir = dirname(fileURLToPath(import.meta.url))
  const tokenPath = join(scriptDir, '..', 'store', '.dashboard-token')
  try {
    const cached = readFileSync(tokenPath, 'utf8').trim()
    return cached.length > 0 ? cached : null
  } catch {
    return null
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  if (args.keyLine === undefined) {
    fail('missing public key line. Usage: npm run remote-enroll -- "<public key line>"')
  }

  let parsed
  try {
    parsed = validatePublicKeyLine(args.keyLine)
  } catch (err) {
    if (err instanceof RemoteEnrollError) fail(err.message)
    throw err
  }

  const restrictedLine = buildRestrictedLine(parsed, args.webPort)
  const sshDir = join(homedir(), '.ssh')

  const result = await enrollAuthorizedKey({
    sshDir,
    restrictedLine,
    installId: parsed.installId,
  })

  for (const w of result.warnings) {
    process.stderr.write(`warning: ${w}\n`)
  }
  process.stderr.write(
    `${result.action === 'replaced' ? 'Replaced' : 'Added'} restricted entry for marveen-remote:${parsed.installId} in ${result.authorizedKeysPath}\n`,
  )

  // Assemble the connection bundle. The consuming side requires the host key,
  // so a bundle without one would be unusable -- fail hard instead of emitting
  // it silently. (The enrolled authorized_keys entry above is harmless on its
  // own and stays; re-running after fixing the SSH server replaces it by id.)
  const explicitHost = args.host
  const host = explicitHost ?? primaryIPv4() ?? hostname()
  const resolved = obtainHostKey()
  if (resolved === null) {
    fail(
      'could not obtain this machine\'s ssh-ed25519 host key ' +
        `(checked ${HOST_KEY_PUB_CANDIDATES.join(', ')} and ssh-keyscan on 127.0.0.1). ` +
        'Ensure the SSH server is running (on macOS: System Settings > General > Sharing > Remote Login), then re-run.',
    )
  }
  process.stderr.write(`host key: ${resolved.source}\n`)
  if (!explicitHost) {
    process.stderr.write(
      `hint: host resolved to "${host}". Verify this is the address the device will reach; override with --host if needed.\n`,
    )
  }

  const bundleInput: ConnectionBundleInput = {
    displayName: hostname(),
    host,
    sshPort: args.port,
    sshUser: userInfo().username,
    installId: parsed.installId,
    hostKey: resolved.body,
    webPort: args.webPort,
  }

  // Token-bundle decision (INSTNODE806): a token was requested by default, so a
  // MISSING token is a hard failure (the dashboard has not written one -- it is
  // not running), not a silent degrade to an unusable token-free bundle. This is
  // the same "unusable -- fail hard instead of emitting it silently" rule the
  // host-key check above already applies. `--no-dashboard-token` still emits a
  // deliberate token-free bundle.
  const tokenDecision = dashboardTokenDecision(args.includeDashboardToken, readDashboardToken())
  if ('ok' in tokenDecision) {
    fail(tokenDecision.reason)
  } else if (tokenDecision.include) {
    bundleInput.dashboardToken = tokenDecision.token
    process.stderr.write(
      'NOTE: this bundle contains the dashboard access token. Treat it as a secret: ' +
        'hand it over on a private channel, never by email or shared chat. ' +
        'Use --no-dashboard-token to emit a token-free bundle.\n',
    )
  }

  const encoded = encodeBundle(buildBundle(bundleInput))

  process.stdout.write('----- BEGIN CONNECTION BUNDLE -----\n')
  process.stdout.write(`${encoded}\n`)
  process.stdout.write('----- END CONNECTION BUNDLE -----\n')
}

main().catch((err) => {
  process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`)
  process.exit(1)
})

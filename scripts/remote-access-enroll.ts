// Remote access key enrollment helper.
//
// Enrolls a device's SSH public key into the invoking user's authorized_keys
// with a tightly restricted entry, then prints a base64 connection bundle the
// operator can hand back to the device.
//
// Usage:
//   npm run remote-enroll -- "ssh-ed25519 <base64 key> marveen-remote:<uuid>"
//   npm run remote-enroll -- --host 203.0.113.10 --port 2222 "<public key line>"

import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { homedir, hostname, userInfo, networkInterfaces } from 'node:os'
import { join } from 'node:path'
import {
  validatePublicKeyLine,
  buildRestrictedLine,
  buildBundle,
  encodeBundle,
  resolveHostKey,
  HOST_KEY_PUB_CANDIDATES,
  RemoteEnrollError,
  type ConnectionBundleInput,
} from '../src/remote-enroll-core.js'
import { enrollAuthorizedKey } from '../src/remote-enroll-fs.js'

interface Args {
  keyLine?: string
  host?: string
  port: number
}

function parseArgs(argv: string[]): Args {
  const out: Args = { port: 22 }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--host') {
      const v = argv[++i]
      if (!v) fail('--host requires a value')
      out.host = v
    } else if (a === '--port') {
      const v = argv[++i]
      if (!v) fail('--port requires a value')
      const n = Number(v)
      if (!Number.isInteger(n) || n < 1 || n > 65535) fail('--port must be 1..65535')
      out.port = n
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

  const restrictedLine = buildRestrictedLine(parsed)
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

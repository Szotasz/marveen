import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Docker Swarm / k8s secret-mount base directory.
// Override with SECRET_MOUNT_DIR in tests or non-standard deployments.
// Default matches both Docker secrets (/run/secrets) and k8s projected volumes.
const SECRET_DIR = (process.env['SECRET_MOUNT_DIR'] ?? '/run/secrets').replace(/\/+$/, '')

/**
 * Read a secret from the filesystem secret-mount directory.
 *
 * Returns the trimmed file content when the key exists as a file,
 * or undefined when the file is absent or empty (so callers fall back
 * to the next layer -- .env or registry default).
 *
 * Uses readFileSync with try/catch rather than existsSync + read to
 * avoid the TOCTOU race between the existence check and the read.
 */
export function resolveSecret(key: string): string | undefined {
  try {
    const val = readFileSync(join(SECRET_DIR, key), 'utf-8').trim()
    return val.length > 0 ? val : undefined
  } catch {
    return undefined
  }
}

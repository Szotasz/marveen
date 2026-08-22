import { readdirSync, statSync, readFileSync, unlinkSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { json } from '../http-helpers.js'
import { PROJECT_ROOT } from '../../config.js'

const REPO_ROOT = PROJECT_ROOT
import type { RouteContext } from './types.js'

const execFileAsync = promisify(execFile)

const BACKUP_DIR = join(REPO_ROOT, 'backups')
const BACKUP_SCRIPT = join(REPO_ROOT, 'scripts', 'backup.sh')
const VERIFY_SCRIPT = join(REPO_ROOT, 'scripts', 'verify-restore.sh')

interface BackupEntry {
  name: string
  path: string
  size: number
  created_at: number
  has_checksum: boolean
  checksum: string | null
}

function listBackups(): BackupEntry[] {
  if (!existsSync(BACKUP_DIR)) return []
  const files = readdirSync(BACKUP_DIR)
    .filter((f) => f.match(/^claudeclaw-\d{8}-\d{6}\.tar\.gz$/))
    .sort()
    .reverse()

  return files.map((name) => {
    const path = join(BACKUP_DIR, name)
    const stat = statSync(path)
    const sha256Path = path.replace('.tar.gz', '.sha256')
    let checksum: string | null = null
    if (existsSync(sha256Path)) {
      try {
        checksum = readFileSync(sha256Path, 'utf-8').trim().split(/\s+/)[0] ?? null
      } catch { checksum = null }
    }
    return {
      name,
      path,
      size: stat.size,
      created_at: Math.floor(stat.mtimeMs / 1000),
      has_checksum: checksum !== null,
      checksum,
    }
  })
}

export async function tryHandleBackups(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method } = ctx

  if (!path.startsWith('/api/backups')) return false

  if (path === '/api/backups' && method === 'GET') {
    const backups = listBackups()
    const last = backups[0] ?? null
    json(res, { backups, last_backup: last?.created_at ?? null })
    return true
  }

  if (path === '/api/backups/run' && method === 'POST') {
    if (!existsSync(BACKUP_SCRIPT)) {
      json(res, { error: 'Backup script not found' }, 500)
      return true
    }
    // Fire-and-forget: spawn detached so the HTTP response is not blocked.
    spawn('/usr/bin/env', ['bash', BACKUP_SCRIPT], { detached: true, stdio: 'ignore' }).unref()
    json(res, { ok: true, message: 'Backup started' })
    return true
  }

  const deleteMatch = path.match(/^\/api\/backups\/([^/]+)$/)
  if (deleteMatch && method === 'DELETE') {
    const name = decodeURIComponent(deleteMatch[1])
    // Reject path traversal: name must match the archive filename pattern exactly.
    if (!name.match(/^claudeclaw-\d{8}-\d{6}\.tar\.gz$/)) {
      json(res, { error: 'Invalid archive name' }, 400)
      return true
    }
    const filePath = join(BACKUP_DIR, name)
    if (!existsSync(filePath)) { json(res, { error: 'Archive not found' }, 404); return true }
    unlinkSync(filePath)
    const sha256Path = filePath.replace('.tar.gz', '.sha256')
    if (existsSync(sha256Path)) { try { unlinkSync(sha256Path) } catch { /* ignore */ } }
    json(res, { ok: true })
    return true
  }

  const verifyMatch = path.match(/^\/api\/backups\/([^/]+)\/verify$/)
  if (verifyMatch && method === 'POST') {
    const name = decodeURIComponent(verifyMatch[1])
    if (!name.match(/^claudeclaw-\d{8}-\d{6}\.tar\.gz$/)) {
      json(res, { error: 'Invalid archive name' }, 400)
      return true
    }
    const filePath = join(BACKUP_DIR, name)
    if (!existsSync(filePath)) { json(res, { error: 'Archive not found' }, 404); return true }
    if (!existsSync(VERIFY_SCRIPT)) {
      json(res, { error: 'verify-restore.sh not found' }, 500)
      return true
    }
    try {
      const { stdout, stderr } = await execFileAsync('/usr/bin/env', ['bash', VERIFY_SCRIPT, filePath], { timeout: 30_000 })
      json(res, { ok: true, output: (stdout + stderr).trim() })
    } catch (err: unknown) {
      const e = err as { stdout?: string; stderr?: string }
      json(res, { ok: false, output: ((e.stdout ?? '') + (e.stderr ?? '')).trim() }, 200)
    }
    return true
  }

  return false
}

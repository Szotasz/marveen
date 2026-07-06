import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash, randomBytes } from 'node:crypto'
import { readBody, json } from '../http-helpers.js'
import { logger } from '../../logger.js'
import {
  listVaultSshKeys,
  getVaultSshKey,
  createVaultSshKey,
  deleteVaultSshKey,
  type VaultSshKey,
} from '../../db.js'
import { setSecret, getSecret, deleteSecret } from '../vault.js'
import type { RouteContext } from './types.js'

function fingerprintFromPubKey(authorizedKeyLine: string): string {
  const parts = authorizedKeyLine.trim().split(' ')
  if (parts.length < 2) return ''
  const raw = Buffer.from(parts[1], 'base64')
  return 'SHA256:' + createHash('sha256').update(raw).digest('base64').replace(/=+$/, '')
}

export function generateSshKeyPair(comment: string): { privateKey: string; publicKey: string; fingerprint: string } {
  const tmpDir = mkdtempSync(join(tmpdir(), 'marveen-ssh-'))
  const keyPath = join(tmpDir, 'key')
  try {
    execFileSync('ssh-keygen', ['-t', 'ed25519', '-f', keyPath, '-N', '', '-C', comment], { stdio: 'pipe' })
    const privateKey = readFileSync(keyPath, 'utf-8')
    const publicKey = readFileSync(`${keyPath}.pub`, 'utf-8').trim()
    return { privateKey, publicKey, fingerprint: fingerprintFromPubKey(publicKey) }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
}

export function extractPublicKeyFromVault(vaultKeyId: string): string | null {
  const privateKeyPem = getSecret(vaultKeyId)
  if (!privateKeyPem) return null
  const tmpDir = mkdtempSync(join(tmpdir(), 'marveen-ssh-'))
  const keyPath = join(tmpDir, 'key')
  try {
    writeFileSync(keyPath, privateKeyPem, { mode: 0o600 })
    chmodSync(keyPath, 0o600)
    return execFileSync('ssh-keygen', ['-y', '-f', keyPath], { stdio: 'pipe' }).toString().trim()
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
}

function toApiShape(key: VaultSshKey) {
  return {
    id: key.id,
    label: key.label,
    username: key.username,
    publicKey: key.public_key,
    fingerprint: key.fingerprint,
    keyType: key.key_type,
    createdAt: new Date(key.created_at * 1000).toISOString(),
  }
}

export async function tryHandleVaultSshKeys(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method } = ctx

  if (!path.startsWith('/api/vault/ssh-keys')) return false

  // GET /api/vault/ssh-keys
  if (path === '/api/vault/ssh-keys' && method === 'GET') {
    json(res, { keys: listVaultSshKeys().map(toApiShape) })
    return true
  }

  // POST /api/vault/ssh-keys
  if (path === '/api/vault/ssh-keys' && method === 'POST') {
    try {
      const body = await readBody(req)
      const data = JSON.parse(body.toString())

      const label    = typeof data.label    === 'string' ? data.label.trim()    : ''
      const username = typeof data.username === 'string' ? data.username.trim() : ''

      if (!label || !username) {
        json(res, { error: 'label and username are required' }, 400)
        return true
      }

      const id = randomBytes(8).toString('hex')
      const comment = `${username} (${label})`
      const { privateKey, publicKey, fingerprint } = generateSshKeyPair(comment)

      const vaultKeyId = `ssh-key-${id}`
      setSecret(vaultKeyId, `SSH private key: ${label}`, privateKey)

      const key = createVaultSshKey({ id, label, username, vault_key_id: vaultKeyId, public_key: publicKey, fingerprint, key_type: 'ed25519' })
      logger.info({ id, label, fingerprint }, 'SSH key created')
      json(res, { key: toApiShape(key), publicKey }, 201)
    } catch (err: any) {
      logger.error({ err }, 'Failed to create SSH key')
      json(res, { error: 'Key generation failed: ' + (err?.message ?? String(err)) }, 500)
    }
    return true
  }

  // POST /api/vault/ssh-keys/import
  if (path === '/api/vault/ssh-keys/import' && method === 'POST') {
    try {
      const body = await readBody(req)
      const data = JSON.parse(body.toString())

      const label      = typeof data.label      === 'string' ? data.label.trim()      : ''
      const username   = typeof data.username   === 'string' ? data.username.trim()   : ''
      const privateKey = typeof data.privateKey === 'string' ? data.privateKey.trim() : ''

      if (!label || !username || !privateKey) {
        json(res, { error: 'label, username and privateKey are required' }, 400)
        return true
      }

      // Validate key and extract public key via ssh-keygen -y (same pattern as extractPublicKeyFromVault)
      const tmpDir = mkdtempSync(join(tmpdir(), 'marveen-ssh-'))
      const keyPath = join(tmpDir, 'key')
      let publicKey: string
      try {
        const keyContent = privateKey.endsWith('\n') ? privateKey : privateKey + '\n'
        writeFileSync(keyPath, keyContent, { mode: 0o600 })
        chmodSync(keyPath, 0o600)
        publicKey = execFileSync('ssh-keygen', ['-y', '-f', keyPath], { stdio: 'pipe' }).toString().trim()
      } catch (err: any) {
        json(res, { error: 'Invalid private key: ' + (err?.stderr?.toString().trim() ?? err?.message ?? String(err)) }, 400)
        return true
      } finally {
        rmSync(tmpDir, { recursive: true, force: true })
      }

      // Autodetect key type from public key prefix
      const keyType = publicKey.startsWith('ssh-ed25519') ? 'ed25519'
                    : publicKey.startsWith('ssh-rsa')     ? 'rsa'
                    : publicKey.startsWith('ecdsa-')      ? 'ecdsa'
                    : 'unknown'

      const fingerprint = fingerprintFromPubKey(publicKey)
      const id = randomBytes(8).toString('hex')
      const vaultKeyId = `ssh-key-${id}`

      setSecret(vaultKeyId, `SSH private key: ${label}`, privateKey)
      const key = createVaultSshKey({ id, label, username, vault_key_id: vaultKeyId, public_key: publicKey, fingerprint, key_type: keyType })
      logger.info({ id, label, fingerprint, keyType }, 'SSH key imported')
      json(res, { key: toApiShape(key), publicKey }, 201)
    } catch (err: any) {
      logger.error({ err }, 'Failed to import SSH key')
      json(res, { error: 'Import failed: ' + (err?.message ?? String(err)) }, 500)
    }
    return true
  }

  // GET /api/vault/ssh-keys/:id/public-key
  const pubKeyMatch = path.match(/^\/api\/vault\/ssh-keys\/([^/]+)\/public-key$/)
  if (pubKeyMatch && method === 'GET') {
    const id = decodeURIComponent(pubKeyMatch[1])
    const key = getVaultSshKey(id)
    if (!key) { json(res, { error: `Key "${id}" not found` }, 404); return true }
    json(res, { publicKey: key.public_key, fingerprint: key.fingerprint, keyType: key.key_type })
    return true
  }

  // DELETE /api/vault/ssh-keys/:id
  const delMatch = path.match(/^\/api\/vault\/ssh-keys\/([^/]+)$/)
  if (delMatch && method === 'DELETE') {
    const id = decodeURIComponent(delMatch[1])
    const key = getVaultSshKey(id)
    if (!key) { json(res, { error: `Key "${id}" not found` }, 404); return true }
    const { deleted, unassigned } = deleteVaultSshKey(id)
    if (!deleted) { json(res, { error: `Key "${id}" not found` }, 404); return true }
    // The pool row is gone, but the encrypted private key still sits in the
    // generic vault.ts secret store (vault_key_id) unless we remove it too --
    // otherwise it lingers as an orphaned "ssh-key-*" entry, visible/revealable
    // in the generic secrets list with no pool entry pointing back to it
    // (2026-07-01, found during Vault key-pool redesign verification).
    deleteSecret(key.vault_key_id)
    logger.info({ id, unassigned }, 'SSH key deleted')
    json(res, { ok: true, unassigned })
    return true
  }

  return false
}

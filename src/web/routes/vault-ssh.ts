import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { readBody, json } from '../http-helpers.js'
import { logger } from '../../logger.js'
import {
  listVaultSshServers,
  getVaultSshServer,
  createVaultSshServer,
  updateVaultSshServer,
  deleteVaultSshServer,
  computeSshKeyStatus,
  getVaultSshKey,
  listVaultSshKeys,
  type VaultSshServer,
  type VaultSshKey,
} from '../../db.js'
import { generateSshKeyPair } from './vault-ssh-keys.js'
import { setSecret } from '../vault.js'
import type { RouteContext } from './types.js'

function toApiShape(server: VaultSshServer, key?: VaultSshKey | null) {
  return {
    id: server.id,
    name: server.name,
    host: server.host,
    port: server.port,
    user: server.username,
    desc: server.description ?? '',
    keyStatus: computeSshKeyStatus(server),
    sshKeyId: server.ssh_key_id ?? null,
    keyType: key?.key_type ?? null,
    fingerprint: key?.fingerprint ?? null,
    createdAt: new Date(server.created_at * 1000).toISOString(),
    updatedAt: new Date(server.updated_at * 1000).toISOString(),
  }
}

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 64)
}

function validateId(id: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,63}$/.test(id)
}

function buildKeyMap(servers: VaultSshServer[]): Map<string, VaultSshKey> {
  const keyIds = [...new Set(servers.map(s => s.ssh_key_id).filter(Boolean) as string[])]
  const map = new Map<string, VaultSshKey>()
  for (const id of keyIds) {
    const k = getVaultSshKey(id)
    if (k) map.set(id, k)
  }
  return map
}

export async function tryHandleVaultSsh(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method } = ctx

  if (!path.startsWith('/api/vault/ssh-servers')) return false

  // GET /api/vault/ssh-servers
  if (path === '/api/vault/ssh-servers' && method === 'GET') {
    const servers = listVaultSshServers()
    const keyMap = buildKeyMap(servers)
    json(res, { servers: servers.map(s => toApiShape(s, s.ssh_key_id ? keyMap.get(s.ssh_key_id) : null)) })
    return true
  }

  // POST /api/vault/ssh-servers
  if (path === '/api/vault/ssh-servers' && method === 'POST') {
    try {
      const body = await readBody(req)
      const data = JSON.parse(body.toString())

      const name = typeof data.name === 'string' ? data.name.trim() : ''
      const host = typeof data.host === 'string' ? data.host.trim() : ''
      const user = typeof data.user === 'string' ? data.user.trim() : ''
      const port = Number.isInteger(data.port) && data.port > 0 && data.port <= 65535 ? data.port : 22
      const desc = typeof data.desc === 'string' ? data.desc.trim() : null

      if (!name || !host || !user) {
        json(res, { error: 'name, host and user are required' }, 400)
        return true
      }

      const id = data.id && validateId(data.id) ? data.id : slugify(name) || slugify(host)
      if (!validateId(id)) {
        json(res, { error: 'Could not derive a valid id from the name' }, 400)
        return true
      }

      if (getVaultSshServer(id)) {
        json(res, { error: `Server with id "${id}" already exists` }, 409)
        return true
      }

      const server = createVaultSshServer({ id, name, host, port, username: user, description: desc || null })
      logger.info({ id }, 'vault ssh server created')
      json(res, { server: toApiShape(server) }, 201)
    } catch (err) {
      logger.error({ err }, 'Failed to create vault ssh server')
      json(res, { error: 'Failed to create server' }, 500)
    }
    return true
  }

  // PUT /api/vault/ssh-servers/:id
  const singleMatch = path.match(/^\/api\/vault\/ssh-servers\/([^/]+)$/)

  if (singleMatch && method === 'PUT') {
    const id = decodeURIComponent(singleMatch[1])
    try {
      const existing = getVaultSshServer(id)
      if (!existing) { json(res, { error: `Server "${id}" not found` }, 404); return true }

      const body = await readBody(req)
      const data = JSON.parse(body.toString())

      const patch: Parameters<typeof updateVaultSshServer>[1] = {}
      if (typeof data.name === 'string')     patch.name        = data.name.trim()
      if (typeof data.host === 'string')     patch.host        = data.host.trim()
      if (typeof data.user === 'string')     patch.username    = data.user.trim()
      if (Number.isInteger(data.port) && data.port > 0 && data.port <= 65535) patch.port = data.port
      if (data.desc !== undefined)           patch.description = typeof data.desc === 'string' ? (data.desc.trim() || null) : null
      // Key assignment: sshKeyId (assign existing pool key) or null (unassign)
      if (data.sshKeyId !== undefined) {
        if (data.sshKeyId !== null && !getVaultSshKey(data.sshKeyId)) {
          json(res, { error: `SSH key "${data.sshKeyId}" not found` }, 404)
          return true
        }
        patch.ssh_key_id = data.sshKeyId ?? null
      }

      updateVaultSshServer(id, patch)
      const updated = getVaultSshServer(id)!
      const key = updated.ssh_key_id ? getVaultSshKey(updated.ssh_key_id) : null
      logger.info({ id }, 'vault ssh server updated')
      json(res, { server: toApiShape(updated, key) })
    } catch (err) {
      logger.error({ err }, 'Failed to update vault ssh server')
      json(res, { error: 'Failed to update server' }, 500)
    }
    return true
  }

  // DELETE /api/vault/ssh-servers/:id
  if (singleMatch && method === 'DELETE') {
    const id = decodeURIComponent(singleMatch[1])
    if (!deleteVaultSshServer(id)) {
      json(res, { error: `Server "${id}" not found` }, 404)
      return true
    }
    logger.info({ id }, 'vault ssh server deleted')
    json(res, { ok: true })
    return true
  }

  // POST /api/vault/ssh-servers/:id/generate-key
  // Legacy convenience: generates a new pool key and immediately assigns it.
  const genKeyMatch = path.match(/^\/api\/vault\/ssh-servers\/([^/]+)\/generate-key$/)
  if (genKeyMatch && method === 'POST') {
    const id = decodeURIComponent(genKeyMatch[1])
    const server = getVaultSshServer(id)
    if (!server) { json(res, { error: `Server "${id}" not found` }, 404); return true }
    try {
      let keyUser = server.username
      const bodyRaw = await readBody(req)
      if (bodyRaw.length > 0) {
        try {
          const data = JSON.parse(bodyRaw.toString())
          if (typeof data.username === 'string' && data.username.trim()) keyUser = data.username.trim()
        } catch { /* use default */ }
      }

      const { randomBytes } = await import('node:crypto')
      const keyId = randomBytes(8).toString('hex')
      const label = `${server.name} (${keyUser})`
      const comment = `${keyUser}@${server.host}`
      const { privateKey, publicKey, fingerprint } = generateSshKeyPair(comment)

      const vaultKeyId = `ssh-key-${keyId}`
      setSecret(vaultKeyId, `SSH private key: ${label}`, privateKey)

      const { createVaultSshKey } = await import('../../db.js')
      createVaultSshKey({ id: keyId, label, username: keyUser, vault_key_id: vaultKeyId, public_key: publicKey, fingerprint, key_type: 'ed25519' })

      updateVaultSshServer(id, { ssh_key_id: keyId })
      const updated = getVaultSshServer(id)!
      const key = getVaultSshKey(keyId)!
      logger.info({ id, keyId, fingerprint }, 'SSH keypair generated and assigned to server')
      json(res, { server: toApiShape(updated, key), publicKey, fingerprint })
    } catch (err: any) {
      logger.error({ err, id }, 'Failed to generate SSH keypair')
      json(res, { error: 'Key generation failed: ' + (err?.message ?? String(err)) }, 500)
    }
    return true
  }

  // GET /api/vault/ssh-servers/:id/public-key
  const pubKeyMatch = path.match(/^\/api\/vault\/ssh-servers\/([^/]+)\/public-key$/)
  if (pubKeyMatch && method === 'GET') {
    const id = decodeURIComponent(pubKeyMatch[1])
    const server = getVaultSshServer(id)
    if (!server) { json(res, { error: `Server "${id}" not found` }, 404); return true }
    if (!server.ssh_key_id) { json(res, { error: 'No key assigned to this server' }, 404); return true }
    const key = getVaultSshKey(server.ssh_key_id)
    if (!key) { json(res, { error: 'Assigned key not found' }, 404); return true }
    json(res, { publicKey: key.public_key, fingerprint: key.fingerprint, keyType: key.key_type })
    return true
  }

  return false
}

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readBody, json } from '../http-helpers.js'
import { setSecret, getSecret } from '../vault.js'
import { logger } from '../../logger.js'
import type { RouteContext } from './types.js'

const LOCAL_BIN = `${process.env.HOME}/.local/bin`
const EXTENDED_PATH = `${LOCAL_BIN}:${process.env.PATH || ''}`

const VAULT_ID = 'CONNECTORS_HU_TOKEN'
const VAULT_LABEL = 'connectors.hu API token'
const INSTALL_TIMEOUT = 60_000
const SYNC_TIMEOUT = 30_000
const MAX_OUTPUT = 4096

function which(bin: string): Promise<string | null> {
  return new Promise(resolve => {
    execFile('/usr/bin/which', [bin], { timeout: 3000 }, (err, stdout) => {
      resolve(err ? null : stdout.trim() || null)
    })
  })
}

async function isInstalled(): Promise<{ installed: boolean; path: string | null }> {
  const p = await which('connectors')
  if (p) return { installed: true, path: p }
  const localPath = `${LOCAL_BIN}/connectors`
  if (existsSync(localPath)) return { installed: true, path: localPath }
  return { installed: false, path: null }
}

function runCommand(cmd: string, args: string[], opts: { timeout: number; env?: Record<string, string> }): Promise<{ ok: boolean; output: string }> {
  return new Promise(resolve => {
    const childEnv = { ...process.env, ...opts.env }
    execFile(cmd, args, { timeout: opts.timeout, env: childEnv, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      const combined = ((stdout || '') + '\n' + (stderr || '')).trim()
      const output = combined.length > MAX_OUTPUT ? combined.slice(-MAX_OUTPUT) : combined
      resolve({ ok: !err, output })
    })
  })
}

export async function tryHandleConnectorsHu(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method } = ctx

  if (path === '/api/connectors-hu/status' && method === 'GET') {
    try {
      const { installed } = await isInstalled()
      const configured = getSecret(VAULT_ID) !== null
      let version: string | undefined
      if (installed) {
        const result = await runCommand('connectors', ['--version'], { timeout: 5000, env: { PATH: EXTENDED_PATH } })
        if (result.ok && result.output) version = result.output.split('\n')[0].trim()
      }
      json(res, { ok: true, installed, configured, ...(version ? { version } : {}) })
    } catch (err) {
      logger.error({ err }, 'connectors-hu status check failed')
      json(res, { ok: false, installed: false, configured: false }, 500)
    }
    return true
  }

  if (path === '/api/connectors-hu/install' && method === 'POST') {
    try {
      const result = await runCommand('/bin/sh', ['-c', 'curl -fsSL https://connectors.hu/install.sh | sh'], { timeout: INSTALL_TIMEOUT })
      const { installed } = await isInstalled()
      json(res, { ok: result.ok, installed, output: result.output })
      if (result.ok) logger.info('connectors CLI installed')
      else logger.warn({ output: result.output }, 'connectors CLI install failed')
    } catch (err) {
      logger.error({ err }, 'connectors-hu install failed')
      json(res, { ok: false, installed: false, output: String(err) }, 500)
    }
    return true
  }

  if (path === '/api/connectors-hu/configure' && method === 'POST') {
    try {
      const body = await readBody(req)
      const { token } = JSON.parse(body.toString()) as { token: string }
      if (!token?.trim()) {
        json(res, { ok: false, configured: false, syncOutput: 'Token is required' }, 400)
        return true
      }

      setSecret(VAULT_ID, VAULT_LABEL, token.trim())

      const { installed } = await isInstalled()
      if (!installed) {
        json(res, { ok: true, configured: true, syncOutput: 'Token saved. connectors CLI not installed yet, sync skipped.' })
        return true
      }

      const result = await runCommand('connectors', ['sync'], {
        timeout: SYNC_TIMEOUT,
        env: { PATH: EXTENDED_PATH, CONNECTORS_HU_TOKEN: token.trim() },
      })

      json(res, { ok: result.ok, configured: true, syncOutput: result.output })
      if (result.ok) logger.info('connectors-hu configured and synced')
      else logger.warn({ output: result.output }, 'connectors sync returned non-zero')
    } catch (err) {
      logger.error({ err }, 'connectors-hu configure failed')
      json(res, { ok: false, configured: false, syncOutput: String(err) }, 500)
    }
    return true
  }

  return false
}

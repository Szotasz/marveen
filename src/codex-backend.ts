import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { connect } from 'node:net'
import { spawn } from 'node:child_process'
import { PROJECT_ROOT, STORE_DIR } from './config.js'
import { getCodexDeliveryStore, scheduledCodexIdentity, type CodexDelivery, type CodexDeliveryStore } from './codex-delivery.js'

export function usesCodex(): boolean {
  return process.env.MARVEEN_AGENT_BACKEND === 'codex'
}

export function queueCodexScheduledTask(input: {
  taskId: string
  agentId: string
  scheduledOccurrence: number
  prompt: string
  queuedAt: number
  late: boolean
}, store?: CodexDeliveryStore): { delivery: CodexDelivery; created: boolean } {
  return (store ?? getCodexDeliveryStore()).prepare(input)
}

export function codexScheduledDeliveries(): CodexDelivery[] {
  return getCodexDeliveryStore().listMonitorable()
}

export function codexPane(): string | null {
  try {
    const status = JSON.parse(readFileSync(join(STORE_DIR, 'codex/status.json'), 'utf8'))
    process.kill(status.pid, 0)
    return status.busy ? '[marveen-codex:busy]' : '[marveen-codex:ready]'
  } catch { return null }
}

export function sendCodexPrompt(text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = connect(join(STORE_DIR, 'codex/channel.sock'))
    let data = ''
    socket.setTimeout(5000, () => socket.destroy(new Error('Codex channel unavailable')))
    socket.on('error', reject)
    socket.on('connect', () => socket.write(JSON.stringify({ text }) + '\n'))
    socket.on('data', chunk => {
      data += chunk
      if (!data.includes('\n')) return
      socket.end()
      try {
        const result = JSON.parse(data.split('\n')[0])
        if (result.ok) resolve()
        else reject(new Error(result.error || 'Codex rejected prompt'))
      } catch (error) { reject(error) }
    })
  })
}

export function sendCodexScheduledDelivery(input: {
  taskId: string; agentId: string; scheduledOccurrence: number; prompt: string; queuedAt: number; late: boolean
}): Promise<{ deliveryId: string; idempotencyKey: string; scheduledOccurrence: number; status: string; created: boolean }> {
  const identity = scheduledCodexIdentity(input.taskId, input.agentId, input.scheduledOccurrence)
  const payload = { type: 'scheduled_delivery', ...input, ...identity }
  return new Promise((resolve, reject) => {
    const socket = connect(join(STORE_DIR, 'codex/channel.sock'))
    let data = ''
    socket.setTimeout(5000, () => socket.destroy(new Error('Codex channel unavailable')))
    socket.on('error', reject)
    socket.on('connect', () => socket.write(JSON.stringify(payload) + '\n'))
    socket.on('data', chunk => {
      data += chunk
      if (!data.includes('\n')) return
      socket.end()
      try {
        const result = JSON.parse(data.split('\n')[0])
        if (!result.ok) throw new Error(result.error || 'Codex rejected scheduled delivery')
        if (result.deliveryId !== identity.deliveryId || result.idempotencyKey !== identity.idempotencyKey ||
            result.scheduledOccurrence !== input.scheduledOccurrence) throw new Error('Codex delivery acknowledgement mismatch')
        resolve({ deliveryId: result.deliveryId, idempotencyKey: result.idempotencyKey,
          scheduledOccurrence: result.scheduledOccurrence, status: result.status, created: result.created })
      } catch (error) { reject(error) }
    })
  })
}

export function runCodexWorker(message: string, cwd: string, timeoutMs: number, allowTools: boolean): Promise<{text: string | null; error?: string}> {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [join(PROJECT_ROOT, 'scripts/codex-worker.mjs')], {
      cwd, env: process.env, stdio: ['pipe', 'pipe', 'ignore'],
    })
    let output = ''
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM') }, timeoutMs)
    child.stdin.on('error', () => {})
    child.stdout.on('data', data => { if (output.length < 4_000_000) output += data })
    child.on('error', error => { clearTimeout(timer); resolve({text: null, error: error.message}) })
    child.on('exit', code => {
      clearTimeout(timer)
      if (timedOut) return resolve({ text: null, error: 'Codex timeout' })
      if (code !== 0) return resolve({text: null, error: 'Codex worker failed; check ChatGPT login and quota'})
      try { resolve(JSON.parse(output)) } catch { resolve({text: null, error: 'Invalid Codex worker response'}) }
    })
    child.stdin.end(JSON.stringify({ message, cwd, allowTools }))
  })
}

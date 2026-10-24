import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { EventEmitter } from 'node:events'

/** Newline JSON-RPC shared by Codex app-server and stdio MCP servers. */
export class JsonRpcProcess extends EventEmitter {
  constructor(command, args, options = {}) {
    super()
    this.nextId = 1
    this.pending = new Map()
    this.processGroup = options.detached === true && process.platform !== 'win32'
    this.child = spawn(command, args, { ...options, stdio: ['pipe', 'pipe', 'pipe'] })
    this.child.stdin.on('error', error => this.fail(error))
    this.child.stderr.on('data', data => this.emit('diagnostic', data.toString()))
    this.lines = createInterface({ input: this.child.stdout })
    this.lines.on('line', line => {
      let message
      try { message = JSON.parse(line) } catch { return }
      if (message.id !== undefined && !message.method) {
        const pending = this.pending.get(message.id)
        if (!pending) return
        this.pending.delete(message.id)
        clearTimeout(pending.timer)
        if (message.error) pending.reject(new Error(message.error.message ?? 'RPC error'))
        else pending.resolve(message.result)
      } else this.emit('message', message)
    })
    this.child.on('error', error => this.fail(error))
    this.child.on('exit', (code, signal) => {
      this.fail(new Error(`RPC process exited (${code ?? signal})`))
      this.emit('exit', code, signal)
    })
  }
  fail(error) {
    this.failure = error
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error) }
    this.pending.clear()
  }
  send(message) {
    if (this.failure) throw this.failure
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n')
  }
  request(method, params = {}, timeoutMs = 120_000) {
    if (this.failure) return Promise.reject(this.failure)
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`RPC timeout: ${method}`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      try { this.send({ id, method, params }) }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error) }
    })
  }
  notify(method, params = {}) { this.send({ method, params }) }
  close() {
    if (this.processGroup && this.child.pid > 1) {
      try { process.kill(-this.child.pid, 'SIGTERM') } catch {}
    } else this.child.kill('SIGTERM')
  }
}

export function toolResult(result) {
  return {
    success: !result.isError,
    contentItems: (result.content ?? []).map(item => {
      if (item.type === 'image') return { type: 'inputImage', imageUrl: `data:${item.mimeType};base64,${item.data}` }
      return { type: 'inputText', text: item.type === 'text' ? item.text : JSON.stringify(item) }
    }),
  }
}

// Only structured metadata from the authenticated channel becomes routing data.
export function channelInput(params) {
  if (!params?.meta?.chat_id || typeof params.content !== 'string') throw new Error('Invalid channel message')
  return [{ type: 'text', text: JSON.stringify({ source: 'telegram', metadata: params.meta, message: params.content }) }]
}

export function isContextExhausted(error) {
  return /ran out of room in the model.s context window|context window exceeded|context_length_exceeded|Error running remote compact task:.*Bad Request|no rollout found for thread id/i.test(String(error?.message ?? error))
}

export function retireExhaustedThread(state, chatId, error) {
  if (!isContextExhausted(error) || !state.threads[chatId]) return false
  state.retiredThreads ??= []
  state.retiredThreads.push({chatId, threadId: state.threads[chatId], reason: 'context-exhausted', at: new Date().toISOString()})
  delete state.threads[chatId]
  return true
}

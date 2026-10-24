// Explicit allowlist: never inherit the account's expensive default model.
export const DEFAULT_MODEL = 'gpt-6-luna'
export const STRONG_MODEL = 'gpt-6-sol'
export const escalationTool = {
  type: 'function', name: 'request_stronger_model',
  description: 'Continue this task with GPT-6 Sol when difficult reasoning, complex debugging or substantial planning exceeds the default model. Not for routine checks, lookups, greetings, quota errors or missing credentials. Call at most once, before replying; then end the turn without further actions. Completed actions are retained, not replayed.',
  inputSchema: {type: 'object', properties: {reason: {type: 'string', minLength: 10, maxLength: 500}}, required: ['reason'], additionalProperties: false},
}

export const economyInstructions = `
Cost policy: each new request starts on GPT-6 Luna. For genuinely difficult
reasoning, complex debugging or substantial planning, call request_stronger_model
with a brief concrete reason BEFORE replying, then immediately end this turn
without more tools or a final answer. The host continues the SAME task on Sol,
preserving prior actions. Do not retry completed side effects. Only one upgrade
is allowed per request, and the next request resets to Luna. Astra is disabled.
Do not upgrade for greetings, routine housekeeping, lookups, missing access or
quota errors. Never launch another model/CLI or change model settings to bypass
this policy. Keep routine answers concise. Do not invent extra background work.
Older resumed threads may not expose request_stronger_model. Only if that tool
is absent, request the same upgrade by ending with exactly this JSON (no fences
or other text): {"marveen_model_upgrade":true,"reason":"brief concrete reason"}.
This marker is consumed by the host and is not sent to the user.
`

/** One isolated app-server per lane and task, with bounded in-thread escalation. */
export class EconomySession {
  constructor({open, close, thread, callTool, onEvent = () => {}, timeoutMs = 600000}) {
    Object.assign(this, {open, close, thread, callTool, onEvent, timeoutMs})
  }
  async run(input) {
    let rpc, active, timer
    let didWork = false, replied = false
    const started = Date.now()
    try {
      rpc = await this.open()
      const threadId = await this.thread(rpc)
      const handler = message => {
        const p = message.params
        if (message.method === 'item/tool/call' && message.id !== undefined) {
          const respond = result => { if (!rpc.failure) rpc.send({id: message.id, result}) }
          void (async () => {
            if (!active || p?.threadId !== threadId) throw new Error('No matching active turn')
            if (p.tool === escalationTool.name) {
              const reason = p.arguments?.reason
              if (active.model !== DEFAULT_MODEL || replied || active.upgrade) throw new Error('Upgrade unavailable or already requested')
              if (typeof reason !== 'string' || reason.trim().length < 10 || reason.length > 500) throw new Error('A concrete reason (10-500 characters) is required')
              active.upgrade = true
              respond({success: true, contentItems: [{type: 'inputText', text: 'Upgrade accepted. End this turn now without a reply or further tools. Sol will continue the same task with its existing history.'}]})
              return
            }
            if (active.upgrade) throw new Error('Upgrade pending; end the turn without further actions')
            didWork = true
            const result = await this.callTool(p)
            if (p.tool === 'telegram_reply' && result.success) replied = true
            respond(result)
          })().catch(error => respond({success: false, contentItems: [{type: 'inputText', text: error.message}]}))
        } else if (message.id !== undefined && message.method) {
          rpc.send({id: message.id, error: {code: -32601, message: 'Interactive approval unavailable'}})
        } else if (p?.threadId === threadId && active) {
          if (message.method === 'item/started' && p.item &&
              !['userMessage', 'agentMessage', 'reasoning', 'contextCompaction'].includes(p.item.type) &&
              !(p.item.type === 'dynamicToolCall' && p.item.tool === escalationTool.name)) didWork = true
          if (message.method === 'item/completed' && p.item?.type === 'agentMessage') active.text = p.item.text
          if (message.method === 'turn/completed') {
            if (p.turn.status === 'completed') active.resolve()
            else active.reject(new Error(p.turn.error?.message ?? `Turn ${p.turn.status}`))
          }
        }
      }
      rpc.on('message', handler)
      const onExit = () => active?.reject(new Error('Codex exited during task'))
      rpc.on('exit', onExit)
      let nextInput = input
      for (const model of [DEFAULT_MODEL, STRONG_MODEL]) {
        let resolve, reject
        const done = new Promise((res, rej) => {resolve = res; reject = rej})
        void done.catch(() => {})
        active = {model, resolve, reject, text: '', upgrade: false}
        timer = setTimeout(() => {
          reject(new Error('Codex task timed out; no automatic replay'))
          rpc.expectedExit = true
          rpc.close()
        }, Math.max(1, this.timeoutMs - (Date.now() - started)))
        this.onEvent({event: 'model-start', model})
        await rpc.request('turn/start', {threadId, input: nextInput, model, effort: model === DEFAULT_MODEL ? 'low' : 'medium'})
        await done
        clearTimeout(timer)
        if (model === DEFAULT_MODEL && !replied && !active.upgrade) {
          try {
            const marker = JSON.parse(active.text)
            if (marker.marveen_model_upgrade === true && typeof marker.reason === 'string' &&
                marker.reason.trim().length >= 10 && marker.reason.length <= 500) active.upgrade = true
          } catch { /* Normal final answer, not an upgrade marker. */ }
        }
        if (!active.upgrade) return {text: active.text, replied, model}
        this.onEvent({event: 'model-upgrade', model: STRONG_MODEL})
        nextInput = [{type: 'text', text: 'The host has switched this task to GPT-6 Sol as requested. Continue the original task from the existing conversation and tool results. Do not repeat completed actions. Complete the task and reply normally; no further model upgrade is available.'}]
      }
      throw new Error('Model escalation limit reached')
    } catch (error) {
      error.safeToRetry = !didWork && !replied
      throw error
    } finally {
      clearTimeout(timer)
      if (rpc) await this.close(rpc)
      this.onEvent({event: 'task-end', elapsedMs: Date.now() - started})
    }
  }
}

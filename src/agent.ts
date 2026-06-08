import { query } from '@anthropic-ai/claude-agent-sdk'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { execSync } from 'node:child_process'
import { PROJECT_ROOT } from './config.js'

const TYPING_REFRESH_MS = 4000
import { logger } from './logger.js'

const AGENT_TIMEOUT_MS = Number(process.env.MARVEEN_AGENT_TIMEOUT_MS) || 20 * 60 * 1000

// When runAgent is called for pure text generation (CLAUDE.md / SOUL.md /
// skill-md / prompt expansion / memory categorization), the model must not
// Write the file itself -- otherwise it sometimes does, then returns a short
// "Kész, létrehoztam" status instead of the markdown content, silently
// corrupting the target file the caller goes on to write.
const DEFAULT_DISALLOWED_TOOLS = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Bash', 'Task']

// Result-event classification (issue #209). A usage-policy (AUP) block, an API
// error, or a max-turns/budget abort must NOT be propagated as if it were the
// generated content: the SDK can surface the block message in `result`, and a
// caller (generateClaudeMd / generateSoulMd / categorizeMemory, ...) would then
// write that block text straight into CLAUDE.md / SOUL.md, silently corrupting
// the file. We treat a result as USABLE only when it is a clean success
// (subtype 'success', is_error false, no api_error_status); anything else
// returns text=null -- so the callers' existing `if (!text) throw` guard fires
// -- plus a reason string for logging and an explicit caller signal.
//
// Scope note: we deliberately do NOT text-match soft model refusals ("I can't
// help with that") -- that is fragile and would false-positive on legitimate
// generated content. Hard safety/AUP blocks surface structurally via is_error /
// api_error_status / a non-success subtype, which is what we key on.
export interface AgentResultClassification {
  text: string | null
  blocked: boolean
  reason?: string
}

export function classifyAgentResult(event: {
  subtype?: string
  is_error?: boolean
  api_error_status?: number | null
  result?: unknown
  errors?: string[]
  stop_reason?: string | null
}): AgentResultClassification {
  const subtype = event.subtype
  const apiErr = event.api_error_status ?? null
  const isError = event.is_error === true
  if (subtype === 'success' && !isError && apiErr == null) {
    return { text: typeof event.result === 'string' ? event.result : null, blocked: false }
  }
  const bits: string[] = []
  if (subtype && subtype !== 'success') bits.push(`subtype=${subtype}`)
  if (isError) bits.push('is_error=true')
  if (apiErr != null) bits.push(`api_error_status=${apiErr}`)
  if (event.stop_reason) bits.push(`stop_reason=${event.stop_reason}`)
  if (Array.isArray(event.errors) && event.errors.length) {
    bits.push(`errors=${event.errors.slice(0, 3).join('; ').slice(0, 300)}`)
  }
  // A snippet of any policy/refusal text -- for the LOG only, never returned as content.
  if (typeof event.result === 'string' && event.result.trim()) {
    bits.push(`resultSnippet=${event.result.trim().slice(0, 200)}`)
  }
  return { text: null, blocked: true, reason: bits.join(' ') || 'unknown error result' }
}

// The bundled SDK's runtime libc detection picks the linux-x64-musl variant
// even on glibc Ubuntu/Debian/RHEL hosts, so its native binary fails to
// spawn ("ld-musl-* not found"). We pick the right subpackage ourselves and
// forward its absolute path through pathToClaudeCodeExecutable.
function detectLinuxLibc(): 'glibc' | 'musl' | 'unknown' {
  if (process.platform !== 'linux') return 'unknown'
  try {
    const out = execSync('ldd --version 2>&1', { encoding: 'utf-8' })
    return /musl/i.test(out) ? 'musl' : 'glibc'
  } catch {
    return 'unknown'
  }
}

let cachedClaudeCodeBin: string | undefined | null = null
function resolveClaudeCodeBin(): string | undefined {
  if (cachedClaudeCodeBin !== null) return cachedClaudeCodeBin
  if (process.env.CLAUDE_CODE_BIN) {
    cachedClaudeCodeBin = process.env.CLAUDE_CODE_BIN
    return cachedClaudeCodeBin
  }
  if (process.platform !== 'linux' || process.arch !== 'x64') {
    cachedClaudeCodeBin = undefined
    return undefined
  }
  const libc = detectLinuxLibc()
  if (libc === 'unknown') {
    cachedClaudeCodeBin = undefined
    return undefined
  }
  const variant = libc === 'musl' ? 'linux-x64-musl' : 'linux-x64'
  const bin = join(
    PROJECT_ROOT, 'node_modules', '@anthropic-ai',
    `claude-agent-sdk-${variant}`, 'claude',
  )
  cachedClaudeCodeBin = existsSync(bin) ? bin : undefined
  return cachedClaudeCodeBin
}

// Backend selector (jun.15 subscription migration). 'worker' (default) routes
// to a persistent INTERACTIVE Claude Code session in tmux (subscription login);
// 'sdk' keeps the legacy Agent SDK `query` path (API billing) as an emergency
// rollback via MARVEEN_AGENT_BACKEND=sdk.
function agentBackend(): 'worker' | 'sdk' {
  return (process.env.MARVEEN_AGENT_BACKEND || 'worker').toLowerCase() === 'sdk' ? 'sdk' : 'worker'
}

export async function runAgent(
  message: string,
  sessionId?: string,
  onTyping?: () => void,
  allowTools = false,
  cwd: string = PROJECT_ROOT,
  env?: Record<string, string | undefined>,
): Promise<{ text: string | null; newSessionId?: string; error?: string }> {
  if (agentBackend() === 'worker') {
    // The interactive worker is a single shared session with its own fixed,
    // isolated, NEUTRAL cwd/config -- so the SDK-era per-call cwd/env isolation
    // hacks (CLAUDE_CONFIG_DIR to dodge the telegram-plugin 409) are subsumed
    // and intentionally ignored here. resume/sessionId is unsupported (no caller
    // uses it). Dynamic import keeps the SDK module off the worker-path hot path
    // and avoids any load-order coupling.
    if (sessionId) logger.warn('runAgent(worker): resume/sessionId not supported on worker backend, ignoring')
    const { runViaWorker } = await import('./web/agent-worker.js')
    const { text, error } = await runViaWorker(message, AGENT_TIMEOUT_MS)
    return { text, error }
  }
  // --- legacy SDK path (rollback: MARVEEN_AGENT_BACKEND=sdk; API billing) ---
  let newSessionId: string | undefined
  let resultText: string | null = null
  let blockedReason: string | undefined

  const typingInterval = onTyping ? setInterval(onTyping, TYPING_REFRESH_MS) : undefined
  const abortController = new AbortController()
  const timeout = setTimeout(() => {
    logger.warn({ timeoutMs: AGENT_TIMEOUT_MS }, 'Agent timeout, megszakitas...')
    abortController.abort()
  }, AGENT_TIMEOUT_MS)

  const claudeCodeBin = resolveClaudeCodeBin()

  try {
    const events = query({
      prompt: message,
      options: {
        abortController,
        cwd,
        permissionMode: 'bypassPermissions',
        ...(claudeCodeBin ? { pathToClaudeCodeExecutable: claudeCodeBin } : {}),
        ...(allowTools ? {} : { disallowedTools: DEFAULT_DISALLOWED_TOOLS }),
        ...(sessionId ? { resume: sessionId } : {}),
        ...(env ? { env: { ...process.env, ...env } } : {}),
      },
    })

    for await (const event of events) {
      if (event.type === 'system' && 'subtype' in event && (event as any).subtype === 'init') {
        newSessionId = (event as any).sessionId as string
      }
      if (event.type === 'result') {
        const c = classifyAgentResult(event as any)
        if (c.blocked) {
          // AUP block / API error / max-turns: do NOT propagate as content
          // (issue #209). text=null trips the caller's `if (!text) throw`.
          blockedReason = c.reason
          resultText = null
          logger.error({ reason: c.reason }, 'runAgent: result blocked/errored -- not propagated as content (possible AUP block, issue #209)')
        } else {
          resultText = c.text
        }
      }
    }
  } catch (err: any) {
    if (err?.name === 'AbortError' || abortController.signal.aborted) {
      logger.warn('Agent megszakitva timeout miatt')
      const mins = Math.round(AGENT_TIMEOUT_MS / 60000)
      resultText = `A feldolgozas tullepte a ${mins} perces idokorlatot. Probald rovidebben megfogalmazni, vagy bontsd tobb lepesre.`
    } else {
      logger.error({ err }, 'Agent hiba')
      throw err instanceof Error ? err : new Error(String(err))
    }
  } finally {
    clearTimeout(timeout)
    if (typingInterval) clearInterval(typingInterval)
  }

  return { text: resultText, newSessionId, error: blockedReason }
}

import { query } from '@anthropic-ai/claude-code'
import { PROJECT_ROOT } from './config.js'

const TYPING_REFRESH_MS = 4000
import { logger } from './logger.js'

const AGENT_TIMEOUT_MS = 10 * 60 * 1000 // 10 minutes max (scheduler/session rotation)

export async function runAgent(
  message: string,
  sessionId?: string,
  onTyping?: () => void
): Promise<{ text: string | null; newSessionId?: string }> {
  let newSessionId: string | undefined
  let resultText: string | null = null

  const typingInterval = onTyping ? setInterval(onTyping, TYPING_REFRESH_MS) : undefined
  const abortController = new AbortController()
  const timeout = setTimeout(() => {
    logger.warn('Agent timeout (10 perc), megszakitas...')
    abortController.abort()
  }, AGENT_TIMEOUT_MS)

  try {
    const events = query({
      prompt: message,
      options: {
        abortController,
        cwd: PROJECT_ROOT,
        permissionMode: 'bypassPermissions',
        ...(sessionId ? { resume: sessionId } : {}),
      },
    })

    for await (const event of events) {
      if (event.type === 'system' && 'subtype' in event && (event as any).subtype === 'init') {
        newSessionId = (event as any).sessionId as string
      }
      if (event.type === 'result') {
        resultText = (event as any).result as string ?? null
      }
    }
  } catch (err: any) {
    if (err?.name === 'AbortError' || abortController.signal.aborted) {
      logger.warn('Agent megszakitva timeout miatt')
      resultText = 'A feldolgozas tullepte a 10 perces idokorlatos. Probald rovidebben megfogalmazni, vagy bontsd tobb lepesre.'
    } else {
      logger.error({ err }, 'Agent hiba')
      resultText = 'Hiba tortent a feldolgozas soran.'
    }
  } finally {
    clearTimeout(timeout)
    if (typingInterval) clearInterval(typingInterval)
  }

  return { text: resultText, newSessionId }
}

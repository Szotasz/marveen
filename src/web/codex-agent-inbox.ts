import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { agentDir } from './agent-config.js'
import { atomicWriteFileSync } from './atomic-write.js'

export interface CodexInboxEnvelope {
  id: string
  from: string | null
  content: string
  ts: number
  taskId: string | null
  sourceMessageId: number | null
}

export function codexInboxDir(name: string): string {
  return join(agentDir(name), 'inbox')
}

function envelopeFileId(envelope: CodexInboxEnvelope): string {
  if (envelope.sourceMessageId != null) return `message-${envelope.sourceMessageId}`
  return `event-${envelope.id.replace(/[^A-Za-z0-9_-]/g, '_')}`
}

/**
 * Durable, idempotent handoff from the dashboard router/scheduler to the
 * headless Codex process. Content is JSON data in a file, never shell text.
 */
export function enqueueCodexEnvelope(name: string, envelope: CodexInboxEnvelope): string {
  const inbox = codexInboxDir(name)
  mkdirSync(inbox, { recursive: true, mode: 0o700 })
  const path = join(inbox, `${envelopeFileId(envelope)}.json`)
  if (existsSync(path)) return path
  atomicWriteFileSync(path, JSON.stringify(envelope), { mode: 0o600 })
  return path
}

export function enqueueCodexScheduledPrompt(
  name: string,
  content: string,
  taskId: string,
  now = Date.now(),
): string {
  return enqueueCodexEnvelope(name, {
    id: randomUUID(),
    from: null,
    content,
    ts: now,
    taskId,
    sourceMessageId: null,
  })
}

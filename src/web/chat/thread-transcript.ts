// Chat-style timeline for a THREAD transcript. Differs from the #356
// agent-conversation parser on the inbound side: a thread session has no
// channel plugin, so the user's messages arrive as plain prompts (typed into
// the session by sendPromptToSession), not inside <channel> wrappers. Tool
// results, system-reminders and slash-command echoes also land as type=user
// lines and must be filtered out, otherwise they would render as fake user
// bubbles.
import { readFileSync } from 'node:fs'

export interface ThreadEntry {
  ts: string | null
  // user = the colleague's message; assistant = the agent's visible reply;
  // action = a tool the agent ran (rendered collapsed in the UI)
  kind: 'user' | 'assistant' | 'action'
  text: string
}

const MAX_TEXT = 6000
export const DEFAULT_TIMELINE_LIMIT = 400

function clip(s: string): string {
  return s.length > MAX_TEXT ? s.slice(0, MAX_TEXT) + ' …' : s
}

// Strip harness-injected blocks from a user prompt; if nothing user-authored
// remains, the line is not a real message.
function cleanUserText(raw: string): string {
  return raw
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/<command-name>[\s\S]*?<\/command-name>/g, '')
    .replace(/<command-message>[\s\S]*?<\/command-message>/g, '')
    .replace(/<command-args>[\s\S]*?<\/command-args>/g, '')
    .replace(/<local-command-stdout>[\s\S]*?<\/local-command-stdout>/g, '')
    .trim()
}

function actionLabel(name: string, input: Record<string, unknown>): string {
  const base = name.includes('__') ? name.split('__').pop()! : name
  const pick = (k: string): string => (typeof input[k] === 'string' ? (input[k] as string) : '')
  if (name === 'Bash') return `Bash: ${pick('description') || pick('command').slice(0, 80)}`
  if (name === 'Read') return `Read: ${pick('file_path')}`
  if (name === 'Write') return `Write: ${pick('file_path')}`
  if (name === 'Edit') return `Edit: ${pick('file_path')}`
  if (base === 'WebSearch') return `Web keresés: ${pick('query')}`
  if (base === 'WebFetch') return `Web lekérés: ${pick('url')}`
  return base
}

export function parseThreadTimeline(jsonl: string, limit = DEFAULT_TIMELINE_LIMIT): ThreadEntry[] {
  const entries: ThreadEntry[] = []
  for (const line of jsonl.split('\n')) {
    const t = line.trim()
    if (!t) continue
    let d: Record<string, unknown>
    try { d = JSON.parse(t) } catch { continue }
    const type = d['type']
    const ts = typeof d['timestamp'] === 'string' ? (d['timestamp'] as string) : null
    const msg = d['message'] as Record<string, unknown> | undefined
    if (!msg) continue

    if (type === 'user') {
      const content = msg['content']
      // tool_result feedback comes back as type=user with an array content --
      // not a human message. String content is the typed prompt.
      if (typeof content !== 'string') continue
      const text = cleanUserText(content)
      if (text) entries.push({ ts, kind: 'user', text: clip(text) })
      continue
    }

    if (type === 'assistant') {
      const content = msg['content']
      if (!Array.isArray(content)) continue
      for (const block of content as Array<Record<string, unknown>>) {
        if (block['type'] === 'text') {
          const txt = typeof block['text'] === 'string' ? (block['text'] as string).trim() : ''
          if (txt) entries.push({ ts, kind: 'assistant', text: clip(txt) })
        } else if (block['type'] === 'tool_use') {
          const name = typeof block['name'] === 'string' ? (block['name'] as string) : ''
          const input = (block['input'] as Record<string, unknown>) ?? {}
          entries.push({ ts, kind: 'action', text: actionLabel(name, input) })
        }
      }
    }
  }
  return entries.length > limit ? entries.slice(entries.length - limit) : entries
}

export function readThreadTimeline(transcriptPath: string, limit = DEFAULT_TIMELINE_LIMIT): ThreadEntry[] {
  let raw: string
  try {
    raw = readFileSync(transcriptPath, 'utf-8')
  } catch {
    return [] // no transcript yet: thread exists but has no first message
  }
  return parseThreadTimeline(raw, limit)
}

// Auto-title for a fresh thread from its first message, ChatGPT-style. Pure;
// the route applies it only while the stored title is empty.
export function deriveThreadTitle(firstMessage: string, maxLen = 60): string {
  const oneLine = firstMessage.replace(/\s+/g, ' ').trim()
  if (oneLine.length <= maxLen) return oneLine
  const cut = oneLine.slice(0, maxLen)
  const lastSpace = cut.lastIndexOf(' ')
  return (lastSpace > maxLen / 2 ? cut.slice(0, lastSpace) : cut) + '…'
}

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { json } from '../http-helpers.js'
import { agentDir, readAgentClaudeConfigDir } from '../agent-config.js'
import { projectsDirFor } from '../active-model.js'
import { isMainChannelsAgent } from '../main-agent.js'
import { PROJECT_ROOT } from '../../config.js'
import type { RouteContext } from './types.js'

// Read-only, human-readable conversation view for an agent. The dashboard
// terminal only mirrors the live tmux pane (no history, and it does not show
// the full Telegram traffic cleanly). The complete conversation lives in the
// Claude Code transcript (.jsonl): every inbound channel message, every
// outbound reply, and every action. We parse the newest session transcript
// into a chat-style timeline so an operator can actually review what happened
// -- and, for customer-hosted Marveens, support them. Read-only.

interface Entry {
  ts: string | null
  // in  = inbound channel (e.g. Telegram) message from the user
  // out = outbound message the agent sent back (reply/react/edit)
  // note = the agent's own narration text for that turn
  // action = a tool the agent ran (Bash, search, draft, ...)
  kind: 'in' | 'out' | 'note' | 'action'
  text: string
  label?: string
}

const MAX_TEXT = 6000
const DEFAULT_LIMIT = 400

function workingDirFor(name: string): string {
  return isMainChannelsAgent(name) ? PROJECT_ROOT : agentDir(name)
}

function newestTranscript(name: string): string | null {
  const configDir = isMainChannelsAgent(name) ? undefined : (readAgentClaudeConfigDir(name) ?? undefined)
  const dir = projectsDirFor(workingDirFor(name), configDir)
  try {
    if (!existsSync(dir)) return null
    const files = readdirSync(dir)
      .filter(f => f.endsWith('.jsonl'))
      .map(f => ({ f, m: statSync(join(dir, f)).mtimeMs }))
      .sort((a, b) => b.m - a.m)
    return files.length ? join(dir, files[0].f) : null
  } catch {
    return null
  }
}

const CHANNEL_RE = /<channel\b[^>]*>([\s\S]*?)<\/channel>/g

function clip(s: string): string {
  return s.length > MAX_TEXT ? s.slice(0, MAX_TEXT) + ' …' : s
}

// One-line human label for a non-messaging tool call.
function actionLabel(name: string, input: Record<string, unknown>): string {
  const base = name.includes('__') ? name.split('__').pop()! : name
  const pick = (k: string): string => (typeof input[k] === 'string' ? (input[k] as string) : '')
  if (name === 'Bash') return `Bash: ${pick('description') || pick('command').slice(0, 80)}`
  if (name === 'Read') return `Read: ${pick('file_path')}`
  if (name === 'Write') return `Write: ${pick('file_path')}`
  if (name === 'Edit') return `Edit: ${pick('file_path')}`
  if (base.includes('search_gmail')) return `Gmail keresés: ${pick('query')}`
  if (base.includes('draft_gmail')) return `Gmail draft: ${pick('subject')}`
  if (base.includes('send_gmail')) return `Email küldés: ${pick('subject')}`
  if (base.includes('import_to_google_doc')) return `Google Doc: ${pick('file_name')}`
  if (base.includes('import_to_google_slides')) return `Google Slides: ${pick('file_name')}`
  if (base === 'WebSearch') return `Web keresés: ${pick('query')}`
  if (base === 'WebFetch') return `Web lekérés: ${pick('url')}`
  if (base.includes('download_attachment')) return 'Csatolmány letöltés'
  return base
}

// Turn the newest transcript into a flat, chronological, readable timeline.
function buildTimeline(file: string, limit: number): Entry[] {
  const entries: Entry[] = []
  const raw = readFileSync(file, 'utf-8').split('\n')
  for (const line of raw) {
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
      const asText = typeof content === 'string' ? content : ''
      // Only surface real inbound channel messages; skip tool results,
      // system-reminders and slash-command echoes.
      if (asText.includes('<channel')) {
        let m: RegExpExecArray | null
        CHANNEL_RE.lastIndex = 0
        while ((m = CHANNEL_RE.exec(asText)) !== null) {
          const inner = m[1].trim()
          if (inner) entries.push({ ts, kind: 'in', text: clip(inner) })
        }
      }
      continue
    }

    if (type === 'assistant') {
      const content = msg['content']
      if (!Array.isArray(content)) continue
      for (const block of content as Array<Record<string, unknown>>) {
        const bt = block['type']
        if (bt === 'text') {
          const txt = typeof block['text'] === 'string' ? (block['text'] as string).trim() : ''
          if (txt) entries.push({ ts, kind: 'note', text: clip(txt) })
        } else if (bt === 'tool_use') {
          const name = typeof block['name'] === 'string' ? (block['name'] as string) : ''
          const input = (block['input'] as Record<string, unknown>) ?? {}
          if (name.endsWith('telegram__reply') || name.endsWith('__reply')) {
            const txt = typeof input['text'] === 'string' ? (input['text'] as string) : ''
            if (txt) entries.push({ ts, kind: 'out', text: clip(txt), label: 'válasz' })
          } else if (name.endsWith('telegram__react') || name.endsWith('__react')) {
            const emoji = typeof input['emoji'] === 'string' ? (input['emoji'] as string) : '?'
            entries.push({ ts, kind: 'out', text: emoji, label: 'reakció' })
          } else if (name.endsWith('telegram__edit_message') || name.endsWith('__edit_message')) {
            const txt = typeof input['text'] === 'string' ? (input['text'] as string) : ''
            entries.push({ ts, kind: 'out', text: clip(txt), label: 'szerkesztés' })
          } else {
            entries.push({ ts, kind: 'action', text: actionLabel(name, input) })
          }
        }
      }
      continue
    }
  }
  // Keep the most recent `limit` entries, oldest-first.
  return entries.length > limit ? entries.slice(entries.length - limit) : entries
}

export async function tryHandleAgentConversation(ctx: RouteContext): Promise<boolean> {
  const { res, path, method, url } = ctx
  const match = path.match(/^\/api\/agents\/([^/]+)\/conversation$/)
  if (!match || method !== 'GET') return false
  const name = decodeURIComponent(match[1])
  const limitRaw = Number(url.searchParams.get('limit'))
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 2000) : DEFAULT_LIMIT

  const file = newestTranscript(name)
  if (!file) { json(res, { agent: name, entries: [], note: 'Nincs még beszélgetés-előzmény ehhez az agenthez.' }); return true }
  try {
    const entries = buildTimeline(file, limit)
    json(res, { agent: name, sessionId: file.split('/').pop()?.replace('.jsonl', '') ?? null, count: entries.length, entries })
  } catch {
    json(res, { error: 'A beszélgetés feldolgozása nem sikerült' }, 500)
  }
  return true
}

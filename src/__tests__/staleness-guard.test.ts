// Staleness guard: the 2026-06-24 incident. A delayed/re-delivered "Küldd is el"
// (orphaned channel message replayed after a session restart) made a sub-agent
// send a client email via a raw API fallback. The guard warns the agent when an
// inbound <channel ts="..."> message was delivered long after it was sent so it
// re-confirms before irreversible/outward actions.
//
// Behavioural tests run the python hook as a subprocess (deterministic, no LLM).
// Static tests lock the wiring (template + scaffold migration + startup call).
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..', '..')
const HOOK = join(ROOT, 'scripts', 'hooks', 'staleness-guard.py')

function runHook(prompt: string): string {
  try {
    return execFileSync('python3', [HOOK], {
      input: JSON.stringify({ prompt }),
      encoding: 'utf-8',
    })
  } catch {
    return ''
  }
}

function tsAgoMinutes(min: number): string {
  const d = new Date(Date.now() - min * 60_000)
  return d.toISOString().replace(/\.\d+Z$/, 'Z')
}

function channel(ts: string, body = 'Küldd is el'): string {
  return `<channel source="plugin:telegram:telegram" chat_id="1" message_id="2" ts="${ts}">${body}</channel>`
}

describe('staleness-guard hook (behavioural)', () => {
  it('stays silent for a fresh message (well under threshold)', () => {
    expect(runHook(channel(tsAgoMinutes(0))).trim()).toBe('')
  })

  it('warns for a message delivered long after it was sent', () => {
    const out = runHook(channel(tsAgoMinutes(12)))
    expect(out).toContain('FRISSESSEG-FIGYELMEZTETES')
    expect(out.toLowerCase()).toContain('elavult')
  })

  it('stays silent when there is no channel block at all', () => {
    expect(runHook('sima belso heartbeat szoveg').trim()).toBe('')
  })

  it('stays silent (never throws) when the channel block has no ts attribute', () => {
    expect(runHook('<channel source="x" chat_id="1">hello</channel>').trim()).toBe('')
  })

  it('honours STALENESS_THRESHOLD_SEC override (90s -> 2min message warns)', () => {
    const out = execFileSync('python3', [HOOK], {
      input: JSON.stringify({ prompt: channel(tsAgoMinutes(2)) }),
      encoding: 'utf-8',
      env: { ...process.env, STALENESS_THRESHOLD_SEC: '90' },
    })
    expect(out).toContain('FRISSESSEG-FIGYELMEZTETES')
  })
})

describe('staleness-guard wiring (static)', () => {
  it('is registered as a UserPromptSubmit hook in the settings template', () => {
    const tpl = readFileSync(join(ROOT, 'templates', 'settings.json.template'), 'utf-8')
    const parsed = JSON.parse(tpl.replace(/\{\{PROJECT_ROOT\}\}/g, '/ROOT'))
    const ups = parsed.hooks?.UserPromptSubmit
    expect(Array.isArray(ups)).toBe(true)
    expect(JSON.stringify(ups)).toContain('staleness-guard.py')
  })

  it('ensureAgentStalenessHook merges idempotently (keyed on the script path)', () => {
    const src = readFileSync(join(ROOT, 'src', 'web', 'agent-scaffold.ts'), 'utf-8')
    expect(src).toContain('export function ensureAgentStalenessHook')
    // idempotency guard + non-clobbering merge into existing hooks
    expect(src).toContain("includes('staleness-guard.py')")
    expect(src).toContain('hooks.UserPromptSubmit = ups')
  })

  it('is backfilled into existing agents on startup', () => {
    const web = readFileSync(join(ROOT, 'src', 'web.ts'), 'utf-8')
    expect(web).toContain('ensureAgentStalenessHook')
  })
})

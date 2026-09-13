import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import {
  mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, statSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureIsolatedChannelConfigDir } from '../web/agent-process.js'
import { ensureAgentHooks } from '../web/agent-scaffold.js'
import { PROJECT_ROOT } from '../config.js'

// HOOKSTRIPFLEET913: #1307's isolated-config strip removes clone hooks on every
// respawn. Four channel hooks had NO project-scope writer (they only ever
// reached agents via the global ~/.claude clone), so the strip would drop them
// fleet-wide -- a functional loss on the channel-having sub-agents (jumanji,
// mira). The fix ports them into templates/settings.json.template, the
// strip-surviving layer that ensureAgentHooks writes into each agent's project
// scope. Marveen's conditions (msg 24600): effect-based proof (not
// registration), a mutant control that shows the loss without the change, and
// the strip-surviving layer (never the isolated dir).

const CHANNEL_HOOKS = [
  'telegram_progress.py',
  'telegram_progress_clear.py',
  'telegram_progress_reply_clear.py',
  'channel-image-resize.sh',
]

function hookBasenames(hooks: unknown): Set<string> {
  const out = new Set<string>()
  for (const arr of Object.values((hooks ?? {}) as Record<string, unknown>)) {
    for (const group of (arr as Array<{ hooks?: Array<{ command?: string }> }>)) {
      for (const h of group.hooks ?? []) {
        const m = (h.command ?? '').match(/\/([\w.+-]+\.(?:py|sh|mjs))\b/)
        if (m) out.add(m[1])
      }
    }
  }
  return out
}

describe('HOOKSTRIPFLEET913: the four channel hooks survive the #1307 strip', () => {
  // --- Condition 3: mutant control at the template level -------------------
  // The four hooks come ONLY from the template. The base (pre-fix) template
  // lacks them; the fixed template has them. No ensure* function in the
  // scaffold writes them, so the template is their sole source -- remove it and
  // every sub-agent loses them on the next strip.
  describe('mutant control: the template is the only source', () => {
    // git-independent: deriving the "before" from git HEAD is fragile (on a
    // committed branch / CI merge-ref HEAD already carries the fix). Instead
    // parse the SHIPPED template and build the pre-fix mutant in-test by
    // dropping the four; the delta between them must be exactly these four.
    function parsedTemplate(): { hooks?: unknown } {
      return JSON.parse(
        readFileSync(join(PROJECT_ROOT, 'templates', 'settings.json.template'), 'utf-8')
          .replace(/\{\{PROJECT_ROOT\}\}/g, '/x').replace(/\{\{BOT_NAME\}\}/g, 'B').replace(/\{\{WEB_PORT\}\}/g, '3420'),
      ) as { hooks?: unknown }
    }

    it('the shipped template carries all four; a mutant with them dropped carries none', () => {
      const now = hookBasenames(parsedTemplate().hooks)
      for (const h of CHANNEL_HOOKS) {
        expect(now.has(h), `shipped template must carry ${h}`).toBe(true)
      }
      // Build the pre-fix mutant: remove every group/entry that runs one of the
      // four, mirroring the template state before this change.
      const t = parsedTemplate() as { hooks: Record<string, Array<{ hooks?: Array<{ command?: string }> }>> }
      for (const ev of Object.keys(t.hooks)) {
        t.hooks[ev] = t.hooks[ev]
          .map((g) => ({ ...g, hooks: (g.hooks ?? []).filter((h) => !CHANNEL_HOOKS.some((c) => (h.command ?? '').includes(c))) }))
          .filter((g) => (g.hooks?.length ?? 0) > 0)
      }
      const mutant = hookBasenames(t.hooks)
      for (const h of CHANNEL_HOOKS) {
        expect(mutant.has(h), `mutant (pre-fix) template must lack ${h}`).toBe(false)
      }
      // And the mutant still carries the untouched governance hooks, so the
      // delta is exactly the four -- not a wholesale change.
      expect(mutant.has('provenance-gate.py'), 'mutant keeps governance hooks').toBe(true)
    })

    it('no ensure* scaffold function writes these hooks -- the template is the sole writer', () => {
      const scaffold = readFileSync(join(PROJECT_ROOT, 'src', 'web', 'agent-scaffold.ts'), 'utf-8')
      for (const h of CHANNEL_HOOKS) {
        // Registration forms only (path or quoted token), so a prose comment
        // like "preserves existing hooks like telegram_progress.py" does not
        // count -- a real writer would reference the script as `/name`,
        // `'name'` or `"name"`. There is none, which is why losing the
        // template loses the hook.
        const registered = scaffold.includes(`/${h}`) || scaffold.includes(`'${h}'`) || scaffold.includes(`"${h}"`)
        expect(registered, `${h} unexpectedly registered by agent-scaffold`).toBe(false)
      }
    })
  })

  // --- Condition 2 (integration): strip runs, project scope survives -------
  describe('strip + survival: a channel agent keeps the four in its project scope', () => {
    const PROBE = 'hsf913-probe'
    const probeDir = join(PROJECT_ROOT, 'agents', PROBE)
    let fakeHome: string
    let realHome: string | undefined

    beforeEach(() => {
      realHome = process.env.HOME
      fakeHome = mkdtempSync(join(tmpdir(), 'hsf913-'))
      process.env.HOME = fakeHome
      mkdirSync(join(fakeHome, '.claude'), { recursive: true })
      // The global clone-source still carries the four (as on the live host
      // before the prune) -- the strip must drop them from the clone.
      writeFileSync(join(fakeHome, '.claude', 'settings.json'), JSON.stringify({
        enabledPlugins: { 'telegram@claude-plugins-official': true },
        hooks: {
          UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'python3 /g/scripts/hooks/telegram_progress.py' }] }],
          PreToolUse: [{ matcher: 'Read', hooks: [{ type: 'command', command: 'bash /g/scripts/hooks/channel-image-resize.sh' }] }],
        },
      }))
      if (existsSync(join(probeDir, 'HANDOFF.md'))) throw new Error(`refusing: agents/${PROBE} looks live`)
      rmSync(probeDir, { recursive: true, force: true })
      mkdirSync(probeDir, { recursive: true })
    })
    afterEach(() => {
      process.env.HOME = realHome
      rmSync(fakeHome, { recursive: true, force: true })
      rmSync(probeDir, { recursive: true, force: true })
    })

    it('the clone is stripped, then ensureAgentHooks restores the four in project scope', () => {
      const cfg = ensureIsolatedChannelConfigDir(PROBE, 'telegram')
      expect(cfg).not.toBeNull()
      const cloneHooks = JSON.parse(readFileSync(join(cfg!, 'settings.json'), 'utf-8')).hooks
      expect(cloneHooks, 'strip: clone must carry no hooks').toBeUndefined()

      ensureAgentHooks(PROBE)
      const projectHooks = JSON.parse(
        readFileSync(join(probeDir, '.claude', 'settings.json'), 'utf-8'),
      ).hooks
      const names = hookBasenames(projectHooks)
      for (const h of CHANNEL_HOOKS) {
        expect(names.has(h), `project scope must carry ${h} after ensureAgentHooks`).toBe(true)
      }
    })
  })

  // --- Condition 2 (effect): the registered hooks actually DO their job ----
  describe('effect: the hooks fire, not just registered', () => {
    let tmp: string
    beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'hsf913-fx-')) })
    afterEach(() => rmSync(tmp, { recursive: true, force: true }))

    it('channel-image-resize.sh preserves the original and emits additionalContext for a >500KB inbox image', () => {
      const inbox = join(tmp, 'channels', 'telegram', 'inbox')
      mkdirSync(inbox, { recursive: true })
      const img = join(inbox, 'photo.jpg')
      writeFileSync(img, Buffer.alloc(600 * 1024, 0x20)) // 600KB, >500KB gate
      const event = JSON.stringify({ tool_name: 'Read', tool_input: { file_path: img } })
      const out = execFileSync('bash', [join(PROJECT_ROOT, 'scripts', 'hooks', 'channel-image-resize.sh')], {
        input: event, encoding: 'utf-8',
      })
      // Effect 1: the original is copied aside (context-protection contract).
      expect(existsSync(join(inbox, 'original', 'photo.jpg')), 'original preserved').toBe(true)
      // Effect 2: the agent is told, via additionalContext, where the full-res is.
      const parsed = JSON.parse(out) as { hookSpecificOutput?: { additionalContext?: string } }
      expect(parsed.hookSpecificOutput?.additionalContext ?? '').toContain('original')
    })

    it('channel-image-resize.sh is a clean no-op for a non-inbox Read (does nothing, exit 0)', () => {
      const f = join(tmp, 'plain.txt')
      writeFileSync(f, 'x')
      const event = JSON.stringify({ tool_name: 'Read', tool_input: { file_path: f } })
      const out = execFileSync('bash', [join(PROJECT_ROOT, 'scripts', 'hooks', 'channel-image-resize.sh')], {
        input: event, encoding: 'utf-8',
      })
      expect(out.trim()).toBe('') // no additionalContext, no work
    })

    it('telegram_progress.py fires on a telegram turn (debug log) and stays silent otherwise', () => {
      const sd = join(tmp, 'state')
      mkdirSync(sd, { recursive: true })
      const script = join(PROJECT_ROOT, 'scripts', 'hooks', 'telegram_progress.py')
      const run = (prompt: string): void => {
        execFileSync('python3', [script], {
          input: JSON.stringify({ prompt, session_id: 's1' }),
          env: { ...process.env, TELEGRAM_STATE_DIR: sd },
          encoding: 'utf-8',
        })
      }
      // Non-telegram prompt: returns before writing any debug log -> no effect.
      run('just a normal prompt with no channel block')
      const dbg = join(sd, 'progress', 'debug.log')
      expect(existsSync(dbg), 'no debug log for a non-telegram turn').toBe(false)
      // Telegram turn (no token in state dir -> stops at token(), but only AFTER
      // detecting the turn and logging blocks=1: that log line is the effect).
      run('<channel source="telegram" chat_id="42" message_id="7">hi</channel>')
      expect(existsSync(dbg), 'telegram turn produces a debug log').toBe(true)
      expect(readFileSync(dbg, 'utf-8')).toContain('blocks=1')
    })
  })
})

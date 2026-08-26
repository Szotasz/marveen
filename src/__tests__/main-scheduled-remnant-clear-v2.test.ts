import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'

// SCHEDCONTENTMATCH v2 (2026-08-22). The v1 content-match was live on 2026-08-21
// and the main box STILL wedged for 78 minutes (07:19:50-08:37:58). Two gaps:
//   (a) TTL/dispatch coupling -- the authorizing record expired after 15 min (and
//       a skipIfBusy-dropped tick never dispatched, so nothing was ever recorded);
//   (b) code-path coverage -- the stuck-input watcher decides the fate of a parked
//       main box WITHOUT consulting the matcher, and defers it forever as a
//       "possibly a human draft".
// v2 closes both: a TIME-INDEPENDENT corpus (the scheduled-task CONFIG prompts on
// disk + the static SCHEDULED_TASK_PREAMBLE) and the same Balogh-safe gate wired
// into the watcher path.
//
// The Balogh invariant is what every test here guards: ONLY a positive match may
// clear the main box. A real human/inter-agent reply must NEVER produce a single
// clearing keystroke, on ANY path.

const h = vi.hoisted(() => {
  const SEP = '─'.repeat(80)
  const FOOTER = '  ⏵⏵ bypass permissions on (shift+tab to cycle)'
  const mkPane = (line: string) => ['', SEP, '❯ ' + line, SEP, FOOTER].join('\n')
  return { mkPane, pane: '', calls: [] as string[][] }
})

vi.mock('node:child_process', async (orig) => ({
  ...(await orig() as object),
  execFileSync: vi.fn((_file: string, args?: string[]) => {
    if (Array.isArray(args)) {
      h.calls.push(args)
      if (args.includes('capture-pane')) return h.pane
      // Model a box that actually empties under the clearing keystrokes, so the
      // post-clear verification inside clearStaleParkedInput sees an empty box
      // and reports success (a pane that never empties is the "resisted clear"
      // case, covered by the watcher falling through to restart escalation).
      if (args.includes('send-keys') && (args.includes('C-u') || args.includes('C-k') || args.includes('C-a'))) {
        h.pane = h.mkPane('')
      }
    }
    return ''
  }),
}))
vi.mock('../notify.js', () => ({ notifyChannel: vi.fn(async () => {}), notifyTelegram: vi.fn(async () => {}) }))

import {
  DISPATCHED_PROMPT_TTL_MS,
  SCHED_MATCH_MIN_LEN,
  recordDispatchedScheduledPrompt,
  setScheduledTaskConfigPrompts,
  matchesDispatchedScheduledPrompt,
  __resetDispatchedScheduledPromptsForTest,
} from '../web/dispatched-scheduled-prompts.js'
import { SCHEDULED_TASK_PREAMBLE } from '../prompt-safety.js'
import { clearStaleParkedInput } from '../web/agent-process.js'
import { clearMainParkedScheduledRemnant } from '../web/channel-monitor.js'
import { MAIN_CHANNELS_SESSION } from '../web/main-agent.js'

let clock = 90_000_000
const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => clock)

function clearKeystrokes(): string[][] {
  return h.calls.filter(a => a.includes('send-keys') && (a.includes('C-u') || a.includes('C-k') || a.includes('C-a')))
}

// A realistic scheduled-task config prompt (the `prompt` field of task-config.json).
const CONFIG_PROMPT =
  'Proaktiv level-figyelo heartbeat. Nezd meg a Gmail postafiokot olvasatlan levelekert, ' +
  'szurd ki a promo/hirlevel feladokat, es a valaszra varo ANTEA-ugyeket vezesd fel a kanban tablara. ' +
  'Ha nincs erdemi olvasatlan level, maradj csendben.'

beforeEach(() => {
  h.calls.length = 0
  __resetDispatchedScheduledPromptsForTest()
  // Every test starts in a fresh cooldown window and a fresh unwedge episode.
  clock += 10 * 60 * 1000
})
afterAll(() => { nowSpy.mockRestore() })

describe('config-prompt corpus: time-independent match', () => {
  it('a fragment of a CURRENT config prompt matches with nothing recorded (skipIfBusy-dropped tick)', () => {
    setScheduledTaskConfigPrompts([CONFIG_PROMPT])
    const frag = 'szurd ki a promo/hirlevel feladokat, es a valaszra varo ANTEA-ugyeket'
    expect(matchesDispatchedScheduledPrompt(frag)).toBe(true)
  })

  it('still matches after the record TTL has elapsed many times over (the 78-minute wedge)', () => {
    setScheduledTaskConfigPrompts([CONFIG_PROMPT])
    const frag = 'szurd ki a promo/hirlevel feladokat, es a valaszra varo ANTEA-ugyeket'
    clock += 10 * DISPATCHED_PROMPT_TTL_MS
    expect(matchesDispatchedScheduledPrompt(frag)).toBe(true)
  })

  it('a fragment of the static SCHEDULED_TASK_PREAMBLE matches with an EMPTY corpus and no records', () => {
    // The dispatched text is PREAMBLE + prefix + wrapped body, so a mid-slice of
    // the preamble is a substring of NO config prompt (Masha pre-flag 87/1).
    const frag = SCHEDULED_TASK_PREAMBLE.replace(/\s+/g, ' ').trim().slice(60, 200)
    expect(frag.length).toBeGreaterThanOrEqual(SCHED_MATCH_MIN_LEN)
    clock += 10 * DISPATCHED_PROMPT_TTL_MS
    expect(matchesDispatchedScheduledPrompt(frag)).toBe(true)
  })

  it('BALOGH: a real reply is not in the corpus -> never matches', () => {
    setScheduledTaskConfigPrompts([CONFIG_PROMPT])
    expect(matchesDispatchedScheduledPrompt(
      'Igen, ird meg Baloghnak hogy a koporsot kedden szallitjuk, es kerd el a szamlazasi adatokat',
    )).toBe(false)
  })

  it('MIN_LEN is preserved on the config path: a short fragment can never authorize a clear', () => {
    setScheduledTaskConfigPrompts([CONFIG_PROMPT])
    const shortFrag = 'maradj csendben.'
    expect(shortFrag.length).toBeLessThan(SCHED_MATCH_MIN_LEN)
    expect(matchesDispatchedScheduledPrompt(shortFrag)).toBe(false)
  })

  it('the corpus is REPLACED each poll: a deleted task stops authorizing clears', () => {
    setScheduledTaskConfigPrompts([CONFIG_PROMPT])
    const frag = 'szurd ki a promo/hirlevel feladokat, es a valaszra varo ANTEA-ugyeket'
    expect(matchesDispatchedScheduledPrompt(frag)).toBe(true)
    setScheduledTaskConfigPrompts([])
    expect(matchesDispatchedScheduledPrompt(frag)).toBe(false)
  })

  it('a trivially short config prompt is dropped from the corpus', () => {
    setScheduledTaskConfigPrompts(['heartbeat'])
    expect(matchesDispatchedScheduledPrompt('heartbeat')).toBe(false)
  })

  it('the record path survives the raised TTL (2h) and still matches inside it', () => {
    expect(DISPATCHED_PROMPT_TTL_MS).toBe(2 * 60 * 60 * 1000)
    const body = '[Utemezett feladat: audit] ' + CONFIG_PROMPT
    recordDispatchedScheduledPrompt(body)
    clock += 60 * 60 * 1000 // 1h -- would have expired under the old 15min TTL
    expect(matchesDispatchedScheduledPrompt(CONFIG_PROMPT.slice(0, 120))).toBe(true)
  })
})

describe('entry point A -- clearStaleParkedInput (router janitor / schedule-runner)', () => {
  it('clears a config-matched remnant that is older than any record TTL', async () => {
    setScheduledTaskConfigPrompts([CONFIG_PROMPT])
    clock += 10 * DISPATCHED_PROMPT_TTL_MS
    h.pane = h.mkPane('Nezd meg a Gmail postafiokot olvasatlan levelekert, szurd ki a promo/hirlevel feladokat')
    await clearStaleParkedInput(MAIN_CHANNELS_SESSION)
    expect(clearKeystrokes().length).toBeGreaterThan(0)
  }, 20_000)

  it('BALOGH: a real parked reply stays escalate-only (not one clearing keystroke)', async () => {
    setScheduledTaskConfigPrompts([CONFIG_PROMPT])
    h.pane = h.mkPane('Noemi, a lengyel konzulatus visszairt, hetfon tudjak fogadni a 12 elhunytat')
    await clearStaleParkedInput(MAIN_CHANNELS_SESSION)
    expect(clearKeystrokes()).toHaveLength(0)
  }, 20_000)
})

describe('entry point B -- stuck-input watcher (channel-monitor human-draft defer)', () => {
  it('a config-matched remnant is routed to the Balogh-safe clear instead of being deferred', async () => {
    setScheduledTaskConfigPrompts([CONFIG_PROMPT])
    clock += 10 * DISPATCHED_PROMPT_TTL_MS
    h.pane = h.mkPane('es a valaszra varo ANTEA-ugyeket vezesd fel a kanban tablara. Ha nincs erdemi olvasatlan')
    const cleared = await clearMainParkedScheduledRemnant()
    expect(cleared).toBe(true)
    expect(clearKeystrokes().length).toBeGreaterThan(0)
  }, 20_000)

  it('BALOGH: a human draft is NOT cleared here -- the watcher keeps deferring it', async () => {
    setScheduledTaskConfigPrompts([CONFIG_PROMPT])
    h.pane = h.mkPane('Kerlek irj a temetkezesnek hogy a hamvasztas idopontjat tegyek at csutortokre')
    const cleared = await clearMainParkedScheduledRemnant()
    expect(cleared).toBe(false)
    expect(clearKeystrokes()).toHaveLength(0)
  }, 20_000)

  it('BALOGH: an empty box is a no-op (nothing parked -> nothing to clear)', async () => {
    h.pane = h.mkPane('')
    expect(await clearMainParkedScheduledRemnant()).toBe(false)
    expect(clearKeystrokes()).toHaveLength(0)
  }, 20_000)
})

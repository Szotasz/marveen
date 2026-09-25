import { describe, expect, it, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  beginRestart,
  endRestart,
  isRestartInFlight,
  __resetRestartLock,
} from '../web/restart-lock.js'

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..', 'web')
const src = (f: string): string => readFileSync(join(WEB, f), 'utf8')

/** Body of `name`'s function declaration, brace-matched (the IO-heavy modules
 *  cannot be imported here, so the wiring is pinned at the source). */
function fnBody(text: string, name: string): string {
  const m = new RegExp(`function ${name}\\s*\\(`).exec(text)
  expect(m, `${name} not found`).not.toBeNull()
  // Walk the signature to the body brace. A naive /\([^)]*\)[^{]*\{/ lands
  // inside the RETURN TYPE for a signature like
  // `(name: string, opts: { fresh?: boolean } = {}): Promise<{ ok: boolean }>`,
  // which silently yields a 60-char "body" that passes any .not.toMatch.
  let paren = 0
  let angle = 0
  let bodyStart = -1
  for (let i = m!.index; i < text.length; i++) {
    const c = text[i]
    if (c === '(') paren++
    else if (c === ')') paren--
    else if (paren === 0 && c === '<') angle++
    else if (paren === 0 && c === '>') angle--
    else if (paren === 0 && angle === 0 && c === '{') { bodyStart = i; break }
  }
  expect(bodyStart, `${name}: body brace not found`).toBeGreaterThan(-1)
  let depth = 0
  let end = text.length
  for (let i = bodyStart; i < text.length; i++) {
    if (text[i] === '{') depth++
    else if (text[i] === '}' && --depth === 0) { end = i; break }
  }
  return text.slice(m!.index, end + 1)
}

// RESTARTRACE901. stopAgentProcess kill-sessions the pane and then waits ~2s;
// for that window isAgentRunning() already answers false while the restart is
// only half done. Every liveness-driven supervisor polls that predicate, so it
// starts the agent with ITS options and beats the restarter to it. Measured on
// levente 2026-08-31 19:10 and 19:41: the context guard's { fresh: true }
// saturation rescue was overtaken both times by the reconcile path's default
// (--continue) start, which reloaded the 100%-context session the rescue
// existed to drop -- and the guard's own start then returned "Agent is already
// running" into a discarded result, so a rescue that healed nothing was filed
// as done. The two loops are phase-locked (270s+300s*k vs 30s+60s*m, and
// 300 % 60 === 0), so this fires on EVERY rescue, not occasionally.
describe('restart-lock -- the stop window is not an invitation to start', () => {
  beforeEach(() => __resetRestartLock())

  it('claims and releases a per-agent slot', () => {
    expect(isRestartInFlight('levente')).toBe(false)
    expect(beginRestart('levente')).toBe(true)
    expect(isRestartInFlight('levente')).toBe(true)
    endRestart('levente')
    expect(isRestartInFlight('levente')).toBe(false)
    expect(beginRestart('levente')).toBe(true) // reusable after release
  })

  it('refuses a second concurrent restart of the same agent', () => {
    expect(beginRestart('levente')).toBe(true)
    expect(beginRestart('levente')).toBe(false)
    // ...and the refusal did not consume the slot the first holder owns.
    endRestart('levente')
    expect(isRestartInFlight('levente')).toBe(false)
  })

  it('is per-agent, never global (one restart must not freeze the fleet)', () => {
    expect(beginRestart('levente')).toBe(true)
    expect(isRestartInFlight('hotblack')).toBe(false)
    expect(beginRestart('hotblack')).toBe(true)
  })

  it('BEHAVIOURAL: a liveness-polling supervisor stands down during the stop window', async () => {
    // Reproduction in miniature. `running` is the tmux truth; the restarter
    // flips it to false at kill-session and back to true only after its own
    // start, exactly like stopAgentProcess's 2s teardown wait.
    let running = true
    const started: string[] = []

    const restarter = async (): Promise<void> => {
      expect(beginRestart('levente')).toBe(true)
      try {
        running = false                       // kill-session
        await new Promise(r => setTimeout(r, 20))  // the teardown wait
        started.push('fresh')                 // startAgentProcess({ fresh: true })
        running = true
      } finally {
        endRestart('levente')
      }
    }
    const reconcile = async (): Promise<void> => {
      await new Promise(r => setTimeout(r, 10)) // ticks inside the window
      if (running) return
      if (isRestartInFlight('levente')) return  // <- the fix
      started.push('continue')
    }

    await Promise.all([restarter(), reconcile()])
    expect(started).toEqual(['fresh'])
  })

  it('NEGATIVE CONTROL: without the in-flight check the same tick starts a --continue session', async () => {
    // Pins that the assertion above is carried by the lock and not by timing:
    // the identical race, minus the one guard line, reproduces the defect.
    let running = true
    const started: string[] = []
    const restarter = async (): Promise<void> => {
      running = false
      await new Promise(r => setTimeout(r, 20))
      started.push('fresh')
      running = true
    }
    const reconcile = async (): Promise<void> => {
      await new Promise(r => setTimeout(r, 10))
      if (running) return
      started.push('continue')
    }
    await Promise.all([restarter(), reconcile()])
    expect(started).toEqual(['continue', 'fresh'])
  })
})

describe('restart-lock wiring (pinned at the source)', () => {
  it('restartAgentProcess holds the slot across BOTH stop and start, and releases in a finally', () => {
    const body = fnBody(src('agent-process.ts'), 'restartAgentProcess')
    expect(body).toContain('beginRestart(name)')
    expect(body).toContain('stopAgentProcess(name)')
    expect(body).toContain('startAgentProcess(name, opts)')
    // The release must be unconditional: a leaked slot silently disables every
    // liveness-driven auto-start for that agent for the life of the process.
    expect(body).toMatch(/finally\s*\{\s*endRestart\(name\)/)
    // ...and the stop must sit INSIDE the claim, not before it.
    expect(body.indexOf('beginRestart(name)')).toBeLessThan(body.indexOf('stopAgentProcess(name)'))
  })

  it('restartAgentProcess never reports a lost start race as success', () => {
    const body = fnBody(src('agent-process.ts'), 'restartAgentProcess')
    // The early "Agent is already running" return is the shape a lost race
    // takes; it must be logged loudly and returned as-is (ok:false), never
    // swallowed into a { ok: true }.
    expect(body).toMatch(/already running/i)
    expect(body).toContain('logger.error(')
    expect(body).not.toMatch(/return\s*\{\s*ok:\s*true/)
  })

  for (const [file, fn] of [
    ['channel-monitor.ts', 'reconcileDesiredAgents'],
    ['schedule-runner.ts', null],
    ['reauth-healer.ts', 'restartFirstRunGatedAgent'],
  ] as Array<[string, string | null]>) {
    it(`${file}: the autonomous start stands down while a managed restart is in flight`, () => {
      const text = src(file)
      const scope = fn ? fnBody(text, fn) : text
      expect(scope).toContain('isRestartInFlight(')
      // The check has to precede the start it is guarding.
      expect(scope.indexOf('isRestartInFlight(')).toBeLessThan(scope.indexOf('startAgentProcess('))
    })
  }
})

describe('context-guard: a failed rescue is not filed as a completed one', () => {
  const runner = src('context-guard-runner.ts')

  it('performRestart still asks for FRESH and now checks the result', () => {
    const body = fnBody(runner, 'performRestart')
    expect(body).toContain('restartAgentProcess(name, { fresh: true })')
    // The result was discarded before RESTARTRACE901; a discarded result is how
    // "Agent is already running" became a silent success.
    expect(body).toMatch(/if\s*\(!res\.ok\)\s*throw/)
    expect(body).not.toMatch(/^\s*await restartAgentProcess\(name, \{ fresh: true \}\)\s*$/m)
  })

  it('the restart action rolls the guard state back when the rescue fails', () => {
    const body = fnBody(runner, 'checkAgent')
    const i = body.indexOf('await performRestart(name)')
    expect(i).toBeGreaterThan(-1)
    const tail = body.slice(i)
    // guardStates.set(nextState) runs BEFORE the action switch, so without the
    // rollback the guard waits for a session it never started, prompts the old
    // saturated pane, and sits out its cooldown.
    expect(tail).toContain('guardStates.set(name, INITIAL_GUARD_STATE)')
    expect(tail).toContain('logger.error(')
    // The "I restarted it" notice must be unreachable on that path. Anchored on
    // the notice TEXT, not on createAgentMessage(: the failure path grew its own
    // message (the rescue-failure alert, RESCUEALERT901) and a bare call-name
    // anchor would now match that one and assert nothing.
    expect(tail.indexOf('guardStates.set(name, INITIAL_GUARD_STATE)'))
      .toBeLessThan(tail.indexOf('[CONTEXT-GUARD] Ujrainditottam'))
    expect(tail).toMatch(/rolled back[\s\S]*?\n\s*break/)
  })
})

// Fleet addition on top of the adopted batch: the channel-down auto-restart in
// channel-monitor.ts is itself a stop -> (8s settle) -> start unit, and the
// original batch left it outside the lock. Source-level pin with a FIXED
// window (a grown-to-fit anchor cannot fail): the claim must sit within the
// 24 lines before the stop call, and the release in a finally after it.
import { readFileSync as readSrcFile } from 'node:fs'
import { join as joinPath } from 'node:path'

describe('channel-down auto-restart holds the restart slot (fleet addition)', () => {
  const src = readSrcFile(joinPath(__dirname, '../web/channel-monitor.ts'), 'utf-8')
  const lines = src.split('\n')
  const stopIdx = lines.findIndex(l => l.includes('await stopAgentProcess(t.agentName!)'))

  it('claims the slot before its stop', () => {
    expect(stopIdx, 'the channel-down stop call disappeared').toBeGreaterThan(0)
    const before = lines.slice(Math.max(0, stopIdx - 24), stopIdx).join('\n')
    expect(before, 'channel-down restart no longer claims the restart slot')
      .toContain('beginRestart(t.agentName!)')
  })

  it('releases the slot in a finally after its start', () => {
    const after = lines.slice(stopIdx, stopIdx + 60).join('\n')
    expect(after, 'channel-down restart no longer releases the slot in a finally')
      .toMatch(/finally\s*\{[\s\S]{0,300}endRestart\(t\.agentName!\)/)
  })
})

// Second sweep of the same caller table (review catch, 2026-09-08): the two
// channel-config stop->start pairs in routes/agents.ts are the same shape as
// the channel-down restart and must hold the slot the same way. Pinned for
// EVERY occurrence of the stop anchor in that file, so a third copy-pasted
// pair cannot appear unguarded without failing here.
describe('channel-config stop->start pairs hold the restart slot (routes/agents.ts)', () => {
  const routesSrc = readSrcFile(joinPath(__dirname, '../web/routes/agents.ts'), 'utf-8')
  const routesLines = routesSrc.split('\n')
  const anchors = routesLines
    .map((l, i) => (l.includes('await stopAgentProcess(name)') && l.includes('stopRes') ? i : -1))
    .filter(i => i >= 0)

  it('finds both config-branch stop calls', () => {
    expect(anchors.length, 'expected exactly the two channel-config stop calls').toBe(2)
  })

  it('each claims the slot before its stop and releases it in a finally', () => {
    for (const idx of anchors) {
      const before = routesLines.slice(Math.max(0, idx - 16), idx).join('\n')
      expect(before, `stop at line ${idx + 1} is not gated on beginRestart`)
        .toContain('!beginRestart(name)')
      const after = routesLines.slice(idx, idx + 30).join('\n')
      expect(after, `stop at line ${idx + 1} has no finally endRestart`)
        .toMatch(/finally\s*\{[\s\S]{0,200}endRestart\(name\)/)
    }
  })
})

// Auto-wiring for Claude plan rotation: the heartbeat task seed
// (ensureRotationHeartbeatTask), its two trigger points (dashboard startup is a
// plain call; the Settings toggle is exercised through the real route here),
// and the readiness report behind GET /api/claude-plans/readiness.
//
// os.homedir() reads $HOME and SCHEDULED_TASKS_DIR is computed at import
// time, so HOME points at a throwaway dir BEFORE any module is imported: no
// test here can touch a real ~/.claude/scheduled-tasks.
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ClaudePlan } from '../web/claude-plans.js'

const tmpHome = mkdtempSync(join(tmpdir(), 'rotation-heartbeat-home-'))
const tmpRoot = mkdtempSync(join(tmpdir(), 'rotation-heartbeat-root-'))
const realHome = process.env.HOME
process.env.HOME = tmpHome

vi.mock('../config.js', () => ({
  PROJECT_ROOT: tmpRoot,
  STORE_DIR: join(tmpRoot, 'store'),
  MAIN_AGENT_ID: 'host-main',
  WEB_PORT: 3999,
  CHANNEL_CHAT_ID: '5550001',
}))

const settings = new Map<string, string>()
vi.mock('../settings-store.js', () => ({
  getEffectiveSettingValue: (k: string) => settings.get(k) ?? '',
  setOverride: (k: string, v: unknown) => { settings.set(k, String(v)); return { ok: true } },
}))

let plans: ClaudePlan[] = []
vi.mock('../web/claude-plans.js', () => ({ readClaudePlans: () => plans }))
let activePlanByAgent: Record<string, string> = {}
vi.mock('../web/claude-plans-state.js', () => ({ readClaudePlansState: () => ({ activePlanByAgent, plans: {} }) }))
vi.mock('../db.js', () => ({ logConfigChange: () => {} }))
vi.mock('../store-watcher.js', () => ({ setStoreWriteActor: () => {} }))

const io = await import('../web/scheduled-tasks-io.js')
const {
  ensureRotationHeartbeatTask, rotationReadiness, buildRotationHeartbeatPrompt,
  ROTATION_HEARTBEAT_TASK, ROTATION_HEARTBEAT_SCHEDULE,
} = await import('../web/claude-rotation-heartbeat.js')
const { tryHandleSettings } = await import('../web/routes/settings.js')

const taskDir = () => join(io.SCHEDULED_TASKS_DIR, ROTATION_HEARTBEAT_TASK)

function plan(id: string, channelsAllowed = true): ClaudePlan {
  return { id, label: id, tokenSecretId: `claude-plan-token-${id}`, planType: 'personal', channelsAllowed }
}

function fakePost(path: string, body: unknown): { ctx: any; out: { status: number; body: any } } {
  const out: { status: number; body: any } = { status: 0, body: null }
  const res: any = {
    writeHead(status: number) { out.status = status; return res },
    end(chunk?: string) { if (chunk) out.body = JSON.parse(chunk) },
  }
  const bodyStr = JSON.stringify(body)
  const req: any = {
    on(event: string, cb: (chunk?: Buffer) => void) {
      if (event === 'data') cb(Buffer.from(bodyStr))
      if (event === 'end') cb()
    },
  }
  return { ctx: { req, res, path, method: 'POST', url: new URL(`http://localhost${path}`) }, out }
}

beforeEach(() => {
  rmSync(io.SCHEDULED_TASKS_DIR, { recursive: true, force: true })
  settings.clear()
  plans = []
  activePlanByAgent = {}
})

afterAll(() => {
  process.env.HOME = realHome
  rmSync(tmpHome, { recursive: true, force: true })
  rmSync(tmpRoot, { recursive: true, force: true })
})

describe('ensureRotationHeartbeatTask', () => {
  it('rotation on, task missing: creates an enabled 10-minute heartbeat for the main agent', () => {
    settings.set('CLAUDE_ROTATION_ENABLED', '1')
    expect(ensureRotationHeartbeatTask()).toBe('created')
    const task = io.readScheduledTask(ROTATION_HEARTBEAT_TASK)!
    expect(task).toMatchObject({
      schedule: ROTATION_HEARTBEAT_SCHEDULE,
      agent: 'host-main',
      type: 'heartbeat',
      enabled: true,
    })
    expect(ROTATION_HEARTBEAT_SCHEDULE).toBe('*/10 * * * *')
    expect(task.prompt).toContain(`cd ${tmpRoot} && npx tsx scripts/claude-plan-rotate-check.ts`)
    expect(task.prompt).toContain('chat_id: 5550001')
  })

  it('rotation off: no-op, nothing written', () => {
    settings.set('CLAUDE_ROTATION_ENABLED', '0')
    expect(ensureRotationHeartbeatTask()).toBe('rotation-off')
    expect(existsSync(taskDir())).toBe(false)
  })

  it('never overwrites an existing task, even a disabled, hand-edited one', () => {
    settings.set('CLAUDE_ROTATION_ENABLED', '1')
    mkdirSync(taskDir(), { recursive: true })
    const skill = '---\nname: claude-plan-rotate-check\ndescription: mine\n---\n\noperator edited this\n'
    const cfg = JSON.stringify({ schedule: '*/30 * * * *', agent: 'host-main', enabled: false, type: 'heartbeat' })
    writeFileSync(join(taskDir(), 'SKILL.md'), skill)
    writeFileSync(join(taskDir(), 'task-config.json'), cfg)

    expect(ensureRotationHeartbeatTask()).toBe('exists')
    expect(readFileSync(join(taskDir(), 'SKILL.md'), 'utf-8')).toBe(skill)
    expect(readFileSync(join(taskDir(), 'task-config.json'), 'utf-8')).toBe(cfg)
  })

  it('startup path honors an operator deletion (tombstone); the Settings path does not', () => {
    settings.set('CLAUDE_ROTATION_ENABLED', '1')
    io.markDefaultTaskRemoved(ROTATION_HEARTBEAT_TASK)
    expect(ensureRotationHeartbeatTask({ respectRemoval: true })).toBe('removed-by-operator')
    expect(existsSync(taskDir())).toBe(false)
    expect(ensureRotationHeartbeatTask()).toBe('created')
    expect(io.readRemovedDefaultTasks().has(ROTATION_HEARTBEAT_TASK)).toBe(false)
  })
})

describe('POST /api/settings trigger', () => {
  it('turning CLAUDE_ROTATION_ENABLED on seeds the task', async () => {
    const { ctx, out } = fakePost('/api/settings', { key: 'CLAUDE_ROTATION_ENABLED', value: '1' })
    expect(await tryHandleSettings(ctx)).toBe(true)
    expect(out.status).toBe(200)
    expect(io.readScheduledTask(ROTATION_HEARTBEAT_TASK)?.enabled).toBe(true)
  })

  it('turning it off, or changing an unrelated key, seeds nothing', async () => {
    await tryHandleSettings(fakePost('/api/settings', { key: 'CLAUDE_ROTATION_ENABLED', value: '0' }).ctx)
    settings.set('CLAUDE_ROTATION_ENABLED', '1')
    await tryHandleSettings(fakePost('/api/settings', { key: 'CLAUDE_ROTATION_FLEET', value: '1' }).ctx)
    expect(existsSync(taskDir())).toBe(false)
  })
})

describe('buildRotationHeartbeatPrompt (the script contract)', () => {
  const prompt = buildRotationHeartbeatPrompt({ projectRoot: '/srv/m', webPort: 3420, chatId: '42' })

  it('ROTATE: the channel signal comes BEFORE the rotate call', () => {
    const signal = prompt.indexOf('ELŐSZÖR küldd el a jelzést')
    const call = prompt.indexOf('/api/claude-plans/rotate')
    expect(signal).toBeGreaterThan(-1)
    expect(call).toBeGreaterThan(signal)
  })

  it('the rotate payload is a quoted heredoc with targetPlanId, never -d "..." JSON', () => {
    expect(prompt).toContain("--data-binary @- <<'JSON'\n{\"targetPlanId\":\"<PLAN_ID>\"}\nJSON")
    expect(prompt).not.toMatch(/-d "\{/)
  })

  it('covers NO_ALTERNATIVE, FLEET_* (with failed= highlighted) and the silent empty case', () => {
    expect(prompt).toContain('NO_ALTERNATIVE')
    expect(prompt).toMatch(/FLEET_ROTATE.*FLEET_SKIPPED.*FLEET_FAILED/)
    expect(prompt).toContain('failed= NEM üres')
    expect(prompt).toContain('maradj teljesen csendben')
  })
})

describe('rotationReadiness', () => {
  function readyBaseline(): void {
    settings.set('CLAUDE_ROTATION_ENABLED', '1')
    settings.set('MAIN_AGENT_ISOLATED_CONFIG', '1')
    plans = [plan('a'), plan('b')]
    activePlanByAgent = { 'host-main': 'a' }
    ensureRotationHeartbeatTask()
  }

  it('all preconditions met: ready, no blockers', () => {
    readyBaseline()
    expect(rotationReadiness()).toEqual({ ready: true, blockers: [], details: [] })
  })

  it('rotation disabled', () => {
    readyBaseline()
    settings.set('CLAUDE_ROTATION_ENABLED', '0')
    expect(rotationReadiness().blockers).toEqual(['rotation_disabled'])
  })

  it('main agent not isolated (the measured 2026-09-26 case), with Hungarian text', () => {
    readyBaseline()
    settings.set('MAIN_AGENT_ISOLATED_CONFIG', '0')
    const r = rotationReadiness()
    expect(r.ready).toBe(false)
    expect(r.blockers).toEqual(['main_agent_not_isolated'])
    expect(r.details[0].message).toContain('MAIN_AGENT_ISOLATED_CONFIG')
  })

  it('an explicit MAIN_AGENT_CONFIG_DIR is its own blocker (it wins over any rotated plan)', () => {
    readyBaseline()
    settings.set('MAIN_AGENT_ISOLATED_CONFIG', '0')
    settings.set('MAIN_AGENT_CONFIG_DIR', '~/.claude-bot')
    expect(rotationReadiness().blockers).toEqual(['main_agent_explicit_config_dir'])
  })

  it('fewer than 2 channelsAllowed plans, however many are registered', () => {
    readyBaseline()
    plans = [plan('a'), plan('b', false), plan('c', false)]
    expect(rotationReadiness().blockers).toEqual(['too_few_channel_plans'])
  })

  it('no recorded active plan for the main agent (the first-assignment gap)', () => {
    readyBaseline()
    activePlanByAgent = { 'some-sub-agent': 'a' }
    const r = rotationReadiness()
    expect(r.blockers).toEqual(['no_active_plan'])
    expect(r.details[0].message).toContain('Váltás erre a planre')
  })

  it('an active plan id that is no longer registered counts as none', () => {
    readyBaseline()
    activePlanByAgent = { 'host-main': 'deleted-plan' }
    expect(rotationReadiness().blockers).toEqual(['no_active_plan'])
  })

  it('heartbeat task missing', () => {
    readyBaseline()
    rmSync(taskDir(), { recursive: true, force: true })
    expect(rotationReadiness().blockers).toEqual(['heartbeat_task_missing'])
  })

  it('heartbeat task disabled', () => {
    readyBaseline()
    io.writeScheduledTask(ROTATION_HEARTBEAT_TASK, { enabled: false })
    expect(rotationReadiness().blockers).toEqual(['heartbeat_task_disabled'])
  })
})

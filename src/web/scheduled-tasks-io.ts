import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { MAIN_AGENT_ID } from '../config.js'
import { atomicWriteFileSync } from './atomic-write.js'

export const SCHEDULED_TASKS_DIR = join(homedir(), '.claude', 'scheduled-tasks')

// Hard cap on the prompt length for a scheduled task, to stop a malicious
// or accidentally-huge POST body from exhausting the target agent's
// token budget (and wedging the tmux send-keys paste detector). 50,000
// characters is ~12k tokens of English, which is already far beyond any
// legitimate schedule prompt -- real ones are usually <1k chars.
export const MAX_SCHEDULED_TASK_PROMPT_LEN = 50_000

export interface ScheduledTask {
  name: string
  description: string
  prompt: string
  schedule: string
  agent: string
  enabled: boolean
  createdAt: number
  // task = wake an LLM agent with the SKILL.md prompt; heartbeat = same but
  // silent unless important; command = run a raw shell command, no LLM/tmux
  // (see command-task.ts). A `command` task is defined entirely by the
  // command/timeoutMs/failThreshold fields below -- it has no SKILL.md.
  type?: 'task' | 'heartbeat' | 'command'
  // When true, a tick whose target session is busy is dropped silently
  // instead of queued. Use ONLY for cron schedules that fire often enough
  // (every 30-60 min) that losing a single tick is harmless because the
  // next one is already on the way. Daily/weekly schedules must keep
  // skipIfBusy false (default) so the queue + alert path catches a
  // long-running busy state and nothing business-critical is lost.
  skipIfBusy?: boolean
  // When true, skip the busy-state check entirely and inject the prompt
  // via tmux send-keys regardless. The Claude session will process it at
  // the next idle slot. Useful for critical tasks that must never be
  // deferred to a retry queue (e.g. daily briefings, heartbeats during
  // active conversations).
  forceSend?: boolean
  // Override the default tmux session name derived from the agent. When
  // set, the scheduler targets this exact tmux session instead of
  // `agent-<name>` or MAIN_CHANNELS_SESSION. Enables dedicated
  // scheduler-only sessions in the future.
  targetSession?: string
  // command-type only: the raw shell command, run via `bash -lc`. No LLM,
  // no tmux, no target agent.
  command?: string
  // command-type only: hard timeout in ms (default 10000). A timeout counts
  // as a failure.
  timeoutMs?: number
  // command-type only: consecutive failures before a Telegram alert fires
  // (default 2). One alert per outage, one recovery when it clears.
  failThreshold?: number
}

function readFileOr(path: string, fallback: string): string {
  try { return readFileSync(path, 'utf-8') } catch { return fallback }
}

export function parseSkillMdFrontmatter(content: string): { name?: string; description?: string; body: string } {
  const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/)
  if (!fmMatch) return { body: content }
  const yaml = fmMatch[1]
  const body = fmMatch[2].trim()
  const nameMatch = yaml.match(/^name:\s*(.+)$/m)
  const descMatch = yaml.match(/^description:\s*(.+)$/m)
  return {
    name: nameMatch?.[1]?.trim(),
    description: descMatch?.[1]?.trim(),
    body,
  }
}

export function readScheduledTask(taskName: string): ScheduledTask | null {
  const dir = join(SCHEDULED_TASKS_DIR, taskName)
  const skillPath = join(dir, 'SKILL.md')
  const configPath = join(dir, 'task-config.json')
  let config: { schedule?: string; agent?: string; enabled?: boolean; createdAt?: number; type?: string; skipIfBusy?: boolean; forceSend?: boolean; targetSession?: string; command?: string; timeoutMs?: number; failThreshold?: number } = {}
  try {
    config = JSON.parse(readFileOr(configPath, '{}'))
  } catch { /* use defaults */ }

  // command-type tasks are defined entirely by task-config.json (no prompt,
  // no agent) and therefore have no SKILL.md. Every other type requires one.
  if (!existsSync(skillPath) && config.type !== 'command') return null

  const skillContent = readFileOr(skillPath, '')
  const { name, description, body } = parseSkillMdFrontmatter(skillContent)

  return {
    name: name || taskName,
    description: description || '',
    prompt: body,
    schedule: config.schedule || '0 9 * * *',
    agent: config.agent || MAIN_AGENT_ID,
    enabled: config.enabled !== false,
    createdAt: config.createdAt || 0,
    type: (config.type as 'task' | 'heartbeat' | 'command') || 'task',
    skipIfBusy: config.skipIfBusy === true,
    forceSend: config.forceSend === true,
    targetSession: config.targetSession || undefined,
    command: config.command,
    timeoutMs: config.timeoutMs,
    failThreshold: config.failThreshold,
  }
}

export function listScheduledTasks(): ScheduledTask[] {
  if (!existsSync(SCHEDULED_TASKS_DIR)) return []
  const dirs = readdirSync(SCHEDULED_TASKS_DIR).filter(f => {
    try { return statSync(join(SCHEDULED_TASKS_DIR, f)).isDirectory() } catch { return false }
  })
  const tasks: ScheduledTask[] = []
  for (const d of dirs) {
    const task = readScheduledTask(d)
    if (task) tasks.push(task)
  }
  return tasks.sort((a, b) => b.createdAt - a.createdAt)
}

export function writeScheduledTask(
  taskName: string,
  data: { description?: string; prompt?: string; schedule?: string; agent?: string; enabled?: boolean; type?: string; skipIfBusy?: boolean; forceSend?: boolean; targetSession?: string; command?: string; timeoutMs?: number; failThreshold?: number },
): void {
  const dir = join(SCHEDULED_TASKS_DIR, taskName)
  mkdirSync(dir, { recursive: true })

  const skillPath = join(dir, 'SKILL.md')
  const configPath = join(dir, 'task-config.json')

  // Read existing if updating
  const existing = readScheduledTask(taskName)
  const type = data.type ?? existing?.type ?? 'task'

  // Write SKILL.md -- but command-type tasks have no prompt/agent, so they get
  // no SKILL.md (they are defined entirely by task-config.json).
  if (type !== 'command') {
    const desc = data.description ?? existing?.description ?? ''
    const prompt = data.prompt ?? existing?.prompt ?? ''
    const skillContent = `---\nname: ${taskName}\ndescription: ${desc}\n---\n\n${prompt}\n`
    atomicWriteFileSync(skillPath, skillContent)
  }

  // Write/update config
  let config: Record<string, unknown> = {}
  try { config = JSON.parse(readFileOr(configPath, '{}')) } catch { /* use empty */ }
  if (data.schedule !== undefined) config.schedule = data.schedule
  if (data.agent !== undefined) config.agent = data.agent
  if (data.enabled !== undefined) config.enabled = data.enabled
  if (data.type !== undefined) config.type = data.type
  if (data.skipIfBusy !== undefined) config.skipIfBusy = data.skipIfBusy
  if (data.forceSend !== undefined) config.forceSend = data.forceSend
  if (data.targetSession !== undefined) config.targetSession = data.targetSession
  if (data.command !== undefined) config.command = data.command
  if (data.timeoutMs !== undefined) config.timeoutMs = data.timeoutMs
  if (data.failThreshold !== undefined) config.failThreshold = data.failThreshold
  if (!config.createdAt) config.createdAt = Math.floor(Date.now() / 1000)
  atomicWriteFileSync(configPath, JSON.stringify(config, null, 2))
}

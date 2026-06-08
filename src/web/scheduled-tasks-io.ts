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
  type?: 'task' | 'heartbeat' | 'command'  // heartbeat = silent unless important; command = raw shell, no LLM
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
  // type='command' only: raw shell command run via `bash -lc`, no LLM/tmux.
  command?: string
  // type='command' only: command timeout in ms (default 10000).
  timeoutMs?: number
  // type='command' only: consecutive failures before a Telegram alert (default 2).
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
  const hasSkill = existsSync(skillPath)
  // command-type tasks have no SKILL.md; they are defined entirely by
  // task-config.json. Only bail if neither file exists.
  if (!hasSkill && !existsSync(configPath)) return null

  const skillContent = hasSkill ? readFileOr(skillPath, '') : ''
  const { name, description, body } = parseSkillMdFrontmatter(skillContent)

  let config: { schedule?: string; agent?: string; enabled?: boolean; createdAt?: number; type?: string; skipIfBusy?: boolean; forceSend?: boolean; targetSession?: string; description?: string; command?: string; timeoutMs?: number; failThreshold?: number } = {}
  try {
    config = JSON.parse(readFileOr(configPath, '{}'))
  } catch { /* use defaults */ }

  return {
    name: name || taskName,
    description: description || config.description || '',
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

  // Write SKILL.md
  const desc = data.description ?? existing?.description ?? ''
  const prompt = data.prompt ?? existing?.prompt ?? ''
  const skillContent = `---\nname: ${taskName}\ndescription: ${desc}\n---\n\n${prompt}\n`
  atomicWriteFileSync(skillPath, skillContent)

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
  if (data.description !== undefined) config.description = data.description
  if (!config.createdAt) config.createdAt = Math.floor(Date.now() / 1000)
  atomicWriteFileSync(configPath, JSON.stringify(config, null, 2))
}

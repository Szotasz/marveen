import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { expandAndValidateConfigDir } from '../config-dir-path.js'
import { atomicWriteFileSync } from './atomic-write.js'

export type AgentEngine = 'claude' | 'codex'
export interface AgentEngineConfig { engine: AgentEngine; codexConfigDir: string | null }

export function resolveAgentEngine(value: unknown): AgentEngine {
  if (value === undefined || value === '' || value === 'claude') return 'claude'
  if (value === 'codex') return 'codex'
  throw new Error('engine must be claude or codex')
}

export function resolveCodexConfigDir(raw: unknown): string | null {
  return typeof raw === 'string' && isAbsolute(raw) ? expandAndValidateConfigDir(raw, '') : null
}

export function validateAgentEngine(config: Record<string, unknown>, hasChannel = false): AgentEngineConfig {
  const engine = resolveAgentEngine(config.engine)
  const raw = config.codexConfigDir
  let codexConfigDir: string | null = null
  if (raw !== undefined && raw !== null && raw !== '') {
    if (!resolveCodexConfigDir(raw)) {
      throw new Error('codexConfigDir must be an absolute, shell-safe config directory without parent traversal')
    }
    codexConfigDir = resolveCodexConfigDir(raw)
  }
  if (engine === 'codex') {
    if (!codexConfigDir) throw new Error('codexConfigDir is required for engine=codex')
    const bindings = Object.entries(config).some(([key, value]) =>
      /channel|telegram|teams|slack|discord|googlechat|gromzo/i.test(key) &&
      value !== undefined && value !== null && value !== false && value !== '' &&
      !(Array.isArray(value) && value.length === 0))
    if (hasChannel || bindings) throw new Error('Codex agents cannot own channel bindings')
    if (config.remoteHost || config.runAsUser) throw new Error('Codex pilot agents must run locally as the dashboard user')
  }
  return { engine, codexConfigDir }
}

export const CHANNEL_SCRUB_VARS = ['TELEGRAM_BOT_TOKEN', 'SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN', 'DISCORD_BOT_TOKEN', 'TELEGRAM_STATE_DIR', 'SLACK_STATE_DIR', 'DISCORD_STATE_DIR', 'GOOGLECHAT_STATE_DIR', 'TEAMS_STATE_DIR'] as const
export const CHANNEL_TOKEN_UNSET = `unset ${CHANNEL_SCRUB_VARS.join(' ')}`

export function renderCodexConfig(workspace: string, servers: Record<string, unknown>): string {
  const lines = ['sandbox_mode = "danger-full-access"', 'approval_policy = "never"',
    '', '[notice]', 'hide_full_access_warning = true', '',
    `[projects.${JSON.stringify(workspace)}]`, 'trust_level = "trusted"', '', '[mcp_servers]']
  for (const [name, raw] of Object.entries(servers)) {
    const server = raw as { command?: string; args?: string[]; env?: Record<string, string>; cwd?: string }
    if (!server?.command) throw new Error('Codex pilot requires inherited stdio MCP servers')
    lines.push('', `[mcp_servers.${JSON.stringify(name)}]`, `command = ${JSON.stringify(server.command)}`)
    if (server.args) lines.push(`args = ${JSON.stringify(server.args)}`)
    if (server.cwd) lines.push(`cwd = ${JSON.stringify(server.cwd)}`)
    if (server.env) {
      const forwarded = Object.entries(server.env).filter(([key, value]) => value === '${' + key + '}').map(([key]) => key)
      if (forwarded.length) lines.push(`env_vars = ${JSON.stringify(forwarded)}`)
      const literal = Object.entries(server.env).filter(([key]) => !forwarded.includes(key))
      if (literal.length) {
        lines.push(`[mcp_servers.${JSON.stringify(name)}.env]`)
        for (const [key, value] of literal) {
          const expanded = value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, variable: string) => {
            if (/^(CLAUDE|ANTHROPIC)/.test(variable) || CHANNEL_SCRUB_VARS.some(key => key === variable)) {
              throw new Error(`MCP environment variable ${variable} is withheld from Codex agents`)
            }
            if (process.env[variable] === undefined) throw new Error(`Missing MCP environment variable: ${variable}`)
            return process.env[variable]!
          })
          lines.push(`${JSON.stringify(key)} = ${JSON.stringify(expanded)}`)
        }
      }
    }
  }
  return `${lines.join('\n')}\n`
}

export function preflightCodexHome(home: string, workspace: string, servers: Record<string, unknown>): void {
  if (existsSync(join(home, 'config.toml'))) return
  renderCodexConfig(workspace, servers)
}

/** Seed only once: operator edits remain the source of truth on subsequent starts. */
export function scaffoldCodexHome(home: string, workspace: string, servers: Record<string, unknown>): void {
  const configPath = join(home, 'config.toml')
  const config = existsSync(configPath) ? null : renderCodexConfig(workspace, servers)
  mkdirSync(home, { recursive: true, mode: 0o700 })
  chmodSync(home, 0o700)
  if (config !== null) {
    try {
      writeFileSync(configPath, config, { mode: 0o600, flag: 'wx' })
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
    }
  }
  syncCodexInstructions(workspace)
}

export function syncCodexInstructions(workspace: string): void {
  const source = join(workspace, 'CLAUDE.md')
  if (existsSync(source)) atomicWriteFileSync(join(workspace, 'AGENTS.md'), readFileSync(source))
}

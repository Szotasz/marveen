/**
 * The main agent's co-listen plugins are enabled through a launch-time
 * --settings file, never through a settings layer the sub-agents also read.
 * Twin of scripts/main-extra-plugins-settings.sh (same file, same content);
 * see its header for the measurement (SLACKDMVESZT1006).
 *
 * The same file carries the main agent's sender-role gate when
 * store/main-agent-config.json sets `senderRoleGate` (MIOAPPTEAMSRV1025): the
 * main session serves its owner and a team chat (gromzo, MXD_SCOPE=both) in
 * one session, and a launch flag is the one place only the main session reads.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { senderRoleGatePolicyArg } from './agent-config.js'
import { pythonHookCommand } from './agent-scaffold.js'

export function mainExtraPluginsSettingsPath(installDir: string): string {
  return join(installDir, 'store', '.main-extra-plugins.settings.json')
}

/** The main agent's own agent-config.json counterpart (gitignored, per install). */
export function mainAgentConfigPath(installDir: string): string {
  return join(installDir, 'store', 'main-agent-config.json')
}

/**
 * The policy for a main-agent-config.json that exists but cannot be read as a JSON object (a
 * truncated write, a hand edit): a value the gate classifies as malformed, so it is wired and
 * every tool is denied in a non-owner's turn (Dani 50508 (1)). Unlike a sub-agent's broken
 * agent-config.json, the main session may carry the team chat, so a broken table must not
 * mean no gate.
 */
export const UNREADABLE_POLICY = Buffer.from(JSON.stringify('unreadable'), 'utf-8').toString('base64url')

/** The gate's --policy for the main agent: null with no file or the gate off; UNREADABLE_POLICY for a broken file. */
export function readMainSenderRoleGatePolicy(installDir: string): string | null {
  let raw: string
  try {
    // Strict UTF-8 and the BOM kept, as the shell twin's python reads it: an undecodable file is unreadable.
    raw = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(readFileSync(mainAgentConfigPath(installDir)))
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ENOENT' ? null : UNREADABLE_POLICY
  }
  try {
    const cfg: unknown = JSON.parse(raw)
    if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) return UNREADABLE_POLICY
    return senderRoleGatePolicyArg(cfg)
  } catch {
    return UNREADABLE_POLICY
  }
}

/** The PreToolUse entry: the same fail-closed command shape as the tracked project hooks. */
export function mainSenderRoleGateEntry(policy: string): { matcher: string; hooks: Array<{ type: string; command: string; timeout: number }> } {
  const command = pythonHookCommand('$CLAUDE_PROJECT_DIR/scripts/hooks/sender-role-gate.py', ['--policy', policy])
  return { matcher: '*', hooks: [{ type: 'command', command, timeout: 10 }] }
}

type MainSettings = { enabledPlugins: Record<string, true>; hooks?: { PreToolUse: Array<ReturnType<typeof mainSenderRoleGateEntry>> } }

/** Pure: the settings object the flag file carries. */
export function mainExtraPluginsSettings(pluginIds: readonly string[], gatePolicy: string | null = null): MainSettings {
  const enabledPlugins: Record<string, true> = {}
  for (const id of pluginIds) if (id) enabledPlugins[id] = true
  return gatePolicy ? { enabledPlugins, hooks: { PreToolUse: [mainSenderRoleGateEntry(gatePolicy)] } } : { enabledPlugins }
}

/**
 * Write the file and return its path, or null when there are no extras and no
 * gate (the launch then carries no flag at all). A write failure returns null
 * too: the session still starts, as it did before this flag existed.
 */
export function writeMainExtraPluginsSettings(installDir: string, pluginIds: readonly string[]): string | null {
  const ids = pluginIds.filter(Boolean)
  const policy = readMainSenderRoleGatePolicy(installDir)
  if (ids.length === 0 && !policy) return null
  const path = mainExtraPluginsSettingsPath(installDir)
  try {
    mkdirSync(join(installDir, 'store'), { recursive: true })
    const tmp = `${path}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(mainExtraPluginsSettings(ids, policy), null, 2) + '\n')
    renameSync(tmp, path)
    return path
  } catch {
    return null
  }
}

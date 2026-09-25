import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PROJECT_ROOT } from '../config.js'

// Each profile is a JSON file under templates/profiles/ with an allow/deny
// list that Claude Code's native permissions engine understands. Choosing a
// strict profile also drops --dangerously-skip-permissions, so Claude Code
// enforces the allow/deny list rather than bypassing it. Channels plugin
// permission prompts (the Telegram Allow/Deny inline buttons) still fire
// because they live on a different notification channel.
export interface ProfileTemplate {
  id: string
  label: string
  description: string
  permissionMode: 'strict' | 'permissive'
  filesystem: { allow: string[]; deny: string[] }
  // Directories OUTSIDE the agent's own working directory that it may touch.
  // MEASURED 2026-09-06 (gembaecho): an `allow` entry alone is NOT enough for a
  // path outside the agent cwd -- Claude Code asks for approval on every single
  // `ls`/`cat`/`grep`/Write against it even when `Bash(ls:*)` and
  // `Read(<path>/**)` are both allowlisted. The extra scope has to be declared
  // as `permissions.additionalDirectories`; with it the identical command runs
  // silently. Placeholders (${AGENT_DIR}, ${HOME}) are resolved like the
  // allow/deny lists. Optional -- a profile that stays inside its own dir
  // needs none.
  additionalDirectories?: string[]

  // ---- Opt-in house rules (default OFF) --------------------------------
  // Two things the fleet that built this repo runs on, which are OUR process
  // and not part of the product: the destructive-command PreToolUse gate and
  // the THIN CHIEF handoff section injected into an agent's CLAUDE.md. A
  // downstream install has its own review culture and its own idea of what an
  // agent may delete, so shipping either one switched on would be imposing a
  // process, not providing a capability.
  //
  // Absent == false on purpose: an install that never heard of these gets
  // neither, and no template edit is needed to stay that way. Turning one on
  // is a deliberate, per-profile decision. (PR #1357 review, Szabolcs.)
  //
  // Switching either OFF does not strip it from an agent that already has it:
  // writeAgentSettingsFromProfile merges into the existing settings.json and
  // ensureThinChiefHandoffSection only ever appends, so the flags govern what
  // is APPLIED from here on, not a retroactive teardown. Removing a gate from
  // a live agent stays a deliberate, separate act.
  destructiveGate?: boolean
  thinChiefHandoff?: boolean
}

/** Absent or non-true == off. Keeps the default in ONE place. */
export function profileWantsDestructiveGate(p: ProfileTemplate | null | undefined): boolean {
  return p?.destructiveGate === true
}

export function profileWantsThinChiefHandoff(p: ProfileTemplate | null | undefined): boolean {
  return p?.thinChiefHandoff === true
}

export const PROFILES_DIR = join(PROJECT_ROOT, 'templates', 'profiles')

export const HARDCODED_DEFAULT_PROFILE: ProfileTemplate = {
  id: 'default',
  label: 'Alapértelmezett',
  description: 'Permissive fallback.',
  permissionMode: 'permissive',
  filesystem: { allow: [], deny: ['mcp__claude_ai_Supabase__*'] },
}

export function listProfileTemplates(): ProfileTemplate[] {
  if (!existsSync(PROFILES_DIR)) return [HARDCODED_DEFAULT_PROFILE]
  const out: ProfileTemplate[] = []
  for (const f of readdirSync(PROFILES_DIR)) {
    if (!f.endsWith('.json')) continue
    try {
      const p = JSON.parse(readFileSync(join(PROFILES_DIR, f), 'utf-8')) as ProfileTemplate
      if (p.id) out.push(p)
    } catch { /* skip malformed */ }
  }
  return out.length ? out : [HARDCODED_DEFAULT_PROFILE]
}

export function loadProfileTemplate(id: string): ProfileTemplate {
  const path = join(PROFILES_DIR, `${id}.json`)
  if (existsSync(path)) {
    try { return JSON.parse(readFileSync(path, 'utf-8')) as ProfileTemplate } catch { /* fall through */ }
  }
  if (id !== 'default') return loadProfileTemplate('default')
  return HARDCODED_DEFAULT_PROFILE
}

export function resolveProfilePlaceholders(value: string, ctx: { HOME: string; AGENT_DIR: string }): string {
  const resolved = value
    .replace(/\$\{HOME\}/g, ctx.HOME)
    .replace(/\$\{AGENT_DIR\}/g, ctx.AGENT_DIR)
    .replace(/\$\{WORKDIR\}/g, ctx.AGENT_DIR)
    .replace(/\$\{PROJECT_ROOT\}/g, PROJECT_ROOT)
  // File-permission rules (Read/Edit/Write) treat a single leading '/' as
  // PROJECT-RELATIVE (gitignore semantics): Read(/Users/x/.ssh/**) silently
  // never matches, so every ${HOME}-based deny in the strict profiles was
  // inert (measured 2026-09-08, TMPLPERM908). A true absolute path needs
  // '//'. Normalize here so template authors keep writing ${HOME}/${AGENT_DIR}
  // naturally; Bash rules are command-prefix matches and must stay untouched.
  return resolved.replace(/^(Read|Edit|Write)\(\/(?!\/)/, '$1(//')
}

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PROJECT_ROOT } from '../config.js'
import { logger } from '../logger.js'

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

// WHICH PROFILE AN AGENT ACTUALLY GOT. A missing or
// unreadable profile file used to fall back to `default` in silence: the agent
// started, its settings.json was rewritten from the fallback, and the dashboard
// kept showing the REQUESTED name. `default` is the most permissive profile,
// so for any stricter one the silent fallback is a permission
// WIDENING that nobody sees. The fallback itself stays (an agent that cannot
// start is worse than one that starts under the default); what changes is that
// it is named: `fallbackReason` says why, every load logs a WARN, and the
// /security endpoint reports the effective profile next to the requested one.
export type ProfileFallbackReason = 'missing' | 'unreadable'

export interface ProfileResolution {
  profile: ProfileTemplate
  requested: string
  effective: string
  fallbackReason: ProfileFallbackReason | null
}

export function resolveProfileTemplate(id: string): ProfileResolution {
  const path = join(PROFILES_DIR, `${id}.json`)
  let reason: ProfileFallbackReason = 'missing'
  if (existsSync(path)) {
    try {
      const profile = JSON.parse(readFileSync(path, 'utf-8')) as ProfileTemplate
      return { profile, requested: id, effective: profile.id || id, fallbackReason: null }
    } catch {
      reason = 'unreadable'
    }
  }
  if (id !== 'default') {
    const fallback = resolveProfileTemplate('default')
    return { profile: fallback.profile, requested: id, effective: fallback.effective, fallbackReason: reason }
  }
  return { profile: HARDCODED_DEFAULT_PROFILE, requested: id, effective: 'default', fallbackReason: null }
}

export function loadProfileTemplate(id: string): ProfileTemplate {
  const resolution = resolveProfileTemplate(id)
  if (resolution.fallbackReason) {
    logger.warn(
      { requested: resolution.requested, effective: resolution.effective, reason: resolution.fallbackReason },
      `Security profile "${resolution.requested}" is ${resolution.fallbackReason}; the agent gets "${resolution.effective}" instead -- a fallback can WIDEN its permissions`,
    )
  }
  return resolution.profile
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

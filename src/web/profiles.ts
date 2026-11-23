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
  // CREDGATE1003: the credential gate (scripts/hooks/credential-gate.py) on the
  // agent's letter tools. Same posture as destructiveGate: absent == off, no
  // shipped template sets it, and switching it off is not a teardown.
  credentialGate?: boolean
  // D3(b): the second-reviewer gate (scripts/hooks/second-reviewer-gate.py): a model reviews a
  // high-risk tool call and allows it, denies it, or asks the owner. Absent == off, like
  // destructiveGate: every reviewed call costs a model call, which is the operator's choice.
  secondReviewer?: boolean
  // Gets the scripts/yt-ingest allow lines (YT_INGEST_ALLOW) -- but only while
  // the install-wide YT_DLP_INGEST_ONLY switch is on, so with the switch off
  // this flag changes nothing in the written settings.
  ytIngest?: boolean
}

/** Absent or non-true == off. Keeps the default in ONE place. */
export function profileWantsDestructiveGate(p: ProfileTemplate | null | undefined): boolean {
  return p?.destructiveGate === true
}

export function profileWantsCredentialGate(p: ProfileTemplate | null | undefined): boolean {
  return p?.credentialGate === true
}

export function profileWantsSecondReviewer(p: ProfileTemplate | null | undefined): boolean {
  return p?.secondReviewer === true
}

export function profileWantsThinChiefHandoff(p: ProfileTemplate | null | undefined): boolean {
  return p?.thinChiefHandoff === true
}

export function profileWantsYtIngest(p: ProfileTemplate | null | undefined): boolean {
  return p?.ytIngest === true
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
// WIDENING that nobody sees. The fallback itself stays for the callers that
// only render or describe a profile; the start path refuses instead for an
// explicitly configured profile (decideStartProfile below). The fallback is
// named: `fallbackReason` says why, every load logs a WARN, and the
// /security endpoint reports the effective profile next to the requested one.
export type ProfileFallbackReason = 'missing' | 'unreadable'

export interface ProfileResolution {
  profile: ProfileTemplate
  requested: string
  effective: string
  fallbackReason: ProfileFallbackReason | null
}

/** A parsed profile the settings writer can use: an object whose filesystem allow/deny are arrays. */
function isUsableProfile(p: unknown): p is ProfileTemplate {
  if (!p || typeof p !== 'object' || Array.isArray(p)) return false
  const fs = (p as { filesystem?: unknown }).filesystem
  if (!fs || typeof fs !== 'object') return false
  const { allow, deny } = fs as { allow?: unknown; deny?: unknown }
  return Array.isArray(allow) && Array.isArray(deny)
}

export function resolveProfileTemplate(id: string): ProfileResolution {
  const path = join(PROFILES_DIR, `${id}.json`)
  let reason: ProfileFallbackReason = 'missing'
  if (existsSync(path)) {
    try {
      const profile: unknown = JSON.parse(readFileSync(path, 'utf-8'))
      if (!isUsableProfile(profile)) throw new Error('not a profile object')
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

function warnProfileFallback(resolution: ProfileResolution): void {
  if (resolution.fallbackReason) {
    logger.warn(
      { requested: resolution.requested, effective: resolution.effective, reason: resolution.fallbackReason },
      `Security profile "${resolution.requested}" is ${resolution.fallbackReason}; the agent gets "${resolution.effective}" instead -- a fallback can WIDEN its permissions`,
    )
  }
}

export function loadProfileTemplate(id: string): ProfileTemplate {
  const resolution = resolveProfileTemplate(id)
  warnProfileFallback(resolution)
  return resolution.profile
}

// AGENTISO1123 (PR-A): the START path does not take the fallback. An agent whose
// agent-config.json NAMES a profile (securityProfile set, not 'default') that is
// missing or unreadable is refused, loudly: starting it under `default` would
// silently widen a stricter profile, and for an unattended strict agent that is
// the opposite of what was configured. An agent with NO profile configured
// (securityProfile absent or 'default', including the role-derived 'applier' of a
// leader) keeps the old behaviour: it starts, and a missing role-derived profile
// still falls back with the WARN above. `explicitlyConfigured` is the caller's
// readAgentSecurityProfile(name) !== 'default'.
export type ProfileStartDecision =
  | { ok: true; profile: ProfileTemplate }
  | { ok: false; error: string }

// Exactly ONE read of the profile file: the decision and the settings come from the same resolution, so a file that
// disappears after the check cannot turn into a silent `default` (Dani N2). `resolve` is a test seam.
export function decideStartProfile(
  requested: string,
  explicitlyConfigured: boolean,
  resolve: (id: string) => ProfileResolution = resolveProfileTemplate,
): ProfileStartDecision {
  const resolution = resolve(requested)
  if (resolution.fallbackReason && explicitlyConfigured) {
    return {
      ok: false,
      error: `security profile "${requested}" is ${resolution.fallbackReason} (templates/profiles/${requested}.json); the agent is NOT started -- fix the file or change the agent's securityProfile`,
    }
  }
  warnProfileFallback(resolution)
  return { ok: true, profile: resolution.profile }
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

/**
 * Which Claude Code config root an agent's transcript is read from.
 *
 * This lives in its own module because it had TWO copies before: the
 * context-restart gate's and the context-guard's, with the same main-agent
 * exemption written out twice. GATEVAK917 (#1382) fixed the gate's copy and
 * exported it so a third would not appear -- but the guard's copy stayed on the
 * old logic, which is worse than two identical wrong copies: the next reader
 * sees an exported, fixed function and concludes the subject is closed.
 *
 * The gate imports the guard (getHardGuardPhase), so the guard cannot import
 * the gate back without a cycle. Hence a module neither of them owns.
 */
import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { MAIN_AGENT_ID, PROJECT_ROOT } from '../config.js'
import { resolveAgentConfigDirForRead } from './claude-plans.js'
import { projectsDirFor } from './active-model.js'
import { mainConfigRoots } from './inbound-probe.js'

/**
 * Claude Code config root for an agent, or undefined for the host default.
 *
 * Transcripts live under <config-root>/projects/<encoded-working-dir>/, and an
 * agent launched with CLAUDE_CONFIG_DIR keeps them somewhere other than
 * ~/.claude. Reading without this looks in the default root, finds nothing, and
 * the caller's context read comes back null -- which is a fail-closed BLOCK in
 * the gate, so the symptom is a watchdog that never fires and never says why.
 */
export function configDirFor(name: string): string | undefined {
  // resolveAgentConfigDirForRead, not readAgentClaudeConfigDir: the launcher
  // auto-provisions agents/<name>/.claude-config when no field is set, and
  // reading the host default returns a stale transcript instead of nothing --
  // which is worse than the null this comment warns about, because the reader
  // then believes it can see.
  if (name !== MAIN_AGENT_ID) return resolveAgentConfigDirForRead(name) ?? undefined

  // The main agent used to return undefined here, i.e. the host default root --
  // the exact trap the comment above warns about, applied to the one agent that
  // was exempted from it. When the channels session runs with
  // CLAUDE_CONFIG_DIR=<PROJECT_ROOT>/.channels-config, its live transcript is
  // NOT under ~/.claude, while a pre-migration directory there may still exist
  // and still parse: the reader gets a stale number instead of nothing.
  //
  // WHERE THIS BITES, measured 2026-09-17 on the owner's install: NOWHERE, and
  // that limit belongs next to the fix. Here .channels-config/projects is a
  // symlink to ~/.claude/projects (same inode, same files), in place since
  // 2026-07-22, and .channels-config is symlinks throughout except its own
  // .claude.json -- the isolation is deliberately partial, so both roots
  // resolve to one store and the old code read the live transcript anyway. The
  // defect is real where the two roots genuinely diverge: an install whose main
  // agent runs on a separate Claude login.
  //
  // mainConfigRoots() is reused rather than re-deriving the candidate list, for
  // the same reason token-usage reuses it: a second copy of that list is how
  // the scheduler probe and the watchdogs drifted apart before.
  return newestMainConfigRoot()
}

/**
 * The main agent's config root whose transcript directory was written most
 * recently, or undefined when no candidate has one (then the caller's default
 * applies, exactly as before).
 *
 * Newest-wins, not first-wins: both roots hold real history (the shared one
 * pre-migration, the isolated one since), so picking by recency follows the
 * live session across a migration without needing to know one happened.
 */
export function newestMainConfigRoot(): string | undefined {
  let bestRoot: string | undefined
  let bestMtime = -1
  for (const root of mainConfigRoots()) {
    const dir = projectsDirFor(PROJECT_ROOT, root)
    let entries: string[]
    try { entries = readdirSync(dir) } catch { continue }
    for (const f of entries) {
      if (!f.endsWith('.jsonl')) continue
      let m: number
      try { m = statSync(join(dir, f)).mtimeMs } catch { continue }
      if (m > bestMtime) { bestMtime = m; bestRoot = root }
    }
  }
  return bestRoot
}

/**
 * CODEXEVID d72ba2bd: where does a Codex-motor agent keep its transcript?
 *
 * Two watchers decided "did the agent see the prompt / start a turn" from the
 * CLAUDE CODE transcript only (delivery-turn-check.ts and
 * schedule-runner.ts's probeTurnEvidence). For the 8 agents on this install
 * whose tmux pane runs OpenAI Codex instead of Claude Code, that transcript
 * never moves, and both watchers went blind in the same direction:
 *   - 239 "delivered without transcript evidence" WARNs on 2026-11-15 alone
 *     (bence 97, webesdavid 66, levente 60, hcs-helia 8, guszti/avora/vppbot/
 *     tenderbot 2 each) -- every one a false alarm;
 *   - 38 "Scheduled injection never started a turn ... recording as lost"
 *     redeliveries that day (webesdavid 18, tenderbot 10, bence 8, guszti 2),
 *     58 since 11-14 -- every 'lost' verdict re-delivers the task, so each is
 *     a DUPLICATE task run.
 *
 * The missing evidence is on disk: the Codex rollout JSONL under
 * <CODEX_HOME>/sessions/YYYY/MM/DD/. Measured example (2026-11-15, a message
 * sent 12:07 local, in the recipient's rollout):
 *   {"timestamp":"2026-11-15T11:07:52.752Z","ordinal":8921,"type":"response_item",
 *    "payload":{"type":"message","id":"msg_...","role":"user",
 *               "content":[{"type":"input_text","text":"... msg_id:128547 ..."}]}}
 * and the running session file's mtime advances while the agent works.
 *
 * Resolve the rollout root from agent-config.json: engine must be codex,
 * and codexConfigDir supplies CODEX_HOME. When codexConfigDir is null, use
 * ~/.codex, the default rollout location documented in scripts/usage-collect.py.
 *
 * Contract (both watchers depend on it):
 *   - codexSessionDirsFor never throws: any failure returns [] plus a debug
 *     line. It never logs config CONTENTS, only resolved paths.
 *   - No cache: a config change applies on the next ask.
 *   - After reading config, a claude-motor agent costs zero filesystem access
 *     and zero subprocess spawns.
 */
import { readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { logger } from '../logger.js'
import { readAgentEngineConfigSafe } from './agent-config.js'

// sessions/YYYY/MM/DD/*.jsonl: the day directory sits three levels under the
// resolved sessions root.
const CODEX_WALK_DEPTH = 3

export interface CodexSessionDeps {
  readConfig?: (agent: string) => { engine: string; codexConfigDir: string | null }
  stat?: (path: string) => Promise<{ isDirectory(): boolean }>
  homeDir?: () => string
}

/**
 * The rollout roots for an agent's persisted Codex motor config:
 * [<CODEX_HOME>/sessions] when the sessions directory is readable, [] otherwise.
 * Never throws; logs resolved paths only, never config contents.
 */
export async function codexSessionDirsFor(agent: string, deps: CodexSessionDeps = {}): Promise<string[]> {
  try {
    const readConfig = deps.readConfig ?? readAgentEngineConfigSafe
    const cfg = readConfig(agent)
    if (cfg.engine !== 'codex') {
      logger.debug({ agent }, 'codex-transcript-root: claude-motor agent, no codex evidence')
      return []
    }
    const homeDir = deps.homeDir ?? homedir
    const home = cfg.codexConfigDir ?? join(homeDir(), '.codex')
    const sessionsDir = join(home, 'sessions')
    const statDir = deps.stat ?? stat
    try {
      if (!(await statDir(sessionsDir)).isDirectory()) {
        logger.debug({ agent, sessionsDir }, 'codex-transcript-root: sessions path is not a directory (no codex evidence)')
        return []
      }
    } catch {
      logger.debug({ agent, sessionsDir }, 'codex-transcript-root: sessions dir unavailable (no codex evidence)')
      return []
    }
    logger.debug({ agent, sessionsDir }, 'codex-transcript-root: codex rollout root resolved')
    return [sessionsDir]
  } catch {
    // Belt and braces: the contract is [], never a throw, even if a code path
    // above changes shape later.
    logger.debug({ agent }, 'codex-transcript-root: lookup failed (no codex evidence)')
    return []
  }
}

export interface CodexRolloutFsDeps {
  readdir?: typeof readdir
  stat?: typeof stat
}

/**
 * Every *.jsonl rollout file under the given roots, with its mtime. The walk
 * covers the sessions/YYYY/MM/DD layout (three levels) and tolerates files
 * sitting shallower. Unreadable directories/files are skipped, not fatal:
 * this feeds an evidence probe, and a hole in the walk means "no evidence",
 * never an error into the watchers.
 */
export async function codexRolloutFiles(
  dirs: readonly string[],
  deps: CodexRolloutFsDeps = {},
): Promise<Array<{ path: string; mtimeMs: number }>> {
  const readdirD = deps.readdir ?? readdir
  const statD = deps.stat ?? stat
  const out: Array<{ path: string; mtimeMs: number }> = []
  const walk = async (dir: string, depth: number): Promise<void> => {
    // Structural type: Dirent from readdir satisfies it, and injected test
    // doubles only need name + isDirectory.
    let entries: Array<{ name: string; isDirectory(): boolean }>
    try {
      entries = await readdirD(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (depth > 0) await walk(path, depth - 1)
      } else if (entry.name.endsWith('.jsonl')) {
        try {
          out.push({ path, mtimeMs: (await statD(path)).mtimeMs })
        } catch {
          // A rollout that cannot be stat'd cannot be read either; skipping it
          // leaves the verdict to the files that can be.
        }
      }
    }
  }
  for (const dir of dirs) await walk(dir, CODEX_WALK_DEPTH)
  return out
}

/**
 * The newest rollout mtime across the given roots, or null when nothing was
 * readable. This is the codex analogue of the Claude transcript mtime the
 * sawTurn probe reads: null means "no evidence", never "old".
 */
export async function codexRolloutMtime(dirs: readonly string[], deps: CodexRolloutFsDeps = {}): Promise<number | null> {
  let max: number | null = null
  for (const f of await codexRolloutFiles(dirs, deps)) {
    if (max == null || f.mtimeMs > max) max = f.mtimeMs
  }
  return max
}

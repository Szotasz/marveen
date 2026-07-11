import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { logger } from '../logger.js'

// --- Per-agent auto-memory isolation (opt-in) --------------------------------
//
// Claude Code keys its file-based auto-memory (MEMORY.md + memory/*.md under
// ~/.claude/projects/<key>/) to the ENCLOSING GIT WORKTREE ROOT of the session
// cwd, falling back to the cwd itself outside any repo. Agent sessions run with
// cwd = agents/<name> INSIDE the install repo, so by default every sub-agent
// and the main agent resolve to the SAME install-root project key and share
// one auto-memory.
//
// On a single-operator install that sharing is desirable: one fleet-wide
// MEMORY.md carries the operator's corrections to every agent. On a multi-user
// install (one human principal per agent) it is a cross-principal leak.
//
// Planting a stub git repo in the agent dir stops the walk-up there, so the
// agent's auto-memory lands under its own per-agent project key. Everything
// else is untouched: session transcripts already use per-cwd keys, and the
// shared ~/.claude/projects tree (or a .claude-config projects symlink) keeps
// working exactly as before. The stub ignores all content via .git/info/exclude
// so the agent dir never shows up as a dirty checkout. Reverting is
// `rm -rf agents/<name>/.git`.
//
// Trade-off the operator opts into: an isolated agent no longer sees the
// shared fleet MEMORY.md; fleet-wide rules must reach it via CLAUDE.md or
// shared SQLite memories instead.
export function provisionMemoryBoundaryDir(dir: string): boolean {
  if (!existsSync(dir)) return false
  try {
    const gitDir = join(dir, '.git')
    if (!existsSync(gitDir)) {
      execFileSync('git', ['init', '--quiet'], { cwd: dir, timeout: 10_000 })
    }
    // (Re)write the exclude on every call: idempotent, and it also repairs a
    // stub whose exclude was lost. `*` keeps `git status` empty forever.
    const infoDir = join(gitDir, 'info')
    mkdirSync(infoDir, { recursive: true })
    writeFileSync(join(infoDir, 'exclude'), '*\n')
    return true
  } catch (err) {
    logger.warn({ dir, err }, 'memory-boundary: could not provision stub git root; agent keeps the shared auto-memory key')
    return false
  }
}

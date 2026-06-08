import { execFileSync } from 'node:child_process'
import { userInfo } from 'node:os'
import { logger } from '../logger.js'

// Read the host's Claude Code SUBSCRIPTION login JSON from the macOS Keychain,
// to materialise as <CLAUDE_CONFIG_DIR>/.credentials.json for an isolated
// sub-agent / worker config dir. Mirrors heartbeat.ts's readClaudeCodeOauthJson
// (kept as a standalone copy here to avoid an agent <-> heartbeat import cycle;
// consolidate when heartbeat itself migrates onto the worker). Returns null off
// macOS or on any lookup failure (the worker then runs logged-out and its
// requests fail closed to text=null).
export function readClaudeCodeOauthJson(): string | null {
  if (process.platform !== 'darwin') return null
  try {
    const out = execFileSync(
      '/usr/bin/security',
      ['find-generic-password', '-s', 'Claude Code-credentials', '-a', userInfo().username, '-w'],
      { timeout: 3000, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim()
    return out || null
  } catch {
    // Not logging err: some macOS auth errors echo a fragment of the lookup key.
    logger.warn('worker: failed to read Claude Code credentials from Keychain (worker will run logged-out)')
    return null
  }
}

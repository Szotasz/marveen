// Standalone entry so the channel health monitor can run the (deliberately
// synchronous, tmux-driven) MCP reconnect OFF the dashboard's main event loop.
//
// Root cause it fixes: attemptChannelMcpReconnect() walks the interactive /mcp
// tmux menu with execFileSync('/bin/sleep', ...) pacing. Run inline from the
// 60s health-monitor timer, that sequence BLOCKS the libuv event loop for the
// full tmux+sleep duration; with several agents in '✘ failed' state the loop is
// starved continuously and the dashboard accepts TCP connections but never
// services HTTP requests (observed 2026-06-30: deaf for hours, 0% CPU, stuck in
// node::SyncProcessRunner::Spawn under uv__run_timers). Spawning this CLI
// detached keeps the blocking work in a throwaway child process.
//
// Usage: node dist/web/reconnect-cli.js <agentName>
import { attemptChannelMcpReconnect } from './channel-mcp-reconnect.js'
import { logger } from '../logger.js'

const agentName = process.argv[2]
if (!agentName) {
  // eslint-disable-next-line no-console
  console.error('reconnect-cli: missing agentName argument')
  process.exit(2)
}

try {
  const result = attemptChannelMcpReconnect(agentName)
  logger.info(
    { agentName, ok: result.ok, message: result.message },
    'reconnect-cli: reconnect attempt finished',
  )
  process.exit(result.ok ? 0 : 1)
} catch (err) {
  logger.error({ agentName, err }, 'reconnect-cli: reconnect attempt threw')
  process.exit(1)
}

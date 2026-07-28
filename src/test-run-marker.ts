// Outbound owner notifications fired from inside a test runner must stay
// distinguishable from production alerts. The message still goes out -- the
// owner explicitly wants to SEE that the real alert path works -- but it
// carries a leading [TESZT] marker so a real alert is never mistaken for a
// test one (2026-07-27: the auth-recovery suite's break-glass reset repeatedly
// alerted the owner with a production-identical message).
//
// Detection: vitest exports VITEST to every worker process; NODE_ENV=test
// covers other runners. Both propagate through child processes, so anything a
// test spawns (including scripts/notify.sh, which mirrors this check) inherits
// the marking.
//
// To fully SILENCE channel notifications during long debug loops, blank the
// channel env instead of relying on this marker:
//   CHANNEL_TOKEN= CHANNEL_CHAT_ID= npx vitest run <file>
export const TEST_RUN_PREFIX = '[TESZT] '

export function isTestRun(): boolean {
  return process.env['VITEST'] !== undefined || process.env['NODE_ENV'] === 'test'
}

// Idempotent: senders may layer (notifyChannel -> provider -> Bot API), so a
// message that already carries the marker is not marked twice.
export function markIfTestRun(text: string): string {
  if (!isTestRun() || text.startsWith(TEST_RUN_PREFIX)) return text
  return TEST_RUN_PREFIX + text
}

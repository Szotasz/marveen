// Per-tool outgoing HTTP deadline (ms).
// If an external service doesn't respond within the allotted time, the
// request is aborted and the caller receives an Error so it can log and fall
// back gracefully instead of hanging the whole agent session.
export const TOOL_TIMEOUTS = {
  'google-calendar': 5_000,
  'telegram':        10_000,
  'github':          10_000,
  'slack':           10_000,
  'ollama-embedding': 30_000,
} as const

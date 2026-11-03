// ROSTERALIAS1026: the boot hook-seeding loop used to run every per-agent
// helper inside ONE try/catch around the whole loop, so one agent's failure
// left every agent after it in the list silently unseeded (a single
// 'Agent hook backfill skipped' warn). Each agent is seeded in isolation here
// instead: a failure is reported and the loop moves on.
export function forEachAgentIsolated(
  names: readonly string[],
  seed: (name: string) => void,
  onError: (name: string, err: unknown) => void,
): string[] {
  const failed: string[] = []
  for (const name of names) {
    try {
      seed(name)
    } catch (err) {
      failed.push(name)
      try { onError(name, err) } catch { /* onError must not stop the loop either */ }
    }
  }
  return failed
}

/**
 * The wall-clock a reconnect-backlog summary line carries (BACKLOGTZ1109).
 *
 * It renders in the install zone (config.APP_TZ, i.e. SCHEDULER_TZ or the host
 * zone). The previous form, `toISOString().replace('T', ' ')`, printed UTC in a
 * local-looking format with nothing marking it as UTC: on a UTC+2 install a
 * message sent at 18:49:54 local was quoted as 16:49:54. The reader cannot see
 * the shift from the string, and the agent reading the summary reasons about the
 * order of its own day from it.
 *
 * sv-SE is used only for its format (YYYY-MM-DD HH:MM:SS), not as a locale
 * choice; the zone comes from the argument, so an install in any zone follows it.
 * Kept in its own module so it is testable without the router's import graph.
 */
export function formatBacklogTimestamp(createdAtSeconds: number, tz: string): string {
  return new Date(createdAtSeconds * 1000).toLocaleString('sv-SE', { timeZone: tz })
}

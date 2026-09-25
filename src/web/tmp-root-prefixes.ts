// SINGLE SOURCE OF TRUTH for the transient-filesystem prefixes.
//
// Two separate guards need the same list, and they must never drift apart:
//
//  1. `isUnsafeHookCommand` (agent-scaffold.ts) refuses to write a hook command
//     containing one of these into the shared ~/.claude/settings.json. When /tmp
//     is cleared on the next reboot the referenced script is gone, the hook exits
//     non-zero, and Claude Code blocks every prompt -- the 2026-07-14 silent
//     fleet-freeze incident.
//
//  2. The suite gate (src/__tests__/setup/assert-not-live-install.ts) refuses to
//     RUN from a checkout rooted under one of these, because guard (1) then
//     rightly rejects the hooks the gate tests register, and those tests go
//     falsely red -- nine files on 2026-09-12, and the reading that followed was
//     "the develop branch is broken".
//
// The two predicates differ on purpose: (1) scans a command STRING for the prefix
// anywhere in it, (2) asks whether a ROOT PATH starts with one. Same list, two
// questions.
export const TMP_ROOT_PREFIXES = ['/tmp/', '/var/tmp/', '/private/tmp/', '/dev/shm/']

/** True when `p` is a filesystem ROOT living on transient storage. */
export function isTmpRootedPath(p: string): boolean {
  const withSlash = p.endsWith('/') ? p : `${p}/`
  return TMP_ROOT_PREFIXES.some((prefix) => withSlash.startsWith(prefix))
}

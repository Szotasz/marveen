// A message that cannot be delivered within this window (target session never
// exists / stays busy) is marked failed so it stops clogging the pending
// queue and we stop re-scanning it forever. Matches the scheduled-task retry
// window so a long turn that ate one also eats the other.
// Lives in its own module so the POST /api/messages route can quote the same
// number in its "queued" warning without importing the router.
export const MESSAGE_ABANDON_WINDOW_MS = 60 * 60 * 1000

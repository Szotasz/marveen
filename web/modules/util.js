// Shared utility functions used across web/modules/*.
// Pure implementations with no DOM dependency so they are directly unit-testable.

// Escapes str for safe insertion into HTML text content and attribute values.
// Handles null/undefined via the nullish-coalescing default.
export function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ))
}

// Semantic alias for attribute contexts (behaviour is identical to escapeHtml).
export { escapeHtml as escapeAttr }

// Returns the agent id configured for this dashboard instance.
export function mainAgentId() {
  return window._marveen?.agentId || 'marveen'
}

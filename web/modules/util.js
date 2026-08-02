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

// Regex-based JSON syntax highlighter.
// Tokenizes in a single pass (strings first) so later patterns never
// re-match content already wrapped in a <span>.
// Returns an HTML string safe for innerHTML.
export function highlightJson(raw) {
  let fmt
  try { fmt = JSON.stringify(JSON.parse(raw), null, 2) } catch { return escapeHtml(raw) }
  return fmt.replace(
    // Alternation order: strings (with optional trailing colon for key detection)
    // must come first so number/keyword patterns cannot fire inside string tokens.
    /"((?:[^"\\]|\\.)*)"\s*(:)?|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|\btrue\b|\bfalse\b|\bnull\b/g,
    (match, strContent, isKey) => {
      if (strContent !== undefined) {
        const safe = escapeHtml(strContent)
        // key: "..." followed by ':'
        return isKey
          ? `<span style="color:#BD5D38">"${safe}"</span>:`
          : `<span style="color:#4a9a6a">"${safe}"</span>`
      }
      if (match === 'true' || match === 'false' || match === 'null') {
        return `<span style="color:var(--text-secondary,#8a8a7c)">${match}</span>`
      }
      // number
      return `<span style="color:#6366f1">${match}</span>`
    }
  )
}

// === dom.js: shared DOM utilities ===
// Pure helpers with no module-level state; safe to import from any page module.

export function escapeHtml(str) {
  const d = document.createElement('div')
  d.textContent = str
  return d.innerHTML
}

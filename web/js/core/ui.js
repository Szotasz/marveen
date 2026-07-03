// === ui.js: shared modal and toast helpers ===

// Tracks which context opened the skill modal so the save handler knows
// whether to write to ~/.claude/skills/ (global) or the per-agent dir.
// Reset to null on every close so a later per-agent open cannot inherit
// a stale 'global' scope from a prior Skills-page session.
export let skillModalScope = null

export function setSkillModalScope(v) {
  skillModalScope = v
}

export function openModal(overlay) {
  overlay.classList.add('active')
  document.body.style.overflow = 'hidden'
}

export function closeModal(overlay) {
  overlay.classList.remove('active')
  document.body.style.overflow = ''
  // Direct write: same module, no setter needed.
  if (overlay?.id === 'skillModalOverlay') skillModalScope = null
}

export function showToast(msg, duration = 3000) {
  // Lazy lookup -- avoids a top-level DOM query at module parse time.
  const toast = document.getElementById('toast')
  if (!toast) return
  toast.textContent = msg
  toast.classList.add('visible')
  setTimeout(() => toast.classList.remove('visible'), duration)
}

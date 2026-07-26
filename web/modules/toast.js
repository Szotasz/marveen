// Lightweight toast notification module.
// Depends on a #toast element in the host HTML; called via showToast()
// throughout the dashboard. Exported so app.js can import it.
//
// This is the first ES module extracted from app.js as part of the S-1
// feasibility POC (issue #3). It has zero inbound dependencies on other
// app.js functions, making it the ideal isolation canary.

let toastEl = null

function getToastEl() {
  if (!toastEl) toastEl = document.getElementById('toast')
  return toastEl
}

export function showToast(msg, duration = 3000) {
  const el = getToastEl()
  if (!el) return
  el.textContent = msg
  el.classList.add('visible')
  setTimeout(() => el.classList.remove('visible'), duration)
}

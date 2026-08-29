import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

// Contract test for a data-loss bug reported 2026-08-19 (Józsi): clicking the
// backdrop of a modal (e.g. the kanban "Új kártya" modal) closed it
// UNCONDITIONALLY, silently discarding any typed title/description -- a full
// page of typed text was lost this way. Every `*Overlay.addEventListener(
// 'click', ...)` background-close in web/app.js had this same shape.
//
// Fix (Józsi's acceptance criteria, 2026-08-19): empty form -> backdrop click
// closes freely (no friction); form has typed input -> a confirm() gates the
// close. A single shared guard (`attachOverlayCloseGuard`) replaces every
// direct `closeModal(...)` call on backdrop click, so the fix is uniform
// across all overlays, not one-off per modal.
const __dirname = dirname(fileURLToPath(import.meta.url))
const appJsPath = join(__dirname, '..', '..', 'web', 'app.js')
const src = readFileSync(appJsPath, 'utf8')

// Every overlay identifier in the file that ends in "Overlay" and is closed
// via the background-click pattern, measured independently (not taken from
// a prior report): `grep -n "Overlay.addEventListener('click'" web/app.js`.
const OVERLAY_IDS = [
  'cardModalOverlay',
  'cardDetailOverlay',
  'agentWizardOverlay',
  'agentDetailOverlay',
  'skillModalOverlay',
  'scheduleModalOverlay',
  'scheduleRunHistoryOverlay',
  'memModalOverlay',
  'catalogInstallOverlay',
  'connectorModalOverlay',
  'connectorDetailOverlay',
  'memImportOverlay',
  'skillDetailOverlay',
  'adOverlay',
]

describe('modal backdrop click must not silently discard unsaved input', () => {
  it('none of the overlays close unconditionally on backdrop click any more', () => {
    for (const id of OVERLAY_IDS) {
      const unconditional = new RegExp(
        `${id}\\.addEventListener\\('click',\\s*e?\\s*=>\\s*\\{\\s*if\\s*\\(e\\.target\\s*===\\s*${id}\\)\\s*closeModal\\(${id}\\)\\s*\\}\\s*\\)`,
      )
      expect(src, `${id} still closes unconditionally on backdrop click`).not.toMatch(unconditional)
    }
  })

  it('a shared guard checks for unsaved input before closing on backdrop click', () => {
    expect(src).toMatch(/function\s+overlayHasUnsavedInput\s*\(/)
    expect(src).toMatch(/function\s+attachOverlayCloseGuard\s*\(/)
    // the guard must actually gate on a confirm() -- not just check and ignore
    const guardBody = src.slice(src.indexOf('function attachOverlayCloseGuard'))
    expect(guardBody.slice(0, 400)).toMatch(/confirm\(/)
  })

  it('every measured overlay is wired through the shared guard', () => {
    for (const id of OVERLAY_IDS) {
      expect(src, `${id} is not wired through attachOverlayCloseGuard`).toMatch(
        new RegExp(`attachOverlayCloseGuard\\(${id}\\)`),
      )
    }
  })
})

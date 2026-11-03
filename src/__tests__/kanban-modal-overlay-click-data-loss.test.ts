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
    // the guard must actually gate on a confirmation -- not just check and ignore.
    // Since the confirm-dialog blocks it is the app's own confirmDialog, not the
    // native confirm(); its behaviour is driven in confirm-dialog.test.ts.
    // The question itself lives in confirmUnsavedInputClose, which the guard registers by default
    // and every close path (backdrop, close button, Escape) asks through requestOverlayClose.
    const askBody = src.slice(src.indexOf('async function confirmUnsavedInputClose'))
    const ask = askBody.slice(0, askBody.indexOf('\n}\n'))
    expect(ask).toMatch(/overlayHasUnsavedInput\(overlay\)/)
    expect(ask).toMatch(/confirmDialog\(\{/)
    expect(ask).not.toMatch(/(^|[^.\w])confirm\(/)
    const guardBody = src.slice(src.indexOf('function attachOverlayCloseGuard'))
    const guard = guardBody.slice(0, guardBody.indexOf('\n}\n'))
    expect(guard).toContain('confirmUnsavedInputClose(overlay)')
    expect(guard).toContain('await requestOverlayClose(overlay)')
  })

  it('every measured overlay is wired through the shared guard', () => {
    for (const id of OVERLAY_IDS) {
      expect(src, `${id} is not wired through attachOverlayCloseGuard`).toMatch(
        new RegExp(`attachOverlayCloseGuard\\(${id}[,)]`),
      )
    }
  })
})

// The backdrop was the only guarded close: a modal's own close button and Escape still closed it at
// once, dropping typed input (reported 2026-10-28 on a kanban card). Every guarded modal's close
// button now goes through requestOverlayClose, as does Escape.
describe('the close button and Escape ask like the backdrop', () => {
  it('no guarded modal\'s close button closes it directly', () => {
    for (const id of OVERLAY_IDS) {
      expect(src, `${id}'s close button bypasses the guard`).not.toMatch(
        new RegExp(`addEventListener\\('click',\\s*(async\\s*)?\\(\\)\\s*=>\\s*closeModal\\(${id}\\)\\)`),
      )
    }
  })

  it('every guarded modal has a close button wired through requestOverlayClose', () => {
    for (const id of OVERLAY_IDS) {
      expect(src, `${id} has no guarded close button`).toContain(`addEventListener('click', () => requestOverlayClose(${id}))`)
    }
  })

  it('Escape closes through requestOverlayClose', () => {
    const i = src.indexOf("document.addEventListener('keydown', async (e) => {\n  if (e.key !== 'Escape') return")
    expect(i).toBeGreaterThan(-1)
    const handler = src.slice(i, src.indexOf('\n})\n', i))
    expect(handler).toContain('await requestOverlayClose(o)')
    expect(handler).not.toMatch(/closeModal\(/)
  })

  // The SHIPPED guard functions, as a close button or Escape uses them: requestOverlayClose on a modal
  // registered through attachOverlayCloseGuard.
  const gStart = src.indexOf('function overlayHasUnsavedInput(')
  const gEnd = src.indexOf('\n}\n', src.indexOf('function attachOverlayCloseGuard(')) + 3
  const GUARD = src.slice(gStart, gEnd)

  async function closeButton(fieldValue: string, answer: boolean, ownCheck?: () => Promise<boolean>) {
    const field = { offsetParent: {}, value: fieldValue }
    const overlay: Record<string, unknown> = { querySelectorAll: () => [field], addEventListener: () => {} }
    const asked: string[] = []
    const closed: unknown[] = []
    const { attach, request } = new Function('confirmDialog', 'closeModal', 't',
      `${GUARD}\nreturn { attach: attachOverlayCloseGuard, request: requestOverlayClose }`,
    )(
      async (o: { title: string }) => { asked.push(o.title); return answer },
      (o: unknown) => { closed.push(o) },
      (k: string) => k,
    )
    if (ownCheck) attach(overlay, ownCheck)
    else attach(overlay)
    await request(overlay)
    return { asked, closed: closed.length }
  }

  it('an empty form: the close button closes at once', async () => {
    expect(await closeButton('', false)).toEqual({ asked: [], closed: 1 })
  })

  it('typed input: the close button asks; "no" keeps the modal, "yes" closes it', async () => {
    expect(await closeButton('half a card', false)).toEqual({ asked: ['common.confirm.unsaved_title'], closed: 0 })
    expect(await closeButton('half a card', true)).toEqual({ asked: ['common.confirm.unsaved_title'], closed: 1 })
  })

  it('a modal with its own question asks that one instead', async () => {
    expect(await closeButton('half a card', true, async () => false)).toEqual({ asked: [], closed: 0 })
  })
})

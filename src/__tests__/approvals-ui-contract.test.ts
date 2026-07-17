// String-contract guard for the Approvals dashboard surface (the house
// idiom: federation-ui-contract.test.ts / schedule-run-now.test.ts read
// the frontend files as strings and assert short, formatting-proof
// fragments). Guards the wiring that has NO functional test: the sidebar
// anchor, the router hook, the page loader, the API endpoints consumed,
// and the security discipline that the dashboard never sends an agent id
// as resolved_by (which would trip the self-approval guard on the server).
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const APP  = readFileSync(join(__dirname, '../../web/app.js'), 'utf-8')
const HTML = readFileSync(join(__dirname, '../../web/index.html'), 'utf-8')
const CSS  = readFileSync(join(__dirname, '../../web/style.css'), 'utf-8')

describe('approvals UI wiring', () => {
  it('sidebar has the approvals nav item AFTER autonomy and BEFORE settings', () => {
    const autonomy  = HTML.indexOf('data-page="autonomy"')
    const approvals = HTML.indexOf('data-page="approvals"')
    const settings  = HTML.indexOf('data-page="settings"')
    expect(approvals).toBeGreaterThan(autonomy)
    expect(approvals).toBeLessThan(settings)
  })

  it('page div, router dispatch, loader function and nav key exist', () => {
    expect(HTML).toContain('id="approvalsPage"')
    expect(APP).toMatch(/pageId === 'approvals'/)
    expect(APP).toMatch(/async function loadApprovalsPage\(/)
    expect(APP).toContain("approvals: 'nav.approvals'")
    expect(APP).toContain('approvalsPage:')
  })

  it('frontend consumes the correct API endpoints', () => {
    expect(APP).toContain('/api/approvals?limit=')
    expect(APP).toContain('/api/approvals/')
    expect(APP).toContain("method: 'PATCH'")
  })

  it('dashboard resolved_by is a source label, not an agent id -- avoids tripping self-approval guard', () => {
    // The PATCH body must use a neutral source label so the server-side guard
    // (resolved_by === agent_id -> 403) is never triggered by the dashboard itself.
    expect(APP).toContain("resolved_by: 'dashboard'")
    // Must NOT send an agent id as resolved_by from the approve/reject buttons.
    // The _resolveApproval function is the only code path that calls PATCH; verify
    // it contains the safe label and does not interpolate an agent id instead.
    const resolveIdx = APP.indexOf('async function _resolveApproval(')
    const nextFn = APP.indexOf('\nasync function ', resolveIdx + 1)
    const fnBody = APP.slice(resolveIdx, nextFn > resolveIdx ? nextFn : resolveIdx + 2000)
    expect(fnBody).toContain("resolved_by: 'dashboard'")
    expect(fnBody).not.toMatch(/resolved_by:\s*[`'"][a-z]+-[a-z]/i) // no agent-id pattern (e.g. "agent-b", "agent-x")
  })

  it('stat cards, toolbar, and pagination CSS classes exist', () => {
    expect(CSS).toContain('.approvals-stats')
    expect(CSS).toContain('.approvals-toolbar')
    expect(CSS).toContain('.approvals-pagination')
  })

  it('pending row highlight uses warning color variable', () => {
    expect(APP).toContain('var(--warning)')
  })

  it('timeout countdown renders for pending rows with timeout_at', () => {
    expect(APP).toContain('approvals-countdown')
    expect(APP).toMatch(/data-timeout.*timeout_at/)
  })

  it('sidebar badge element exists and is hidden by default', () => {
    expect(HTML).toContain('id="approvalsPendingBadge"')
    expect(HTML).toMatch(/approvalsPendingBadge[^>]*hidden/)
    expect(CSS).toContain('.approvals-pending-badge')
    // Badge hidden attribute is toggled in JS when pending count changes
    expect(APP).toContain('approvalsPendingBadge')
    expect(APP).toMatch(/badge\.hidden\s*=\s*counts\.pending\s*===\s*0/)
  })

  it('pending notice banner exists, hidden by default, shown only when pending > 0', () => {
    expect(HTML).toContain('id="approvalsPendingBanner"')
    expect(HTML).toMatch(/approvalsPendingBanner[^>]*hidden/)
    expect(CSS).toContain('.approvals-pending-banner')
    // JS must set banner.hidden = true when no pending, false otherwise
    expect(APP).toMatch(/banner\.hidden\s*=\s*true/)
    expect(APP).toMatch(/banner\.hidden\s*=\s*false/)
    // Banner appears ABOVE the stat cards (earlier in the page div)
    const bannerIdx = HTML.indexOf('id="approvalsPendingBanner"')
    const statsIdx  = HTML.indexOf('id="approvalsStats"')
    expect(bannerIdx).toBeGreaterThan(0)
    expect(bannerIdx).toBeLessThan(statsIdx)
  })

  it('resolved_at timestamp is rendered alongside resolved_by in non-pending rows', () => {
    // The resolved_at field must appear in the table cell for completed rows
    expect(APP).toContain('resolved_at')
    // Rendered as a secondary line inside the same cell as resolved_by
    expect(APP).toMatch(/resolved_by.*resolved_at|resolved_at.*resolved_by/s)
  })

  it('nav + core i18n keys exist in BOTH language files', async () => {
    ;(globalThis as unknown as { window: Record<string, unknown> }).window ||= {} as Record<string, unknown>
    await import(/* @vite-ignore */ '../../web/lang/hu.js' as string)
    await import(/* @vite-ignore */ '../../web/lang/en.js' as string)
    const i18n = (globalThis as unknown as { window: { _i18n: Record<string, Record<string, string>> } }).window._i18n
    for (const lang of ['hu', 'en'] as const) {
      expect(i18n[lang]['nav.approvals']).toBeTruthy()
      expect(i18n[lang]['approvals.page_title']).toBeTruthy()
      expect(i18n[lang]['approvals.stat.pending']).toBeTruthy()
      expect(i18n[lang]['approvals.btn.approve']).toBeTruthy()
      expect(i18n[lang]['approvals.btn.reject']).toBeTruthy()
      expect(i18n[lang]['approvals.status.pending']).toBeTruthy()
      expect(i18n[lang]['approvals.toast.approved']).toBeTruthy()
      expect(i18n[lang]['approvals.countdown.expired']).toBeTruthy()
      expect(i18n[lang]['approvals.banner.notice']).toBeTruthy()
      expect(i18n[lang]['approvals.banner.timeout']).toBeTruthy()
    }
  })
})

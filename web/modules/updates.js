import { t } from './i18n.js'
import { showToast } from './toast.js'

function escapeHtmlUpdates(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}

// ============================================================
// === Updates page ===
// ============================================================

function renderUpdatesBadge(status) {
  const badge = document.getElementById('updatesBadge')
  if (!badge) return
  // Version-centric: show the number of NEW VERSIONS, not raw commits. Fall back
  // to the behind count only in the rare pre-release state (unreleased commits
  // but no new version tag yet).
  const versionCount = status && Array.isArray(status.releases)
    ? status.releases.filter((r) => r.version).length : 0
  const count = versionCount > 0 ? versionCount : ((status && status.behind) || 0)
  if (count > 0) {
    badge.textContent = String(count)
    badge.hidden = false
  } else {
    badge.hidden = true
  }
}

// ============================================================
// === Branch-drift warning ===
// Installs that landed on a non-main branch (e.g. a branchless clone before
// the --branch main pin) keep receiving unreleased code from update.sh, which
// pulls the tracked branch. Two surfaces, both non-blocking: a dismissible
// top banner (dismissal persists per browser AND per branch, so a later switch
// to yet another branch re-warns) and a permanent notice on the Updates page.
// Dev machines follow develop on purpose; one dismissal silences the banner
// for them while the Updates-page notice stays as the quiet ground truth.
const BRANCH_DRIFT_DISMISS_PREFIX = 'marveen.branch-drift-dismissed.'
const BRANCH_HEAL_COMMAND = 'git checkout main && bash update.sh'

function branchDriftDismissed(branch) {
  try { return localStorage.getItem(BRANCH_DRIFT_DISMISS_PREFIX + branch) === '1' } catch { return false }
}

function updateBranchDriftUI(status) {
  const banner = document.getElementById('branchDriftBanner')
  if (!banner) return
  const branch = status && status.branch
  const drifted = !!branch && branch !== 'main'
  if (!drifted || branchDriftDismissed(branch)) {
    banner.hidden = true
    return
  }
  const textEl = document.getElementById('branchDriftBannerText')
  if (textEl) {
    textEl.innerHTML =
      `${t('branch_drift.banner.text', { branch: `<strong>${escapeHtmlUpdates(branch)}</strong>` })} ` +
      `<code>${BRANCH_HEAL_COMMAND}</code>`
  }
  banner.hidden = false
}

export function wireBranchDriftBanner() {
  const dismiss = document.getElementById('branchDriftDismiss')
  if (!dismiss) return
  dismiss.addEventListener('click', () => {
    const banner = document.getElementById('branchDriftBanner')
    const branch = (window._updatesStatus && window._updatesStatus.branch) || ''
    try { if (branch) localStorage.setItem(BRANCH_DRIFT_DISMISS_PREFIX + branch, '1') } catch { /* storage blocked */ }
    if (banner) banner.hidden = true
  })
}

function renderBranchNotice(status) {
  const el = document.getElementById('updatesBranchNotice')
  if (!el) return
  const branch = status && status.branch
  if (!branch) { el.hidden = true; return }
  if (branch === 'main') {
    el.className = 'updates-branch-notice ok'
    el.innerHTML = `${t('branch_drift.notice.on_main')} (<code>main</code>)`
  } else {
    el.className = 'updates-branch-notice warn'
    el.innerHTML =
      `${t('branch_drift.notice.off_main', { branch: `<code>${escapeHtmlUpdates(branch)}</code>` })}<br>` +
      `${t('branch_drift.notice.heal')} <code>${BRANCH_HEAL_COMMAND}</code>`
  }
  el.hidden = false
}

async function pollUpdatesBadge() {
  try {
    const res = await fetch('/api/updates')
    if (!res.ok) return
    const data = await res.json()
    window._updatesStatus = data
    renderUpdatesBadge(data)
    updateBranchDriftUI(data)
  } catch {}
}

export async function loadUpdates() {
  const summary = document.getElementById('updatesSummary')
  const list = document.getElementById('updatesCommitList')
  const applyBtn = document.getElementById('updatesApplyBtn')
  summary.textContent = t('updates.checking')
  summary.className = 'updates-summary'
  list.innerHTML = ''
  try {
    const res = await fetch('/api/updates')
    if (!res.ok) throw new Error('HTTP ' + res.status)
    const data = await res.json()
    window._updatesStatus = data
    renderUpdatesBadge(data)
    updateBranchDriftUI(data)
    renderBranchNotice(data)
    const cur = (data.current || '').slice(0, 7) || '–'
    const lat = (data.latest || '').slice(0, 7) || '–'
    if (data.error) {
      summary.className = 'updates-summary error'
      summary.innerHTML = `<strong>${t('updates.check_failed')}:</strong> ${escapeHtmlUpdates(data.error)}<br>${t('updates.current_label')} <code>${cur}</code>`
      applyBtn.hidden = true
    } else if (data.behind === 0) {
      summary.className = 'updates-summary up-to-date'
      summary.innerHTML = `<strong>${t('updates.up_to_date_html')}</strong> (<code>${cur}</code>). ${t('updates.no_changes')}`
      applyBtn.hidden = true
    } else {
      summary.className = 'updates-summary behind'
      const versions = (data.releases || []).filter((r) => r.version)
      if (versions.length > 0) {
        // Version-centric: "N uj verzio elerheto (v1.21.0)".
        summary.innerHTML = `<strong>${t('updates.versions_available', { n: versions.length })}</strong> <code>${escapeHtmlUpdates(versions[0].version)}</code>`
      } else {
        // Pre-release: unreleased commits but no new version tag yet.
        summary.innerHTML = `<strong>${t('updates.changes_available')}</strong> ${t('updates.available_on', { remote: `<code>${escapeHtmlUpdates(data.remote)}</code>` })}`
      }
      applyBtn.hidden = false
    }
    const commitCard = (c) => `
        <div class="updates-commit">
          <div class="updates-commit-head">
            <span>${escapeHtmlUpdates(c.short)} · ${escapeHtmlUpdates(c.author)}</span>
            <span>${escapeHtmlUpdates((c.date || '').slice(0, 10))}</span>
          </div>
          <div class="updates-commit-msg">${escapeHtmlUpdates(c.message)}</div>
        </div>`
    if (data.releases && data.releases.length) {
      // Version-centric: the human-language summary per version is the primary
      // content; the raw commit list (SHAs, conventional-commit prefixes, author
      // names) is tucked behind a collapsed "details" so it is never the first
      // thing the operator sees.
      list.innerHTML = data.releases.map((rel) => {
        const isUpcoming = !rel.version
        const label = isUpcoming ? t('updates.group.upcoming') : escapeHtmlUpdates(rel.version)
        const human = rel.summary
          ? escapeHtmlUpdates(rel.summary)
          : (isUpcoming ? t('updates.upcoming_note') : '')
        return `
        <div class="updates-version">
          <div class="updates-version-tag">${label}</div>
          ${human ? `<div class="updates-version-summary">${human}</div>` : ''}
          <details class="updates-version-details">
            <summary>${t('updates.details', { n: rel.commits.length })}</summary>
            <div class="updates-commit-list">${rel.commits.map(commitCard).join('')}</div>
          </details>
        </div>`
      }).join('')
    } else if (data.commits && data.commits.length) {
      list.innerHTML = data.commits.map(commitCard).join('')
    } else if (data.behind === 0) {
      list.innerHTML = `<p style="color:var(--text-muted);font-size:13px">${t('updates.no_changes')}</p>`
    }
  } catch (err) {
    summary.className = 'updates-summary error'
    summary.textContent = 'Hiba: ' + (err.message || err)
    applyBtn.hidden = true
  }
  renderDiagnoseOffer()
}

// Post-rollback diagnosis offer (PR-D). Reads /api/updates/status: if the last
// update failed/rolled-back and this host can run a Claude agent, offer the
// opt-in fixer; if it cannot (AVX), show a manual-intervention note instead.
async function renderDiagnoseOffer() {
  const box = document.getElementById('updatesDiagnose')
  if (!box) return
  let data
  try { data = await (await fetch('/api/updates/status')).json() } catch { box.hidden = true; return }
  if (data.needsHuman) {
    box.hidden = false
    box.className = 'updates-diagnose needs-human'
    box.innerHTML = `<strong>${escapeHtmlUpdates(t('updates.diagnose.title'))}</strong><p>${escapeHtmlUpdates(t('updates.diagnose.needs_human'))}</p>`
    return
  }
  if (!data.canDiagnose) { box.hidden = true; box.innerHTML = ''; return }
  box.hidden = false
  box.className = 'updates-diagnose'
  box.innerHTML = `<strong>${escapeHtmlUpdates(t('updates.diagnose.title'))}</strong>`
    + `<p>${escapeHtmlUpdates(t('updates.diagnose.body'))}</p>`
    + `<button class="btn-secondary btn-compact" id="updatesDiagnoseBtn">${escapeHtmlUpdates(t('updates.diagnose.btn'))}</button>`
  document.getElementById('updatesDiagnoseBtn').addEventListener('click', runDiagnose)
}

async function runDiagnose() {
  if (!confirm(t('updates.diagnose.consent'))) return
  const btn = document.getElementById('updatesDiagnoseBtn')
  if (btn) btn.disabled = true
  try {
    const res = await fetch('/api/updates/diagnose', { method: 'POST' })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) {
      if (btn) btn.disabled = false
      showToast(t('updates.diagnose.failed', { msg: data.error || ('HTTP ' + res.status) }))
      return
    }
    showToast(data.already ? t('updates.diagnose.already') : t('updates.diagnose.started'))
    if (btn) { btn.hidden = true }
  } catch (err) {
    if (btn) btn.disabled = false
    showToast(t('updates.diagnose.failed', { msg: err.message || err }))
  }
}

async function runUpdate(autoStash) {
  const btn = document.getElementById('updatesApplyBtn')
  btn.disabled = true
  btn.querySelector('.btn-text').hidden = true
  btn.querySelector('.btn-loading').hidden = false
  const resetBtn = () => {
    btn.disabled = false
    btn.querySelector('.btn-text').hidden = false
    btn.querySelector('.btn-loading').hidden = true
  }
  try {
    const res = await fetch('/api/updates/apply', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ autoStash: autoStash === true }),
    })
    // Parse the body regardless of status so preflight reasons
    // (not-on-main / dirty-tree / detached-head returned as 409 by
    // the backend) land in the toast instead of a bare "HTTP 409".
    const data = await res.json().catch(() => ({}))
    if (!res.ok) {
      resetBtn()
      // dirty-tree without autoStash: offer the auto-stash retry inline.
      if (data.reason === 'dirty-tree' && !autoStash) {
        if (confirm(t('updates.confirm.stash'))) {
          await runUpdate(true)
        }
        return
      }
      showToast(t('updates.toast.not_started', { msg: data.error || ('HTTP ' + res.status) }))
      return
    }
    showToast(t('updates.toast.applying'))
    // Poll the real outcome instead of a blind timed reload. update.sh (and its
    // detached finalizer) write store/update.last-result on exit, so we surface
    // success / rolled-back / failed rather than a false "done" that reloads
    // into an unchanged (or dead) dashboard.
    await pollUpdateOutcome(resetBtn)
  } catch (err) {
    resetBtn()
    showToast(t('updates.toast.error', {msg: err.message || err}))
  }
}

// Poll /api/updates/status until the run finishes (pidfile gone AND a fresh
// result is present), then show the true outcome. Reload only on success.
async function pollUpdateOutcome(resetBtn) {
  const startedAt = Date.now()
  const deadline = startedAt + 5 * 60_000   // hard cap: 5 min
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 3000))
    let data
    try {
      const res = await fetch('/api/updates/status')
      data = await res.json()
    } catch {
      // Dashboard is mid-restart (expected): keep polling.
      continue
    }
    const result = data && data.result
    const fresh = result && typeof result.ts === 'number' && result.ts * 1000 >= startedAt - 5000
    if (data && !data.running && fresh) {
      const st = result.status
      if (st === 'success') {
        showToast(t('updates.toast.success', { old: result.old || '', new: result.new || '' }))
        setTimeout(() => window.location.reload(), 2000)
        return
      }
      if (st === 'rolled-back') {
        if (resetBtn) resetBtn()
        showToast(t('updates.toast.rolled_back', { old: result.old || '', msg: result.message || '' }))
        renderDiagnoseOffer()
        return
      }
      // failed
      if (resetBtn) resetBtn()
      showToast(t('updates.toast.failed', { phase: result.phase || '?', msg: result.message || ('code ' + result.code) }))
      renderDiagnoseOffer()
      return
    }
  }
  if (resetBtn) resetBtn()
  showToast(t('updates.toast.status_timeout'))
}

export function initUpdates() {
  document.getElementById('updatesCheckBtn').addEventListener('click', async () => {
    const btn = document.getElementById('updatesCheckBtn')
    btn.disabled = true
    try { await fetch('/api/updates/check', { method: 'POST' }) } catch {}
    await loadUpdates()
    btn.disabled = false
  })

  document.getElementById('updatesApplyBtn').addEventListener('click', async () => {
    if (!confirm(t('updates.confirm.apply'))) return
    await runUpdate(false)
  })

  // Poll the badge on startup and every 5 min so the nav link reflects
  // the cached status even on tabs other than the Updates page.
  pollUpdatesBadge()
  setInterval(pollUpdatesBadge, 5 * 60_000)
}

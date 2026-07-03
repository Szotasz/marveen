import { t } from '/js/core/i18n.js'
import { showToast } from '/js/core/ui.js'

// === Updates page ===
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}

function renderUpdatesBadge(status) {
  const badge = document.getElementById('updatesBadge')
  if (!badge) return
  if (status && status.behind && status.behind > 0) {
    badge.textContent = String(status.behind)
    badge.hidden = false
  } else {
    badge.hidden = true
  }
}

async function pollUpdatesBadge() {
  try {
    const res = await fetch('/api/updates')
    if (!res.ok) return
    renderUpdatesBadge(await res.json())
  } catch {}
}

async function loadUpdates() {
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
    renderUpdatesBadge(data)
    const cur = (data.current || '').slice(0, 7) || '–'
    const lat = (data.latest || '').slice(0, 7) || '–'
    if (data.error) {
      summary.className = 'updates-summary error'
      summary.innerHTML = `<strong>${t('updates.check_failed')}:</strong> ${escapeHtml(data.error)}<br>${t('updates.current_label')} <code>${cur}</code>`
      applyBtn.hidden = true
    } else if (data.behind === 0) {
      summary.className = 'updates-summary up-to-date'
      summary.innerHTML = `<strong>${t('updates.up_to_date_html')}</strong> (<code>${cur}</code>). ${t('updates.no_changes')}`
      applyBtn.hidden = true
    } else {
      summary.className = 'updates-summary behind'
      summary.innerHTML = `<strong>${t('updates.behind', { n: data.behind })}</strong> ${t('updates.available_on', { remote: `<code>${escapeHtml(data.remote)}</code>` })}<br>${t('updates.current_label')} <code>${cur}</code> → ${t('updates.latest_label')} <code>${lat}</code>`
      applyBtn.hidden = false
    }
    if (data.commits && data.commits.length) {
      list.innerHTML = data.commits.map(c => `
        <div class="updates-commit">
          <div class="updates-commit-head">
            <span>${escapeHtml(c.short)} · ${escapeHtml(c.author)}</span>
            <span>${escapeHtml((c.date || '').slice(0, 10))}</span>
          </div>
          <div class="updates-commit-msg">${escapeHtml(c.message)}</div>
        </div>
      `).join('')
    } else if (data.behind === 0) {
      list.innerHTML = `<p style="color:var(--text-muted);font-size:13px">${t('updates.no_changes')}</p>`
    }
  } catch (err) {
    summary.className = 'updates-summary error'
    summary.textContent = 'Hiba: ' + (err.message || err)
    applyBtn.hidden = true
  }
}

document.getElementById('updatesCheckBtn').addEventListener('click', async () => {
  const btn = document.getElementById('updatesCheckBtn')
  btn.disabled = true
  try { await fetch('/api/updates/check', { method: 'POST' }) } catch {}
  await loadUpdates()
  btn.disabled = false
})

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
    showToast(t('updates.toast.started'))
    setTimeout(() => window.location.reload(), 30000)
  } catch (err) {
    resetBtn()
    showToast(t('updates.toast.error', {msg: err.message || err}))
  }
}

document.getElementById('updatesApplyBtn').addEventListener('click', async () => {
  if (!confirm(t('updates.confirm.apply'))) return
  await runUpdate(false)
})

// Poll the badge on startup and every 5 min so the nav link reflects
// the cached status even on tabs other than the Updates page.
pollUpdatesBadge()
setInterval(pollUpdatesBadge, 5 * 60_000)

export { loadUpdates, pollUpdatesBadge }

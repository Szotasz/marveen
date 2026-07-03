import { t } from '/js/core/i18n.js'
import { showToast } from '/js/core/ui.js'

// === Autonomy ===
// ============================================================

document.getElementById('refreshAutonomyBtn').addEventListener('click', loadAutonomy)

async function loadAutonomy() {
  const grid = document.getElementById('autonomyGrid')
  const footer = document.getElementById('autonomyUpdatedAt')
  grid.innerHTML = `<p style="color:var(--text-muted);font-size:13px">${t('autonomy.loading')}</p>`

  try {
    const res = await fetch('/api/autonomy')
    if (!res.ok) throw new Error('fetch failed')
    const config = await res.json()

    grid.innerHTML = ''
    for (const cat of config.categories) {
      const isCapped = !cat.locked && cat.maxLevel < 3
      const row = document.createElement('div')
      row.className = 'autonomy-row' + (cat.locked ? ' locked' : '') + (isCapped ? ' capped' : '')

      const label = document.createElement('div')
      label.className = 'autonomy-row-label'
      label.textContent = cat.label

      const levels = document.createElement('div')
      levels.className = 'autonomy-levels'

      for (let l = 1; l <= 3; l++) {
        const btn = document.createElement('button')
        const isOver = l > cat.maxLevel
        btn.className = 'autonomy-level-btn' + (l === cat.level ? ' active' : '') + (isOver ? ' over-cap' : '')
        btn.dataset.level = String(l)
        btn.textContent = String(l)
        btn.disabled = cat.locked || isOver
        if (!cat.locked && !isOver) {
          btn.addEventListener('click', () => setAutonomyLevel(cat.key, l))
        }
        levels.appendChild(btn)
      }

      row.appendChild(label)
      if (cat.locked) {
        const lock = document.createElement('div')
        lock.className = 'autonomy-row-lock'
        lock.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg> ${t('autonomy.lock_label')}`
        row.appendChild(lock)
      } else if (isCapped) {
        const cap = document.createElement('div')
        cap.className = 'autonomy-row-cap'
        cap.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg> ${t('autonomy.cap_label', { n: cat.maxLevel })}`
        row.appendChild(cap)
      }
      row.appendChild(levels)
      grid.appendChild(row)
    }

    if (config.updated_at > 0) {
      const d = new Date(config.updated_at * 1000)
      footer.textContent = t('autonomy.last_modified', { date: d.toLocaleString('hu-HU') })
    } else {
      footer.textContent = t('autonomy.not_modified')
    }
  } catch (err) {
    grid.innerHTML = `<p style="color:var(--danger)">${t('autonomy.error')}</p>`
    footer.textContent = ''
  }
}

async function setAutonomyLevel(key, level) {
  try {
    const res = await fetch('/api/autonomy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key, level }),
    })
    if (!res.ok) {
      const data = await res.json().catch(() => ({}))
      showToast(data.error || 'Hiba')
      return
    }
    loadAutonomy()
  } catch {
    showToast(t('kanban.toast.save_error'))
  }
}

export { loadAutonomy }

import { escapeHtml } from './util.js'
import { t } from './i18n.js'


// ============================================================
// === Status ===
// ============================================================

// Statuspage component status -> short label for non-operational states.
const STATUS_COMPONENT_LABELS = {
  operational: () => t('status.comp.operational'),
  degraded_performance: () => t('status.comp.degraded'),
  partial_outage: () => t('status.comp.partial_outage'),
  major_outage: () => t('status.comp.major_outage'),
  under_maintenance: () => t('status.comp.maintenance'),
}

export async function loadStatus() {
  const overallEl = document.getElementById('statusOverall')
  const gridEl = document.getElementById('statusServiceGrid')
  const listEl = document.getElementById('statusIncidentList')

  overallEl.className = 'status-overall unknown'
  overallEl.textContent = t('status.loading')
  gridEl.innerHTML = ''
  listEl.innerHTML = ''

  try {
    const res = await fetch('/api/status')
    const data = await res.json()

    // Overall status
    const overallLabels = {
      operational: () => t('status.overall.operational'),
      degraded: () => t('status.overall.degraded'),
      unknown: () => t('status.overall.unknown'),
    }
    overallEl.className = `status-overall ${data.overall}`
    const overallLabelRaw = overallLabels[data.overall]
    overallEl.textContent = overallLabelRaw ? (typeof overallLabelRaw === 'function' ? overallLabelRaw() : overallLabelRaw) : data.overall

    // Services grid: real per-service status from the Statuspage components API
    // (data.components). No more inventing a service list and substring-matching
    // incident text -- if the components feed is unavailable we say so honestly
    // instead of rendering a fake all-green grid.
    const components = Array.isArray(data.components) ? data.components : []
    if (components.length === 0) {
      gridEl.innerHTML = `<div class="status-service-empty" style="color:var(--text-muted);font-size:13px">${t('status.no_components')}</div>`
    } else {
      for (const c of components) {
        const ok = c.status === 'operational'
        const div = document.createElement('div')
        div.className = 'status-service'
        div.innerHTML = `
          <div class="status-service-dot ${ok ? 'operational' : 'degraded'}"></div>
          <span class="status-service-name">${escapeHtml(c.name)}</span>
          ${ok ? '' : `<span class="status-service-state" style="margin-left:auto;font-size:11px;color:var(--text-muted)">${escapeHtml((typeof STATUS_COMPONENT_LABELS[c.status] === 'function' ? STATUS_COMPONENT_LABELS[c.status]() : STATUS_COMPONENT_LABELS[c.status]) || c.status)}</span>`}
        `
        gridEl.appendChild(div)
      }
    }

    // Incidents
    if (data.incidents.length === 0) {
      listEl.innerHTML = `<div class="status-loading">${t('status.no_incidents')}</div>`
    } else {
      for (const inc of data.incidents) {
        const statusLabels = {
          resolved: () => t('status.incident.resolved'),
          monitoring: () => t('status.incident.monitoring'),
          identified: () => t('status.incident.identified'),
          investigating: () => t('status.incident.investigating'),
        }
        const div = document.createElement('div')
        div.className = `status-incident ${inc.status}`
        const date = new Date(inc.pubDate).toLocaleString('hu-HU', { timeZone: 'Europe/Budapest' })
        div.innerHTML = `
          <div class="status-incident-header">
            <span class="status-incident-title">${escapeHtml(inc.title)}</span>
            <span class="status-incident-badge ${inc.status}">${(typeof statusLabels[inc.status] === 'function' ? statusLabels[inc.status]() : statusLabels[inc.status]) || inc.status}</span>
          </div>
          <div class="status-incident-desc">${escapeHtml(inc.description.slice(0, 300))}</div>
          <div class="status-incident-date">${date}</div>
        `
        listEl.appendChild(div)
      }
    }
  } catch {
    overallEl.className = 'status-overall unknown'
    overallEl.textContent = 'Nem sikerult betolteni a statuszt'
  }
}

// ============================================================
export function initStatus() {
  document.getElementById('refreshStatusBtn')?.addEventListener('click', loadStatus)
}

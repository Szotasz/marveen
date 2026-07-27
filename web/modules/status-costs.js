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
// === CostOps (v0.1, PR #524): local cost ledger summary ===
// ============================================================

export async function loadCosts() {
  const el = document.getElementById('costsContent')
  const mutedStyle = 'color:var(--text-muted);font-size:13px'
  el.innerHTML = `<div style="${mutedStyle}">${t('costs.loading')}</div>`
  try {
    const res = await fetch('/api/costs/summary')
    const s = await res.json()
    if (!res.ok) throw new Error(s?.error || 'request failed')

    const fmtMoney = (n) => (typeof n === 'number' ? n.toLocaleString('hu-HU') : '—') + ' ' + escapeHtml(s.currency || '')

    let html = ''

    if (!s.config_present) {
      html += `<div style="${mutedStyle};margin-bottom:12px">${t('costs.no_config')}</div>`
    }

    html += `<div class="overview-stats">
      <div class="overview-stat"><div class="overview-stat-value">${fmtMoney(s.current_spend)}</div><div class="overview-stat-label">${t('costs.current_spend')}</div></div>
      <div class="overview-stat"><div class="overview-stat-value">${fmtMoney(s.forecast_month_end)}</div><div class="overview-stat-label">${t('costs.forecast')}</div></div>
      <div class="overview-stat"><div class="overview-stat-value">${escapeHtml(s.month || '—')}</div><div class="overview-stat-label">${t('costs.month')}</div></div>
    </div>`

    if (s.budget) {
      const pct = Math.round((s.budget.used_pct || 0) * 100)
      const color = s.budget.status === 'hard' ? 'var(--danger,#e74c3c)' : s.budget.status === 'warning' ? 'var(--warn,#e0a800)' : 'var(--text-muted)'
      html += `<div style="margin-top:16px;padding:12px 16px;border:1px solid var(--border,#333);border-radius:8px">
        <div style="font-weight:600;margin-bottom:6px">${t('costs.budget_title')}: ${escapeHtml(s.budget.id)} (${fmtMoney(s.budget.amount)})</div>
        <div style="${mutedStyle}">${t('costs.budget_used')}: <strong style="color:${color}">${pct}%</strong></div>
      </div>`
    }

    const sources = Array.isArray(s.all_sources) ? s.all_sources : []
    if (sources.length === 0) {
      html += `<div style="${mutedStyle};margin-top:12px">${t('costs.no_sources')}</div>`
    } else {
      html += `<div style="overflow-x:auto;margin-top:16px"><table style="width:100%;border-collapse:collapse">
        <thead><tr style="text-align:left;border-bottom:1px solid var(--border,#333)">
          <th style="padding:6px 8px">${t('costs.source_name')}</th><th style="padding:6px 8px">${t('costs.source_provider')}</th><th style="padding:6px 8px">${t('costs.source_spend')}</th>
        </tr></thead>
        <tbody>${sources.map((src) => `<tr style="border-bottom:1px solid var(--border,#222)">
          <td style="padding:6px 8px">${escapeHtml(src.name)}</td>
          <td style="padding:6px 8px;${mutedStyle}">${escapeHtml(src.provider)}</td>
          <td style="padding:6px 8px">${fmtMoney(src.spend)}</td>
        </tr>`).join('')}</tbody>
      </table></div>`
    }

    html += `<p style="${mutedStyle};margin-top:16px">${t('costs.token_usage_note')} (${(s.token_usage?.calls ?? 0)} ${t('costs.calls')}, ${(s.token_usage?.input_tokens ?? 0) + (s.token_usage?.output_tokens ?? 0)} tokens)</p>`

    el.innerHTML = html
  } catch {
    el.innerHTML = `<div style="${mutedStyle}">${t('costs.load_failed')}</div>`
  }
}

export function initStatusCosts() {
  document.getElementById('refreshStatusBtn')?.addEventListener('click', loadStatus)
  document.getElementById('refreshCostsBtn')?.addEventListener('click', loadCosts)
}

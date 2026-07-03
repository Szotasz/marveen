import { t } from '/js/core/i18n.js'
import { escapeHtml } from '/js/core/dom.js'

// === Token Usage Monitor ===
const TU_COLORS = {
  marveen: '#6366f1',
  codi: '#f59e0b',
  dexi: '#ec4899',
  finci: '#10b981',
  hilti: '#ef4444',
  szurcsi: '#8b5cf6',
}
let tuSelectedAgent = ''
let tuChartState = null

function tuGetColor(agent) {
  return TU_COLORS[agent] || '#64748b'
}

function tuFormatTokens(n) {
  if (n == null || isNaN(n)) return '0'
  if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B'
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M'
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K'
  return String(n)
}

function tuGetTimeRange() {
  const period = document.getElementById('tuPeriod')?.value || '7d'
  const now = Math.floor(Date.now() / 1000)
  if (period === '1h') return { from: now - 3600, to: now }
  if (period === '24h') return { from: now - 86400, to: now }
  if (period === '7d') return { from: now - 7 * 86400, to: now }
  if (period === '30d') return { from: now - 30 * 86400, to: now }
  return { from: undefined, to: undefined }
}

async function loadTokenUsage() {
  const { from, to } = tuGetTimeRange()
  const agent = tuSelectedAgent

  const params = new URLSearchParams()
  if (from) params.set('from', from)
  if (to) params.set('to', to)

  const summaryRes = await fetch('/api/token-usage/summary?' + params)
  if (!summaryRes.ok) return
  const summary = await summaryRes.json()
  summary.sort((a, b) => {
    const aTotal = (a.totalInput || 0) + (a.totalCacheRead || 0) + (a.totalCacheCreation || 0)
    const bTotal = (b.totalInput || 0) + (b.totalCacheRead || 0) + (b.totalCacheCreation || 0)
    return bTotal - aTotal
  })
  renderTuSummary(summary)

  const agentSelect = document.getElementById('tuAgent')
  if (agentSelect && agentSelect.options.length <= 1) {
    for (const s of summary) {
      const opt = document.createElement('option')
      opt.value = s.agent
      opt.textContent = s.agent
      agentSelect.appendChild(opt)
    }
  }
  if (agentSelect) agentSelect.value = agent

  const period = document.getElementById('tuPeriod')?.value || '7d'
  const bucketMin = period === '1h' ? 5 : 60
  const tlParams = new URLSearchParams(params)
  tlParams.set('bucket', String(bucketMin))
  const tlRes = await fetch('/api/token-usage/timeline?' + tlParams)
  if (!tlRes.ok) return
  const timeline = await tlRes.json()
  renderTuTimeline(timeline, agent)
  renderTuBudgetCards()

  tuDetailSearch = ''
  const searchEl = document.getElementById('tuSearchInput')
  if (searchEl) searchEl.value = ''
  await tuFetchDetails()
}

function renderTuSummary(summary) {
  const el = document.getElementById('tuSummaryCards')
  if (!el) return
  if (!summary.length) {
    el.innerHTML = `<div class="overview-stat"><div class="overview-stat-label">${t('tokenUsage.no_data')}</div><div class="overview-stat-value">0</div><div class="overview-stat-sub">${t('tokenUsage.collect_hint')}</div></div>`
    return
  }
  el.innerHTML = summary.map(s => {
    const totalIn = (s.totalInput || 0) + (s.totalCacheRead || 0) + (s.totalCacheCreation || 0)
    const isActive = tuSelectedAgent === s.agent
    const dimmed = tuSelectedAgent && !isActive
    return `
      <div class="overview-stat tu-agent-card${isActive ? ' tu-active' : ''}" data-agent="${escapeHtml(s.agent)}"
        style="border-left:3px solid ${tuGetColor(s.agent)};cursor:pointer;${dimmed ? 'opacity:0.4;' : ''}transition:opacity 0.2s">
        <div class="overview-stat-label">${escapeHtml(s.agent)}</div>
        <div class="overview-stat-value">${tuFormatTokens(totalIn)}</div>
        <div class="overview-stat-sub">${t('tokenUsage.calls_sub', { calls: (s.totalCalls || 0).toLocaleString(), out: tuFormatTokens(s.totalOutput) })}</div>
      </div>`
  }).join('')

  el.querySelectorAll('.tu-agent-card').forEach(card => {
    card.addEventListener('click', () => {
      const clickedAgent = card.dataset.agent
      if (tuSelectedAgent === clickedAgent) {
        tuSelectedAgent = ''
      } else {
        tuSelectedAgent = clickedAgent
      }
      const agentSelect = document.getElementById('tuAgent')
      if (agentSelect) agentSelect.value = tuSelectedAgent
      loadTokenUsage()
    })
  })
}

function tuGetResetLines(bucketStart, bucketEnd) {
  const lines = []
  // 5h session lines
  const win5h = 5 * 3600
  let t5 = bucketStart - (bucketStart % win5h) + win5h
  while (t5 < bucketEnd) {
    lines.push({ ts: t5, type: '5h', label: '5h' })
    t5 += win5h
  }
  // Daily midnight + weekly Monday midnight
  const d = new Date(bucketStart * 1000)
  d.setHours(0, 0, 0, 0)
  d.setDate(d.getDate() + 1)
  while (d.getTime() / 1000 < bucketEnd) {
    const ts = Math.floor(d.getTime() / 1000)
    const isMonday = d.getDay() === 1
    const near5h = lines.find(l => l.type === '5h' && Math.abs(l.ts - ts) < 1800)
    if (!near5h) lines.push({ ts, type: isMonday ? 'weekly' : 'daily', label: isMonday ? t('tokenUsage.chart.week') : t('tokenUsage.chart.day') })
    else if (isMonday) { near5h.type = 'weekly'; near5h.label = t('tokenUsage.chart.week') }
    d.setDate(d.getDate() + 1)
  }
  return lines
}

function tuFillBuckets(data, bucketSeconds) {
  if (!data.length) return data
  const agents = [...new Set(data.map(d => d.agent))]
  const bucketMap = {}
  for (const d of data) {
    const key = d.bucket + ':' + d.agent
    bucketMap[key] = d
  }
  const minB = Math.min(...data.map(d => d.bucket))
  const maxB = Math.max(...data.map(d => d.bucket))
  const filled = []
  for (let b = minB; b <= maxB; b += bucketSeconds) {
    for (const agent of agents) {
      const key = b + ':' + agent
      filled.push(bucketMap[key] || { bucket: b, agent, calls: 0, inputTokens: 0, outputTokens: 0 })
    }
  }
  return filled
}

function tuFormatLocalDate(ts) {
  return new Date(ts * 1000).toLocaleString(undefined, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}

function tuFormatLocalShort(ts) {
  const d = new Date(ts * 1000)
  const period = document.getElementById('tuPeriod')?.value || '7d'
  if (period === '1h' || period === '24h') {
    return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`
  }
  return `${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')} ${String(d.getHours()).padStart(2,'0')}:00`
}

function tuIsPeakHour(ts) {
  const d = new Date(ts * 1000)
  if (d.getDay() === 0 || d.getDay() === 6) return false
  try {
    const ptHour = parseInt(d.toLocaleString('en-US', { timeZone: 'America/Los_Angeles', hour: 'numeric', hour12: false }))
    return ptHour >= 5 && ptHour < 11
  } catch { return false }
}

function tuCalcCumulativeWindows(buckets, bucketTotals, windowSeconds) {
  const result = []
  let windowStart = null
  let cumulative = 0
  for (const b of buckets) {
    const total = bucketTotals[b] || 0
    if (windowStart === null) {
      if (total > 0) { windowStart = b; cumulative = total }
      else { cumulative = 0 }
    } else if (b >= windowStart + windowSeconds) {
      if (total > 0) { windowStart = b; cumulative = total }
      else { windowStart = null; cumulative = 0 }
    } else {
      cumulative += total
    }
    result.push({ bucket: b, cumulative })
  }
  return result
}

let tuBudgetView = ''

function renderTuTimeline(data, filterAgent) {
  const canvas = document.getElementById('tuCanvas')
  if (!canvas) return
  const container = canvas.parentElement
  const dpr = window.devicePixelRatio || 1
  const cssW = container.offsetWidth
  const cssH = 360
  canvas.width = cssW * dpr
  canvas.height = cssH * dpr
  canvas.style.width = cssW + 'px'
  canvas.style.height = cssH + 'px'
  const ctx = canvas.getContext('2d')
  ctx.scale(dpr, dpr)
  ctx.clearRect(0, 0, cssW, cssH)

  const textSecondary = getComputedStyle(document.documentElement).getPropertyValue('--text-secondary').trim() || '#64748b'
  const textPrimary = getComputedStyle(document.documentElement).getPropertyValue('--text-primary').trim() || '#1e293b'
  const borderColor = getComputedStyle(document.documentElement).getPropertyValue('--border').trim() || '#e2e8f0'

  if (!data.length) {
    ctx.fillStyle = textSecondary
    ctx.font = '14px sans-serif'
    ctx.textAlign = 'center'
    ctx.fillText(t('tokenUsage.no_period_data'), cssW / 2, 160)
    tuChartState = null
    return
  }

  renderTuTimeline.__lastData = data
  renderTuTimeline.__lastAgent = filterAgent
  const period = document.getElementById('tuPeriod')?.value || '7d'
  const bucketSec = period === '1h' ? 300 : 3600
  const filled = tuFillBuckets(data, bucketSec)
  const agents = [...new Set(filled.map(d => d.agent))]
  const buckets = [...new Set(filled.map(d => d.bucket))].sort((a, b) => a - b)
  const pad = { top: 20, right: 65, bottom: 70, left: 70 }
  const w = cssW - pad.left - pad.right
  const h = cssH - pad.top - pad.bottom

  const bucketMap = {}
  for (const d of filled) {
    if (!bucketMap[d.bucket]) bucketMap[d.bucket] = {}
    bucketMap[d.bucket][d.agent] = (bucketMap[d.bucket][d.agent] || 0) + (d.inputTokens || 0)
  }

  const bucketTotals = {}
  for (const b of buckets) {
    let sum = 0
    for (const a of agents) sum += (bucketMap[b]?.[a] || 0)
    bucketTotals[b] = sum
  }

  let maxVal = 0
  for (const b of buckets) {
    if (filterAgent) {
      const v = bucketMap[b]?.[filterAgent] || 0
      if (v > maxVal) maxVal = v
    } else {
      if (bucketTotals[b] > maxVal) maxVal = bucketTotals[b]
    }
  }
  if (maxVal === 0) maxVal = 1

  const barW = Math.max(2, Math.min(20, w / buckets.length - 1))
  const barGap = Math.max(0, (w / buckets.length) - barW)
  const bucketRange = buckets[buckets.length - 1] - buckets[0] + bucketSec

  // Peak hours shading
  for (let i = 0; i < buckets.length; i++) {
    if (tuIsPeakHour(buckets[i])) {
      const x = pad.left + (i / buckets.length) * w
      ctx.fillStyle = 'rgba(239, 68, 68, 0.06)'
      ctx.fillRect(x, pad.top, barW + barGap, h)
    }
  }

  // Day/week reset lines
  const resetLines = tuGetResetLines(buckets[0], buckets[buckets.length - 1] + 3600)
  for (const rl of resetLines) {
    const frac = (rl.ts - buckets[0]) / bucketRange
    if (frac < 0 || frac > 1) continue
    const x = pad.left + frac * w
    ctx.save()
    ctx.strokeStyle = rl.type === 'weekly' ? '#ef444480' : rl.type === '5h' ? '#3b82f680' : '#f59e0b60'
    ctx.lineWidth = rl.type === 'weekly' ? 1.5 : 1
    ctx.setLineDash(rl.type === 'weekly' ? [6, 4] : rl.type === '5h' ? [3, 3] : [4, 4])
    ctx.beginPath()
    ctx.moveTo(x, pad.top)
    ctx.lineTo(x, pad.top + h)
    ctx.stroke()
    ctx.restore()
  }

  // Bars (dimmed when budget view is active)
  const barDimmed = tuBudgetView !== ''
  const barRects = []
  for (let i = 0; i < buckets.length; i++) {
    const x = pad.left + (i / buckets.length) * w
    let yOffset = 0
    const segments = []
    const drawAgents = filterAgent ? [filterAgent] : agents
    for (const agent of drawAgents) {
      const val = bucketMap[buckets[i]]?.[agent] || 0
      const barH = (val / maxVal) * h
      ctx.globalAlpha = barDimmed ? 0.2 : 1
      ctx.fillStyle = tuGetColor(agent)
      ctx.fillRect(x, pad.top + h - yOffset - barH, barW, barH)
      ctx.globalAlpha = 1
      if (val > 0) segments.push({ agent, val })
      yOffset += barH
    }
    barRects.push({ x, w: barW + barGap, bucket: buckets[i], segments, totalH: yOffset })
  }

  // Cumulative budget lines
  const win5h = tuCalcCumulativeWindows(buckets, bucketTotals, 5 * 3600)
  const winWeekly = tuCalcCumulativeWindows(buckets, bucketTotals, 7 * 86400)
  const maxCum = Math.max(
    ...win5h.map(w => w.cumulative),
    ...winWeekly.map(w => w.cumulative),
    1
  )

  function drawCumLine(windows, color, lineW, active) {
    ctx.save()
    ctx.strokeStyle = color
    ctx.lineWidth = active ? lineW + 1 : lineW
    ctx.globalAlpha = active ? 1 : (tuBudgetView === '' ? 0.7 : 0.15)
    ctx.setLineDash([])
    ctx.beginPath()
    let prevCum = 0
    for (let i = 0; i < windows.length; i++) {
      const x = pad.left + (i / buckets.length) * w + barW / 2
      const y = pad.top + h - (windows[i].cumulative / maxCum) * h
      if (i === 0) { ctx.moveTo(x, y) }
      else if (windows[i].cumulative < prevCum) {
        ctx.stroke()
        ctx.beginPath()
        ctx.moveTo(x, pad.top + h)
        ctx.lineTo(x, y)
      } else {
        ctx.lineTo(x, y)
      }
      prevCum = windows[i].cumulative
    }
    ctx.stroke()
    ctx.restore()
  }

  const is5hActive = tuBudgetView === '5h'
  const isWeeklyActive = tuBudgetView === 'weekly'
  drawCumLine(winWeekly, '#8b5cf6', 1.5, isWeeklyActive)
  drawCumLine(win5h, '#06b6d4', 2, is5hActive)

  // X axis
  ctx.strokeStyle = borderColor
  ctx.lineWidth = 1
  ctx.setLineDash([])
  ctx.beginPath()
  ctx.moveTo(pad.left, pad.top + h)
  ctx.lineTo(pad.left + w, pad.top + h)
  ctx.stroke()

  // X labels
  ctx.fillStyle = textSecondary
  ctx.font = '11px sans-serif'
  ctx.textAlign = 'center'
  const labelInterval = Math.max(1, Math.floor(buckets.length / 8))
  for (let i = 0; i < buckets.length; i += labelInterval) {
    const x = pad.left + (i / buckets.length) * w + barW / 2
    ctx.fillText(tuFormatLocalShort(buckets[i]), x, pad.top + h + 18)
  }

  // Left Y axis (per-bucket)
  ctx.textAlign = 'right'
  ctx.fillStyle = textSecondary
  ctx.font = '10px sans-serif'
  for (let i = 0; i <= 4; i++) {
    const val = (maxVal / 4) * i
    const y = pad.top + h - (i / 4) * h
    ctx.fillText(tuFormatTokens(val), pad.left - 8, y + 4)
  }

  // Right Y axis (cumulative)
  ctx.textAlign = 'left'
  ctx.fillStyle = '#06b6d4'
  for (let i = 0; i <= 4; i++) {
    const val = (maxCum / 4) * i
    const y = pad.top + h - (i / 4) * h
    ctx.fillText(tuFormatTokens(val), pad.left + w + 6, y + 4)
  }

  // Legend: single dynamic row with wrapping
  let legendY = pad.top + h + 38
  let legendX = pad.left
  const maxLegW = cssW - pad.right
  function legWrap(needed) { if (legendX + needed > maxLegW) { legendX = pad.left; legendY += 16 } }

  ctx.font = '11px sans-serif'
  ctx.textAlign = 'left'
  for (const agent of agents) {
    const tw = ctx.measureText(agent).width + 28
    legWrap(tw)
    ctx.fillStyle = tuGetColor(agent)
    ctx.fillRect(legendX, legendY - 7, 10, 10)
    ctx.fillStyle = textPrimary
    ctx.fillText(agent, legendX + 14, legendY + 2)
    legendX += tw
  }

  const legendHits = []
  const lineItems = [
    { label: t('tokenUsage.chart.window_5h'), color: '#06b6d4', lw: 2, dash: [], id: '5h', active: is5hActive },
    { label: t('tokenUsage.chart.window_weekly'), color: '#8b5cf6', lw: 1.5, dash: [], id: 'weekly', active: isWeeklyActive },
    { label: '5h', color: '#3b82f680', lw: 1, dash: [3, 3] },
    { label: t('tokenUsage.chart.day'), color: '#f59e0b60', lw: 1, dash: [4, 4] },
    { label: t('tokenUsage.chart.week'), color: '#ef444480', lw: 1.5, dash: [6, 4] },
  ]
  for (const li of lineItems) {
    const tw = ctx.measureText(li.label).width + 34
    legWrap(tw)
    ctx.save()
    ctx.strokeStyle = li.color; ctx.lineWidth = li.lw; ctx.setLineDash(li.dash)
    ctx.beginPath(); ctx.moveTo(legendX, legendY - 1); ctx.lineTo(legendX + 16, legendY - 1); ctx.stroke()
    ctx.restore()
    ctx.fillStyle = li.active ? li.color : textSecondary
    ctx.font = li.active ? 'bold 10px sans-serif' : '10px sans-serif'
    ctx.fillText(li.label, legendX + 20, legendY + 2)
    if (li.id) legendHits.push({ x: legendX, y: legendY - 10, w: tw, h: 16, id: li.id })
    legendX += tw
  }
  legWrap(70)
  ctx.fillStyle = 'rgba(239, 68, 68, 0.15)'
  ctx.fillRect(legendX, legendY - 7, 10, 10)
  ctx.fillStyle = textSecondary; ctx.font = '10px sans-serif'
  ctx.fillText('csúcsidő', legendX + 14, legendY + 2)

  // Store legend hit areas for click handling
  tuChartState = { barRects, pad, h, cssW, cssH, maxVal, maxCum, win5h, winWeekly, legendHits }
}

;(function setupTuTooltip() {
  const canvas = document.getElementById('tuCanvas')
  if (!canvas) return
  let tooltip = document.getElementById('tuTooltip')
  if (!tooltip) {
    tooltip = document.createElement('div')
    tooltip.id = 'tuTooltip'
    tooltip.style.cssText = 'position:absolute;background:var(--bg-elevated,#1e293b);color:var(--text-primary,#f8fafc);padding:8px 12px;border-radius:6px;font-size:12px;pointer-events:none;z-index:100;display:none;box-shadow:0 4px 12px rgba(0,0,0,0.3);max-width:240px;line-height:1.5'
    canvas.parentElement.appendChild(tooltip)
  }

  canvas.addEventListener('mousemove', e => {
    if (!tuChartState) return
    const rect = canvas.getBoundingClientRect()
    const mx = e.clientX - rect.left
    const my = e.clientY - rect.top
    const { barRects, pad, h } = tuChartState

    let hit = null
    for (const br of barRects) {
      if (mx >= br.x && mx < br.x + br.w) { hit = br; break }
    }

    if (hit && my >= pad.top && my <= pad.top + h) {
      const isPeak = tuIsPeakHour(hit.bucket)
      let html = `<div style="font-weight:600;margin-bottom:4px">${tuFormatLocalShort(hit.bucket)}${isPeak ? ` <span style="color:#ef4444;font-size:10px">${t('tokenUsage.chart.peak')}</span>` : ''}</div>`
      let total = 0
      for (const seg of hit.segments) {
        html += `<div><span style="color:${tuGetColor(seg.agent)}">&#9632;</span> ${seg.agent}: ${tuFormatTokens(seg.val)}</div>`
        total += seg.val
      }
      if (hit.segments.length > 1) html += `<div style="border-top:1px solid rgba(255,255,255,0.2);margin-top:4px;padding-top:4px;font-weight:600">${t('tokenUsage.total')} ${tuFormatTokens(total)}</div>`
      if (tuChartState.win5h || tuChartState.winWeekly) {
        const idx = barRects.indexOf(hit)
        if (idx >= 0) {
          const c5 = tuChartState.win5h?.[idx]
          const cw = tuChartState.winWeekly?.[idx]
          html += '<div style="border-top:1px solid rgba(255,255,255,0.2);margin-top:4px;padding-top:4px;font-size:11px">'
          if (c5) html += `<div><span style="color:#06b6d4">━</span> 5h ablak: ${tuFormatTokens(c5.cumulative)}</div>`
          if (cw) html += `<div><span style="color:#8b5cf6">━</span> Heti ablak: ${tuFormatTokens(cw.cumulative)}</div>`
          html += '</div>'
        }
      }
      tooltip.innerHTML = html
      tooltip.style.display = 'block'
      const tx = Math.min(e.clientX - rect.left + 12, canvas.parentElement.offsetWidth - 250)
      tooltip.style.left = tx + 'px'
      tooltip.style.top = (my - 10) + 'px'
    } else {
      tooltip.style.display = 'none'
    }
  })

  canvas.addEventListener('mouseleave', () => {
    tooltip.style.display = 'none'
  })

  canvas.addEventListener('click', e => {
    if (!tuChartState?.legendHits) return
    const rect = canvas.getBoundingClientRect()
    const mx = e.clientX - rect.left
    const my = e.clientY - rect.top
    for (const lh of tuChartState.legendHits) {
      if (mx >= lh.x && mx <= lh.x + lh.w && my >= lh.y && my <= lh.y + lh.h) {
        tuBudgetView = tuBudgetView === lh.id ? '' : lh.id
        if (renderTuTimeline.__lastData) renderTuTimeline(renderTuTimeline.__lastData, renderTuTimeline.__lastAgent)
        return
      }
    }
  })
})()

function renderTuBudgetCards() {
  const el = document.getElementById('tuBudgetCards')
  if (!el || !tuChartState) return
  const { win5h, winWeekly } = tuChartState
  const cur5h = win5h?.length ? win5h[win5h.length - 1].cumulative : 0
  const curWeekly = winWeekly?.length ? winWeekly[winWeekly.length - 1].cumulative : 0

  el.innerHTML = `
    <div class="overview-stat tu-budget-card${tuBudgetView === '5h' ? ' tu-active' : ''}" data-budget="5h"
      style="border-left:3px solid #06b6d4;cursor:pointer;${tuBudgetView === 'weekly' ? 'opacity:0.4;' : ''}transition:opacity 0.2s">
      <div class="overview-stat-label">${t('tokenUsage.window_5h_label')}</div>
      <div class="overview-stat-value" style="color:#06b6d4">${tuFormatTokens(cur5h)}</div>
      <div class="overview-stat-sub">${t('tokenUsage.cumulative_sub')}</div>
    </div>
    <div class="overview-stat tu-budget-card${tuBudgetView === 'weekly' ? ' tu-active' : ''}" data-budget="weekly"
      style="border-left:3px solid #8b5cf6;cursor:pointer;${tuBudgetView === '5h' ? 'opacity:0.4;' : ''}transition:opacity 0.2s">
      <div class="overview-stat-label">${t('tokenUsage.window_weekly_label')}</div>
      <div class="overview-stat-value" style="color:#8b5cf6">${tuFormatTokens(curWeekly)}</div>
      <div class="overview-stat-sub">${t('tokenUsage.cumulative_sub')}</div>
    </div>`

  el.querySelectorAll('.tu-budget-card').forEach(card => {
    card.addEventListener('click', () => {
      const id = card.dataset.budget
      tuBudgetView = tuBudgetView === id ? '' : id
      if (renderTuTimeline.__lastData) renderTuTimeline(renderTuTimeline.__lastData, renderTuTimeline.__lastAgent)
      renderTuBudgetCards()
    })
  })
}

let tuDetailData = []
let tuDetailSort = { col: 'timestamp', dir: 'desc' }
let tuDetailSearch = ''
let tuSearchTimer = null

function tuSortDetails(data) {
  return [...data].sort((a, b) => {
    const { col, dir } = tuDetailSort
    let va, vb
    if (col === 'input') {
      va = (a.input_tokens || 0) + (a.cache_read_tokens || 0) + (a.cache_creation_tokens || 0)
      vb = (b.input_tokens || 0) + (b.cache_read_tokens || 0) + (b.cache_creation_tokens || 0)
    } else if (col === 'output') {
      va = a.output_tokens || 0; vb = b.output_tokens || 0
    } else if (col === 'agent') {
      va = a.agent || ''; vb = b.agent || ''
      return dir === 'asc' ? va.localeCompare(vb) : vb.localeCompare(va)
    } else {
      va = a.timestamp || 0; vb = b.timestamp || 0
    }
    return dir === 'asc' ? va - vb : vb - va
  })
}

function renderTuDetailsTable() {
  const tbody = document.getElementById('tuDetailsTbody')
  const countEl = document.getElementById('tuDetailsCount')
  if (!tbody) return

  const sorted = tuSortDetails(tuDetailData)
  if (countEl) countEl.textContent = `${sorted.length} sor`

  if (!sorted.length) {
    tbody.innerHTML = `<tr><td colspan="5" style="color:var(--text-secondary);font-size:13px;text-align:center;padding:16px">${t('tokenUsage.no_calls')}</td></tr>`
    return
  }

  tbody.innerHTML = sorted.map(d => {
    const totalIn = (d.input_tokens || 0) + (d.cache_read_tokens || 0) + (d.cache_creation_tokens || 0)
    const timeStr = tuFormatLocalDate(d.timestamp)
    const preview = d.content_preview ? d.content_preview.slice(0, 80) + (d.content_preview.length > 80 ? '...' : '') : ''
    const taskInfo = d.task_title ? `<span style="color:var(--text-secondary);font-size:11px"> [${escapeHtml(d.task_title)}]</span>` : ''
    return `<tr>
      <td style="white-space:nowrap">${timeStr}</td>
      <td><span style="color:${tuGetColor(d.agent)};font-weight:600">${escapeHtml(d.agent)}</span>${taskInfo}</td>
      <td style="text-align:right;font-variant-numeric:tabular-nums">${tuFormatTokens(totalIn)}</td>
      <td style="text-align:right;font-variant-numeric:tabular-nums">${tuFormatTokens(d.output_tokens)}</td>
      <td style="font-size:12px;color:var(--text-secondary);max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${escapeHtml(preview || '')}">${d.tool_name ? '<code>' + escapeHtml(d.tool_name) + '</code> ' : ''}${escapeHtml(preview)}</td>
    </tr>`
  }).join('')
}

function renderTuDetails(data) {
  if (data) tuDetailData = data
  const el = document.getElementById('tuDetailsTable')
  if (!el) return

  if (!document.getElementById('tuDetailsTbody')) {
    const arrow = col => tuDetailSort.col === col ? (tuDetailSort.dir === 'asc' ? ' ▲' : ' ▼') : ''
    const thStyle = 'cursor:pointer;user-select:none'
    const thStyleR = thStyle + ';text-align:right'
    el.innerHTML = `<div style="margin-bottom:8px;display:flex;align-items:center;gap:8px;flex-wrap:wrap">
      <input id="tuSearchInput" type="text" placeholder="${t('tokenUsage.search_placeholder')}"
        style="padding:4px 8px;border:1px solid var(--border);border-radius:4px;background:var(--bg-primary);color:var(--text-primary);width:260px;font-size:13px">
      <span id="tuDetailsCount" style="color:var(--text-secondary);font-size:12px"></span>
    </div>
    <div style="overflow-x:auto"><table class="mem-table" style="width:100%;min-width:600px">
      <thead><tr>
        <th style="${thStyle}" data-sort="timestamp">${t('tokenUsage.col.time')}${arrow('timestamp')}</th>
        <th style="${thStyle}" data-sort="agent">${t('tokenUsage.col.agent')}${arrow('agent')}</th>
        <th style="${thStyleR}" data-sort="input">Input${arrow('input')}</th>
        <th style="${thStyleR}" data-sort="output">Output${arrow('output')}</th>
        <th>${t('tokenUsage.col.content')}</th>
      </tr></thead>
      <tbody id="tuDetailsTbody"></tbody>
    </table></div>`

    el.querySelectorAll('th[data-sort]').forEach(th => {
      th.addEventListener('click', () => {
        const col = th.dataset.sort
        if (tuDetailSort.col === col) {
          tuDetailSort.dir = tuDetailSort.dir === 'asc' ? 'desc' : 'asc'
        } else {
          tuDetailSort = { col, dir: col === 'agent' ? 'asc' : 'desc' }
        }
        th.closest('thead').querySelectorAll('th[data-sort]').forEach(h => {
          const c = h.dataset.sort
          const arrow = tuDetailSort.col === c ? (tuDetailSort.dir === 'asc' ? ' ▲' : ' ▼') : ''
          const labels = { timestamp: t('tokenUsage.col.time'), agent: t('tokenUsage.col.agent'), input: 'Input', output: 'Output' }
          h.textContent = (labels[c] || c) + arrow
        })
        renderTuDetailsTable()
      })
    })

    document.getElementById('tuSearchInput').addEventListener('input', e => {
      tuDetailSearch = e.target.value
      clearTimeout(tuSearchTimer)
      tuSearchTimer = setTimeout(() => tuFetchDetails(), 400)
    })
  }

  renderTuDetailsTable()
}

async function tuFetchDetails() {
  const { from, to } = tuGetTimeRange()
  const agent = tuSelectedAgent
  const minTokens = document.getElementById('tuMinTokens')?.value || '50000'
  const params = new URLSearchParams()
  if (from) params.set('from', from)
  if (to) params.set('to', to)
  if (agent) params.set('agent', agent)
  if (!tuDetailSearch) params.set('min_tokens', minTokens)
  if (tuDetailSearch) params.set('q', tuDetailSearch)
  params.set('limit', '200')
  const detailRes = await fetch('/api/token-usage?' + params)
  if (!detailRes.ok) return
  const details = await detailRes.json()
  renderTuDetails(details)
}

document.getElementById('tuCollectBtn')?.addEventListener('click', async () => {
  const btn = document.getElementById('tuCollectBtn')
  btn.disabled = true
  btn.textContent = t('tokenUsage.collect_btn.collecting')
  try {
    const res = await fetch('/api/token-usage/collect', { method: 'POST' }).then(r => r.json())
    btn.textContent = t('tokenUsage.collect_done', { n: res.inserted || 0 })
    setTimeout(() => { btn.textContent = t('tokenUsage.collect_btn.collect'); btn.disabled = false }, 2000)
    loadTokenUsage()
  } catch {
    btn.textContent = t('tokenUsage.collect_error')
    setTimeout(() => { btn.textContent = t('tokenUsage.collect_btn.collect'); btn.disabled = false }, 2000)
  }
})

document.getElementById('tuPeriod')?.addEventListener('change', () => { tuSelectedAgent = ''; loadTokenUsage() })
document.getElementById('tuAgent')?.addEventListener('change', () => { tuSelectedAgent = document.getElementById('tuAgent').value; loadTokenUsage() })
document.getElementById('tuMinTokens')?.addEventListener('change', () => tuFetchDetails())

window.addEventListener('resize', () => {
  if (!document.getElementById('tokenUsagePage')?.hidden) {
    if (tuChartState && renderTuTimeline.__lastData) renderTuTimeline(renderTuTimeline.__lastData, renderTuTimeline.__lastAgent)
  }
})

export { loadTokenUsage }

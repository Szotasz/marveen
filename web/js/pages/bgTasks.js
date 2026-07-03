import { t } from '/js/core/i18n.js'
import { showToast } from '/js/core/ui.js'

// ============================================================
// === Background Tasks ===
// ============================================================

let bgInitialized = false
let bgRefreshTimer = null

async function loadBgTasksPage() {
  if (!bgInitialized) {
    bgInitialized = true
    try {
      // Use /api/schedules/agents (not /api/agents) so the main agent is a
      // selectable background-task target too -- /api/agents lists sub-agents
      // only, while the backend (spawnBackgroundTask) accepts any agent_id.
      const res = await fetch('/api/schedules/agents')
      if (res.ok) {
        const agents = await res.json()
        const sel = document.getElementById('bgAgent')
        agents.forEach(a => {
          const opt = document.createElement('option')
          opt.value = a.name
          opt.textContent = a.label || a.name
          sel.appendChild(opt)
        })
        if (agents.length === 1) sel.value = agents[0].name
      }
    } catch {}

    document.getElementById('bgStartBtn').addEventListener('click', startBgTask)
    document.getElementById('bgPrompt').addEventListener('keydown', e => { if (e.key === 'Enter') startBgTask() })
    document.getElementById('bgShowAll').addEventListener('change', loadBgTasks)
  }
  loadBgTasks()
  if (bgRefreshTimer) clearInterval(bgRefreshTimer)
  bgRefreshTimer = setInterval(loadBgTasks, 10000)
}

async function startBgTask() {
  const agent = document.getElementById('bgAgent').value
  const prompt = document.getElementById('bgPrompt').value.trim()
  if (!agent) { showToast(t('bgTasks.select_agent')); return }
  if (!prompt) { showToast(t('bgTasks.enter_task')); return }

  const btn = document.getElementById('bgStartBtn')
  btn.disabled = true
  try {
    const res = await fetch('/api/background-tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent_id: agent, prompt }),
    })
    const data = await res.json()
    if (!res.ok) {
      showToast(data.error || t('common.error'))
      return
    }
    document.getElementById('bgPrompt').value = ''
    showToast(t('bgTasks.toast.started'))
    loadBgTasks()
  } catch {
    showToast(t('bgTasks.toast.start_error'))
  } finally {
    btn.disabled = false
  }
}

async function loadBgTasks() {
  const list = document.getElementById('bgTasksList')
  const showAll = document.getElementById('bgShowAll').checked
  const agentVal = document.getElementById('bgAgent')?.value || ''

  try {
    const params = new URLSearchParams()
    if (agentVal) params.set('agent', agentVal)
    if (showAll) params.set('all', 'true')
    const res = await fetch('/api/background-tasks?' + params.toString())
    if (!res.ok) { list.innerHTML = `<p style="color:var(--danger)">${t('bgTasks.error')}</p>`; return }
    const tasks = await res.json()

    if (!tasks.length) {
      list.innerHTML = `<p style="color:var(--text-muted)">${t('bgTasks.empty')}</p>`
      return
    }

    list.innerHTML = tasks.map(task => {
      const statusColors = { running: '#f59e0b', done: '#22c55e', failed: '#ef4444', timeout: '#6b7280' }
      const statusLabels = { running: () => t('bgTasks.status.running'), done: () => t('bgTasks.status.done'), failed: () => t('bgTasks.status.failed'), timeout: () => t('bgTasks.status.timeout') }
      const color = statusColors[task.status] || '#6b7280'
      const labelRaw = statusLabels[task.status]; const label = labelRaw ? (typeof labelRaw === 'function' ? labelRaw() : labelRaw) : task.status
      const output = task.output ? `<pre style="margin-top:8px;padding:8px;background:var(--bg);border-radius:6px;font-size:12px;max-height:200px;overflow:auto;white-space:pre-wrap;">${esc(task.output.slice(-2000))}</pre>` : ''
      return `<div style="margin-bottom:12px;padding:12px 16px;border-radius:8px;background:var(--surface);border:1px solid var(--border);border-left:3px solid ${color};">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
          <div style="display:flex;gap:8px;align-items:center;">
            <span style="font-weight:600;font-size:13px;">${esc(task.id)}</span>
            <span class="badge" style="font-size:11px;background:${color};color:#fff;padding:2px 8px;border-radius:12px;">${label}</span>
            <span class="badge" style="font-size:11px;background:var(--primary);color:#fff;padding:2px 8px;border-radius:12px;">${esc(task.agent_id)}</span>
          </div>
          <div style="display:flex;gap:8px;align-items:center;">
            <span style="font-size:12px;color:var(--text-muted)">${esc(task.started_label)}</span>
            ${task.status === 'running' ? `<button class="btn btn-sm" onclick="viewBgTask('${esc(task.id)}')" style="font-size:11px;padding:2px 8px;">${t('bgTasks.output_btn')}</button><button class="btn btn-sm" onclick="cancelBgTask('${esc(task.id)}')" style="font-size:11px;padding:2px 8px;color:var(--danger)">${t('bgTasks.stop_btn')}</button>` : ''}
          </div>
        </div>
        <div style="font-size:13px;color:var(--text-primary);margin-bottom:4px;">${esc(task.prompt)}</div>
        ${task.finished_label ? `<div style="font-size:12px;color:var(--text-muted);">${t('bgTasks.finished_label')} ${esc(task.finished_label)}</div>` : ''}
        ${output}
      </div>`
    }).join('')
  } catch {
    list.innerHTML = `<p style="color:var(--danger)">${t('bgTasks.load_error')}</p>`
  }
}

async function viewBgTask(id) {
  try {
    const res = await fetch(`/api/background-tasks/${id}`)
    if (!res.ok) { showToast(t('bgTasks.load_error')); return }
    const task = await res.json()
    const output = task.liveOutput || task.output || t('bgTasks.no_output')
    const modal = document.createElement('div')
    modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:1000;display:flex;align-items:center;justify-content:center;'
    modal.innerHTML = `<div style="background:var(--surface);border-radius:12px;padding:20px;max-width:800px;width:90%;max-height:80vh;overflow:auto;">
      <div style="display:flex;justify-content:space-between;margin-bottom:12px;">
        <h3 style="margin:0;">${t('bgTasks.modal.title', { id: esc(id) })}</h3>
        <button class="btn btn-sm" id="bgModalClose" style="font-size:13px;">${t('bgTasks.modal.close_btn')}</button>
      </div>
      <pre style="white-space:pre-wrap;font-size:12px;line-height:1.4;">${esc(output)}</pre>
    </div>`
    document.body.appendChild(modal)
    modal.addEventListener('click', e => { if (e.target === modal) modal.remove() })
    document.getElementById('bgModalClose').addEventListener('click', () => modal.remove())
  } catch {
    showToast('Hiba')
  }
}

async function cancelBgTask(id) {
  if (!confirm(t('bgTasks.cancel.confirm'))) return
  try {
    const res = await fetch(`/api/background-tasks/${id}`, { method: 'DELETE' })
    if (res.ok) {
      showToast(t('bgTasks.toast.stopped'))
      loadBgTasks()
    } else {
      showToast(t('bgTasks.toast.stop_error'))
    }
  } catch {
    showToast('Hiba')
  }
}

export { loadBgTasksPage, viewBgTask, cancelBgTask }

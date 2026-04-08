// === Theme ===
const html = document.documentElement
const themeToggle = document.getElementById('themeToggle')
const savedTheme = localStorage.getItem('cc-theme')
if (savedTheme) {
  html.setAttribute('data-theme', savedTheme)
} else if (window.matchMedia('(prefers-color-scheme: dark)').matches) {
  html.setAttribute('data-theme', 'dark')
}
themeToggle.addEventListener('click', () => {
  const next = html.getAttribute('data-theme') === 'dark' ? 'light' : 'dark'
  html.setAttribute('data-theme', next)
  localStorage.setItem('cc-theme', next)
})

// === Page switching ===
const navLinks = document.querySelectorAll('.nav-link[data-page]')
const pages = document.querySelectorAll('.page')

function switchPage(pageId) {
  pages.forEach((p) => (p.hidden = p.id !== pageId + 'Page'))
  navLinks.forEach((l) => l.classList.toggle('active', l.dataset.page === pageId))
  if (pageId === 'kanban') loadKanban()
  if (pageId === 'tasks') loadSchedules()
  if (pageId === 'agents') loadAgents()
  if (pageId === 'memories') { loadMemAgents(); loadMemStats(); loadMemories() }
  if (pageId === 'connectors') loadConnectors()
}

navLinks.forEach((link) => {
  link.addEventListener('click', (e) => {
    e.preventDefault()
    switchPage(link.dataset.page)
  })
})

// ============================================================
// === Kanban ===
// ============================================================

let kanbanCards = []
let kanbanAssignees = []

const cardModalOverlay = document.getElementById('cardModalOverlay')
const cardDetailOverlay = document.getElementById('cardDetailOverlay')
const columns = document.querySelectorAll('.kanban-col-body')

// Modal wiring
document.getElementById('cardModalClose').addEventListener('click', () => closeModal(cardModalOverlay))
document.getElementById('cardDetailClose').addEventListener('click', () => closeModal(cardDetailOverlay))
cardModalOverlay.addEventListener('click', (e) => { if (e.target === cardModalOverlay) closeModal(cardModalOverlay) })
cardDetailOverlay.addEventListener('click', (e) => { if (e.target === cardDetailOverlay) closeModal(cardDetailOverlay) })

// Add card buttons per column
document.querySelectorAll('.kanban-add-btn').forEach((btn) => {
  btn.addEventListener('click', () => openNewCardModal(btn.dataset.status))
})

async function loadKanban() {
  try {
    const [cardsRes, assigneesRes] = await Promise.all([
      fetch('/api/kanban'),
      fetch('/api/kanban/assignees'),
    ])
    kanbanCards = await cardsRes.json()
    kanbanAssignees = await assigneesRes.json()
    renderKanban()
  } catch (err) {
    console.error('Kanban betöltés hiba:', err)
  }
}

function renderKanban() {
  const grouped = { planned: [], in_progress: [], waiting: [], done: [] }
  for (const card of kanbanCards) {
    if (grouped[card.status]) grouped[card.status].push(card)
  }

  for (const [status, cards] of Object.entries(grouped)) {
    const col = document.querySelector(`.kanban-col-body[data-status="${status}"]`)
    col.innerHTML = ''
    cards.sort((a, b) => a.sort_order - b.sort_order)

    for (const card of cards) {
      col.appendChild(createCardEl(card))
    }
  }

  // Update counts
  document.getElementById('countPlanned').textContent = grouped.planned.length
  document.getElementById('countInProgress').textContent = grouped.in_progress.length
  document.getElementById('countWaiting').textContent = grouped.waiting.length
  document.getElementById('countDone').textContent = grouped.done.length
}

function createCardEl(card) {
  const el = document.createElement('div')
  el.className = 'kanban-card'
  el.dataset.id = card.id
  el.dataset.priority = card.priority
  el.draggable = true

  const assignee = card.assignee ? kanbanAssignees.find((a) => a.name === card.assignee) : null
  const assigneeHtml = assignee
    ? `<span class="kanban-card-assignee"><span class="assignee-dot ${assignee.type}">${assignee.name[0]}</span>${escapeHtml(assignee.name)}</span>`
    : ''

  let dueHtml = ''
  if (card.due_date) {
    const d = new Date(card.due_date * 1000)
    const now = new Date()
    const overdue = d < now && card.status !== 'done'
    const label = d.toLocaleDateString('hu-HU', { month: 'short', day: 'numeric' })
    dueHtml = `<span class="kanban-card-due ${overdue ? 'overdue' : ''}">${label}</span>`
  }

  el.innerHTML = `
    <div class="kanban-card-title">${escapeHtml(card.title)}</div>
    <div class="kanban-card-footer">${assigneeHtml}${dueHtml}</div>
  `

  // Drag events
  el.addEventListener('dragstart', (e) => {
    el.classList.add('dragging')
    e.dataTransfer.setData('text/plain', card.id)
    e.dataTransfer.effectAllowed = 'move'
  })
  el.addEventListener('dragend', () => el.classList.remove('dragging'))

  // Click -> detail
  el.addEventListener('click', () => showCardDetail(card))

  return el
}

// === Drag & Drop ===
columns.forEach((col) => {
  col.addEventListener('dragover', (e) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    col.classList.add('drag-over')

    // Insert indicator position
    const afterEl = getDragAfterElement(col, e.clientY)
    const dragging = document.querySelector('.kanban-card.dragging')
    if (!dragging) return
    if (afterEl) {
      col.insertBefore(dragging, afterEl)
    } else {
      col.appendChild(dragging)
    }
  })

  col.addEventListener('dragleave', (e) => {
    if (!col.contains(e.relatedTarget)) col.classList.remove('drag-over')
  })

  col.addEventListener('drop', async (e) => {
    e.preventDefault()
    col.classList.remove('drag-over')
    const cardId = e.dataTransfer.getData('text/plain')
    const newStatus = col.dataset.status

    // Calculate sort_order based on position
    const cards = [...col.querySelectorAll('.kanban-card')]
    const idx = cards.findIndex((c) => c.dataset.id === cardId)
    let sortOrder = idx

    try {
      await fetch(`/api/kanban/${encodeURIComponent(cardId)}/move`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: newStatus, sort_order: sortOrder }),
      })
      loadKanban()
    } catch {
      showToast('Hiba az áthelyezés során')
    }
  })
})

function getDragAfterElement(col, y) {
  const els = [...col.querySelectorAll('.kanban-card:not(.dragging)')]
  let closest = null
  let closestOffset = Number.NEGATIVE_INFINITY

  for (const el of els) {
    const box = el.getBoundingClientRect()
    const offset = y - box.top - box.height / 2
    if (offset < 0 && offset > closestOffset) {
      closestOffset = offset
      closest = el
    }
  }
  return closest
}

// === New card modal ===
function openNewCardModal(status) {
  document.getElementById('cardModalTitle').textContent = 'Új kártya'
  document.getElementById('cardTitle').value = ''
  document.getElementById('cardDesc').value = ''
  document.getElementById('cardPriority').value = 'normal'
  document.getElementById('cardDue').value = ''
  document.getElementById('cardEditId').value = ''
  document.getElementById('cardEditStatus').value = status || 'planned'
  populateAssigneeSelect('cardAssignee')
  openModal(cardModalOverlay)
  setTimeout(() => document.getElementById('cardTitle').focus(), 200)
}

function populateAssigneeSelect(selectId, selected) {
  const sel = document.getElementById(selectId)
  sel.innerHTML = '<option value="">-- Nincs --</option>'
  for (const a of kanbanAssignees) {
    const opt = document.createElement('option')
    opt.value = a.name
    opt.textContent = a.name
    if (selected && a.name === selected) opt.selected = true
    sel.appendChild(opt)
  }
}

// Save card (create or update)
document.getElementById('saveCardBtn').addEventListener('click', async () => {
  const title = document.getElementById('cardTitle').value.trim()
  if (!title) { document.getElementById('cardTitle').focus(); return }

  const data = {
    title,
    description: document.getElementById('cardDesc').value.trim() || null,
    assignee: document.getElementById('cardAssignee').value || null,
    priority: document.getElementById('cardPriority').value,
    due_date: document.getElementById('cardDue').value
      ? Math.floor(new Date(document.getElementById('cardDue').value).getTime() / 1000)
      : null,
  }

  const editId = document.getElementById('cardEditId').value

  try {
    if (editId) {
      await fetch(`/api/kanban/${encodeURIComponent(editId)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      })
      showToast('Kártya frissítve')
    } else {
      data.status = document.getElementById('cardEditStatus').value
      await fetch('/api/kanban', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      })
      showToast('Kártya létrehozva')
    }
    closeModal(cardModalOverlay)
    loadKanban()
  } catch (err) {
    showToast('Hiba a mentés során')
  }
})

// === Card detail ===
async function showCardDetail(card) {
  document.getElementById('cardDetailTitle').textContent = card.title

  const assignee = card.assignee ? kanbanAssignees.find((a) => a.name === card.assignee) : null
  const priorityLabels = { low: 'Alacsony', normal: 'Normál', high: 'Magas', urgent: 'Sürgős' }
  const statusLabels = { planned: 'Tervezett', in_progress: 'Folyamatban', waiting: 'Várakozik', done: 'Kész' }

  const meta = document.getElementById('cardDetailMeta')
  meta.innerHTML = `
    <div class="meta-item">
      <span class="meta-label">Állapot</span>
      <span class="meta-value">${statusLabels[card.status] || card.status}</span>
    </div>
    <div class="meta-item">
      <span class="meta-label">Felelős</span>
      <span class="meta-value">${assignee ? escapeHtml(assignee.name) : '-- nincs --'}</span>
    </div>
    <div class="meta-item">
      <span class="meta-label">Prioritás</span>
      <span class="meta-value">${priorityLabels[card.priority]}</span>
    </div>
    <div class="meta-item">
      <span class="meta-label">Határidő</span>
      <span class="meta-value">${card.due_date ? new Date(card.due_date * 1000).toLocaleDateString('hu-HU') : '-- nincs --'}</span>
    </div>
  `

  document.getElementById('cardDetailDesc').textContent = card.description || ''

  // Load comments
  try {
    const res = await fetch(`/api/kanban/${encodeURIComponent(card.id)}/comments`)
    const comments = await res.json()
    const list = document.getElementById('commentsList')
    list.innerHTML = ''
    for (const c of comments) {
      const date = new Date(c.created_at * 1000).toLocaleString('hu-HU')
      const div = document.createElement('div')
      div.className = 'comment-item'
      div.innerHTML = `
        <div><span class="comment-author">${escapeHtml(c.author)}</span><span class="comment-date">${date}</span></div>
        <div class="comment-body">${escapeHtml(c.content)}</div>
      `
      list.appendChild(div)
    }
  } catch { /* ignore */ }

  // Author select for new comment
  populateAssigneeSelect('commentAuthor', 'Marveen')

  // Add comment
  document.getElementById('addCommentBtn').onclick = async () => {
    const content = document.getElementById('commentContent').value.trim()
    const author = document.getElementById('commentAuthor').value
    if (!content || !author) return
    try {
      await fetch(`/api/kanban/${encodeURIComponent(card.id)}/comments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ author, content }),
      })
      document.getElementById('commentContent').value = ''
      showCardDetail(card) // refresh
    } catch {
      showToast('Hiba a megjegyzés mentése során')
    }
  }

  // Edit button
  document.getElementById('cardEditBtn').onclick = () => {
    closeModal(cardDetailOverlay)
    document.getElementById('cardModalTitle').textContent = 'Kártya szerkesztése'
    document.getElementById('cardTitle').value = card.title
    document.getElementById('cardDesc').value = card.description || ''
    document.getElementById('cardPriority').value = card.priority
    document.getElementById('cardDue').value = card.due_date
      ? new Date(card.due_date * 1000).toISOString().split('T')[0]
      : ''
    document.getElementById('cardEditId').value = card.id
    document.getElementById('cardEditStatus').value = card.status
    populateAssigneeSelect('cardAssignee', card.assignee)
    openModal(cardModalOverlay)
  }

  // Archive
  document.getElementById('cardArchiveBtn').onclick = async () => {
    try {
      await fetch(`/api/kanban/${encodeURIComponent(card.id)}/archive`, { method: 'POST' })
      closeModal(cardDetailOverlay)
      showToast('Kártya archiválva')
      loadKanban()
    } catch {
      showToast('Hiba az archiválás során')
    }
  }

  // Delete
  document.getElementById('cardDeleteBtn').onclick = async () => {
    if (!confirm('Biztosan törlöd ezt a kártyát?')) return
    try {
      await fetch(`/api/kanban/${encodeURIComponent(card.id)}`, { method: 'DELETE' })
      closeModal(cardDetailOverlay)
      showToast('Kártya törölve')
      loadKanban()
    } catch {
      showToast('Hiba a törlés során')
    }
  }

  openModal(cardDetailOverlay)
}

// === Elements: Agents ===
const agentsGrid = document.getElementById('agentsGrid')
const addBtn = document.getElementById('addAgentBtn')
const agentWizardOverlay = document.getElementById('agentWizardOverlay')
const agentDetailOverlay = document.getElementById('agentDetailOverlay')
const skillModalOverlay = document.getElementById('skillModalOverlay')
const agentName = document.getElementById('agentName')
const agentDesc = document.getElementById('agentDesc')
const agentModel = document.getElementById('agentModel')
const toast = document.getElementById('toast')

const AVATARS = [
  '01_robot.png', '02_wizard_girl.png', '03_knight.png', '04_ninja.png',
  '05_pirate.png', '06_scientist_girl.png', '07_astronaut.png', '08_viking.png',
  '09_cowgirl.png', '10_detective.png', '11_chef.png', '12_witch.png',
  '13_samurai.png', '14_fairy_girl.png', '15_firefighter.png', '16_punk_girl.png',
  '17_explorer.png', '18_dj.png', '19_princess.png', '20_alien.png'
]

let selectedAvatar = null
let agents = []
let currentAgent = null
let wizardStep = 1
let generatedClaudeMd = ''
let generatedSoulMd = ''

// === Modal helpers ===
function openModal(overlay) {
  overlay.classList.add('active')
  document.body.style.overflow = 'hidden'
}
function closeModal(overlay) {
  overlay.classList.remove('active')
  document.body.style.overflow = ''
}

// Wizard open
addBtn.addEventListener('click', () => {
  resetWizard()
  openModal(agentWizardOverlay)
  setTimeout(() => agentName.focus(), 200)
})

// Close buttons
document.getElementById('wizardClose').addEventListener('click', () => closeModal(agentWizardOverlay))
document.getElementById('agentDetailClose').addEventListener('click', () => closeModal(agentDetailOverlay))
document.getElementById('skillModalClose').addEventListener('click', () => closeModal(skillModalOverlay))

// Click-outside-to-close
agentWizardOverlay.addEventListener('click', (e) => { if (e.target === agentWizardOverlay) closeModal(agentWizardOverlay) })
agentDetailOverlay.addEventListener('click', (e) => { if (e.target === agentDetailOverlay) closeModal(agentDetailOverlay) })
skillModalOverlay.addEventListener('click', (e) => { if (e.target === skillModalOverlay) closeModal(skillModalOverlay) })

// Close all modals on Escape
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    document.querySelectorAll('.modal-overlay.active').forEach((o) => closeModal(o))
  }
})

// === Avatar Gallery ===
function populateAvatarGrid() {
  const grid = document.getElementById('avatarGrid')
  grid.innerHTML = ''
  for (const avatar of AVATARS) {
    const item = document.createElement('div')
    item.className = 'avatar-grid-item'
    item.dataset.avatar = avatar
    item.innerHTML = `<img src="/avatars/${avatar}" alt="${avatar.replace(/^\d+_/, '').replace('.png', '')}">`
    item.addEventListener('click', () => {
      grid.querySelectorAll('.avatar-grid-item').forEach(i => i.classList.remove('selected'))
      item.classList.add('selected')
      selectedAvatar = avatar
    })
    grid.appendChild(item)
  }
}

// === Wizard logic ===
function resetWizard() {
  wizardStep = 1
  agentName.value = ''
  agentDesc.value = ''
  agentModel.value = 'inherit'
  selectedAvatar = null
  document.querySelectorAll('#avatarGrid .avatar-grid-item').forEach(i => i.classList.remove('selected'))
  generatedClaudeMd = ''
  generatedSoulMd = ''
  document.getElementById('wizardClaudeMd').value = ''
  document.getElementById('wizardSoulMd').value = ''
  updateWizardUI()
}

function updateWizardUI() {
  // Steps indicator
  document.querySelectorAll('#wizardSteps .wizard-step').forEach((s) => {
    const step = parseInt(s.dataset.step)
    s.classList.toggle('active', step === wizardStep)
    s.classList.toggle('done', step < wizardStep)
  })
  // Panels
  document.getElementById('wizardStep1').hidden = wizardStep !== 1
  document.getElementById('wizardStep2').hidden = wizardStep !== 2
  document.getElementById('wizardStep3').hidden = wizardStep !== 3
}

// Step 1 -> Step 2 (generate)
document.getElementById('wizardNextBtn').addEventListener('click', async () => {
  const name = agentName.value.trim()
  const desc = agentDesc.value.trim()
  if (!name) { agentName.focus(); return }
  if (!desc) { agentDesc.focus(); return }

  wizardStep = 2
  updateWizardUI()

  const statusEl = document.getElementById('wizardGenStatus')
  statusEl.textContent = 'CLAUDE.md generálás...'

  try {
    // Create agent via API (returns generated content)
    const res = await fetch('/api/agents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name,
        description: desc,
        model: agentModel.value,
      }),
    })

    if (!res.ok) {
      const err = await res.json()
      throw new Error(err.error || 'Ismeretlen hiba')
    }

    const result = await res.json()
    statusEl.textContent = 'SOUL.md generálás...'

    // Fetch full agent details to get generated content
    const detailRes = await fetch(`/api/agents/${encodeURIComponent(name)}`)
    if (detailRes.ok) {
      const detail = await detailRes.json()
      generatedClaudeMd = detail.claudeMd || detail.content || ''
      generatedSoulMd = detail.soulMd || ''
    }

    statusEl.textContent = 'Kész!'

    // Set gallery avatar if selected
    if (selectedAvatar) {
      await fetch(`/api/agents/${encodeURIComponent(name)}/avatar`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ galleryAvatar: selectedAvatar }),
      })
    }

    // Auto-advance to step 3
    setTimeout(() => {
      wizardStep = 3
      document.getElementById('wizardClaudeMd').value = generatedClaudeMd
      document.getElementById('wizardSoulMd').value = generatedSoulMd
      updateWizardUI()
    }, 600)
  } catch (err) {
    showToast(`Hiba: ${err.message}`)
    wizardStep = 1
    updateWizardUI()
  }
})

// Step 3 -> back to step 1
document.getElementById('wizardBackBtn').addEventListener('click', () => {
  wizardStep = 1
  updateWizardUI()
})

// Step 3 -> Create (finalize with edits)
document.getElementById('wizardCreateBtn').addEventListener('click', async () => {
  const name = agentName.value.trim()
  const claudeMd = document.getElementById('wizardClaudeMd').value
  const soulMd = document.getElementById('wizardSoulMd').value
  const createBtn = document.getElementById('wizardCreateBtn')

  createBtn.disabled = true
  createBtn.querySelector('.btn-text').hidden = true
  createBtn.querySelector('.btn-loading').hidden = false

  try {
    // Update with edited content
    const res = await fetch(`/api/agents/${encodeURIComponent(name)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ claudeMd, soulMd }),
    })

    if (!res.ok) {
      const err = await res.json()
      throw new Error(err.error || 'Ismeretlen hiba')
    }

    closeModal(agentWizardOverlay)
    showToast('Ágens sikeresen létrehozva!')
    loadAgents()
  } catch (err) {
    showToast(`Hiba: ${err.message}`)
  } finally {
    createBtn.disabled = false
    createBtn.querySelector('.btn-text').hidden = false
    createBtn.querySelector('.btn-loading').hidden = true
  }
})

// === Toast ===
function showToast(msg, duration = 3000) {
  toast.textContent = msg
  toast.classList.add('visible')
  setTimeout(() => toast.classList.remove('visible'), duration)
}

// === Agents API ===
async function loadAgents() {
  try {
    const [agentsRes, marveenRes] = await Promise.all([
      fetch('/api/agents'),
      fetch('/api/marveen'),
    ])
    agents = await agentsRes.json()
    if (marveenRes.ok) window._marveen = await marveenRes.json()
    renderAgents()
  } catch (err) {
    console.error('Betöltés hiba:', err)
  }
}

async function openMarveenDetail() {
  const m = window._marveen
  if (!m) return

  // Reuse the agent detail modal for Marveen
  currentAgent = { ...m, name: 'marveen', claudeMd: '', soulMd: '', mcpJson: '', skills: [] }

  document.getElementById('agentDetailTitle').textContent = 'Marveen'
  const avatar = document.getElementById('agentDetailAvatar')
  avatar.className = 'detail-avatar gradient-1'
  avatar.innerHTML = `<img src="/api/marveen/avatar?t=${Date.now()}" alt="Marveen">`
  document.getElementById('agentDetailName').textContent = 'Marveen'
  document.getElementById('agentDetailDesc').textContent = m.description || ''
  document.getElementById('agentDetailModel').textContent = 'claude-opus-4-6'
  document.getElementById('agentDetailTgStatus').innerHTML = '<span class="tg-status"><span class="tg-dot connected"></span>Csatlakozva</span>'
  document.getElementById('agentDetailSkillCount').textContent = '-'

  // Process control for Marveen - always running, no start/stop
  document.getElementById('processDot').className = 'process-dot running'
  document.getElementById('processLabel').textContent = 'Fut'
  document.getElementById('processUptime').textContent = 'tmux: claudeclaw-channels'
  document.getElementById('agentStartBtn').hidden = true
  document.getElementById('agentStopBtn').hidden = true

  // Settings tab - load CLAUDE.md
  try {
    const claudeRes = await fetch('/api/marveen')
    if (claudeRes.ok) {
      const data = await claudeRes.json()
      document.getElementById('editClaudeMd').value = '(Marveen CLAUDE.md szerkesztése a projekt CLAUDE.md fájlban)'
      document.getElementById('editSoulMd').value = data.personality || ''
      document.getElementById('editMcpJson').value = ''
    }
  } catch {}

  // Delete button - hide for Marveen
  document.getElementById('deleteAgentBtn').style.display = 'none'

  document.getElementById('detailAvatarGallery').hidden = true
  switchAgentTab('overview')
  openModal(agentDetailOverlay)
}


function getAvatarGradient(name) {
  const hash = name.split('').reduce((a, c) => a + c.charCodeAt(0), 0)
  return 'gradient-' + ((hash % 3) + 1)
}

function renderAgents() {
  agentsGrid.querySelectorAll('.agent-card:not(.add-card)').forEach((el) => el.remove())

  // Marveen card (always first)
  if (window._marveen) {
    const m = window._marveen
    const mCard = document.createElement('div')
    mCard.className = 'agent-card marveen-card'
    mCard.innerHTML = `
      <div class="agent-card-top">
        <div class="agent-avatar gradient-1"><img src="/api/marveen/avatar?t=${Date.now()}" alt="Marveen"></div>
        <div class="agent-card-info">
          <div class="agent-name">Marveen <span class="marveen-badge">fo asszisztens</span></div>
          <div class="agent-desc">${escapeHtml(m.description || '')}</div>
        </div>
      </div>
      <div class="agent-card-footer">
        <span class="agent-model-badge opus">opus</span>
        <span class="process-indicator"><span class="process-dot running"></span>Fut</span>
        <span class="tg-status"><span class="tg-dot connected"></span>Online</span>
      </div>
    `
    mCard.addEventListener('click', () => openMarveenDetail())
    agentsGrid.insertBefore(mCard, addBtn)
  }

  for (const agent of agents) {
    const card = document.createElement('div')
    card.className = 'agent-card'
    card.dataset.name = agent.name
    const initial = agent.name.charAt(0).toUpperCase()
    const gradientClass = getAvatarGradient(agent.name)
    const avatarHtml = (agent.hasImage || agent.hasAvatar)
      ? `<img src="/api/agents/${encodeURIComponent(agent.name)}/avatar?t=${Date.now()}" alt="${escapeHtml(agent.name)}">`
      : initial

    const modelClass = agent.model && agent.model !== 'inherit' ? agent.model : ''
    const modelLabel = agent.model || 'inherit'
    const tgConnected = agent.hasTelegram || false
    const tgDotClass = tgConnected ? 'connected' : 'disconnected'
    const tgLabel = tgConnected ? 'Online' : 'Offline'
    const isRunning = agent.running || false
    const runDotClass = isRunning ? 'running' : 'stopped'
    const runLabel = isRunning ? 'Fut' : 'Leállva'

    card.innerHTML = `
      <div class="agent-card-top">
        <div class="agent-avatar ${gradientClass}">${avatarHtml}</div>
        <div class="agent-card-info">
          <div class="agent-name">${escapeHtml(agent.name)}</div>
          <div class="agent-desc">${escapeHtml(agent.description || '')}</div>
        </div>
      </div>
      <div class="agent-card-footer">
        <span class="agent-model-badge ${escapeHtml(modelClass)}">${escapeHtml(modelLabel)}</span>
        <span class="process-indicator"><span class="process-dot ${runDotClass}"></span>${runLabel}</span>
        <span class="tg-status"><span class="tg-dot ${tgDotClass}"></span>${tgLabel}</span>
      </div>
    `
    card.addEventListener('click', () => openAgentDetail(agent.name))
    agentsGrid.insertBefore(card, addBtn)
  }
}

// === Agent Detail ===
async function openAgentDetail(agentName) {
  try {
    const res = await fetch(`/api/agents/${encodeURIComponent(agentName)}`)
    if (!res.ok) throw new Error('Nem található')
    currentAgent = await res.json()
  } catch (err) {
    showToast('Ágens betöltése sikertelen')
    return
  }

  // Title
  document.getElementById('agentDetailTitle').textContent = currentAgent.name

  // Overview tab
  const initial = currentAgent.name.charAt(0).toUpperCase()
  const gradientClass = getAvatarGradient(currentAgent.name)
  const avatar = document.getElementById('agentDetailAvatar')
  avatar.className = 'detail-avatar ' + gradientClass
  avatar.innerHTML = (currentAgent.hasImage || currentAgent.hasAvatar)
    ? `<img src="/api/agents/${encodeURIComponent(currentAgent.name)}/avatar" alt="${escapeHtml(currentAgent.name)}">`
    : initial
  document.getElementById('agentDetailName').textContent = currentAgent.name
  document.getElementById('agentDetailDesc').textContent = currentAgent.description || ''
  document.getElementById('agentDetailModel').textContent = currentAgent.model || 'inherit'

  const tgConnected = currentAgent.telegramConnected || currentAgent.telegram_connected || false
  document.getElementById('agentDetailTgStatus').innerHTML = `<span class="tg-status"><span class="tg-dot ${tgConnected ? 'connected' : 'disconnected'}"></span>${tgConnected ? 'Csatlakozva' : 'Nincs bekötve'}</span>`

  // Settings tab
  document.getElementById('editAgentModel').value = currentAgent.model || 'claude-sonnet-4-6'
  document.getElementById('editClaudeMd').value = currentAgent.claudeMd || currentAgent.content || ''
  document.getElementById('editSoulMd').value = currentAgent.soulMd || ''
  document.getElementById('editMcpJson').value = currentAgent.mcpJson || ''

  // Telegram tab
  updateTelegramTab(currentAgent)

  // Skills tab
  await loadSkills(currentAgent.name)

  // Process control
  updateProcessControl(currentAgent)

  // Delete button (restore visibility for normal agents)
  document.getElementById('deleteAgentBtn').style.display = ''
  document.getElementById('deleteAgentBtn').onclick = async () => {
    if (!confirm(`Biztosan törlöd: ${currentAgent.name}?`)) return
    try {
      await fetch(`/api/agents/${encodeURIComponent(currentAgent.name)}`, { method: 'DELETE' })
      closeModal(agentDetailOverlay)
      showToast('Ágens törölve')
      loadAgents()
    } catch (err) {
      showToast('Hiba a törlés során')
    }
  }

  // Reset to first tab, hide avatar gallery
  document.getElementById('detailAvatarGallery').hidden = true
  switchAgentTab('overview')
  openModal(agentDetailOverlay)
}

// === Detail avatar gallery ===
function populateDetailAvatarGrid() {
  const grid = document.getElementById('detailAvatarGrid')
  grid.innerHTML = ''
  for (const avatar of AVATARS) {
    const item = document.createElement('div')
    item.className = 'avatar-grid-item'
    item.dataset.avatar = avatar
    item.innerHTML = `<img src="/avatars/${avatar}" alt="${avatar.replace(/^\d+_/, '').replace('.png', '')}">`
    item.addEventListener('click', async () => {
      if (!currentAgent) return
      grid.querySelectorAll('.avatar-grid-item').forEach(i => i.classList.remove('selected'))
      item.classList.add('selected')
      try {
        const res = await fetch(`/api/agents/${encodeURIComponent(currentAgent.name)}/avatar`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ galleryAvatar: avatar }),
        })
        if (!res.ok) throw new Error()
        showToast('Avatar frissítve')
        // Update the detail avatar display
        document.getElementById('agentDetailAvatar').innerHTML = `<img src="/api/agents/${encodeURIComponent(currentAgent.name)}/avatar?t=${Date.now()}" alt="">`
        document.getElementById('detailAvatarGallery').hidden = true
        loadAgents()
      } catch {
        showToast('Hiba az avatar mentése során')
      }
    })
    grid.appendChild(item)
  }
}

document.getElementById('avatarChangeBtn').addEventListener('click', () => {
  const gallery = document.getElementById('detailAvatarGallery')
  gallery.hidden = !gallery.hidden
  if (!gallery.hidden) {
    const isMarveen = currentAgent && currentAgent.role === 'main'
    const avatarEndpoint = isMarveen ? '/api/marveen/avatar' : `/api/agents/${encodeURIComponent(currentAgent.name)}/avatar`

    const grid = document.getElementById('detailAvatarGrid')
    grid.innerHTML = ''
    for (const avatar of AVATARS) {
      const item = document.createElement('div')
      item.className = 'avatar-grid-item'
      item.innerHTML = `<img src="/avatars/${avatar}" alt="${avatar.replace(/^\d+_/, '').replace('.png', '')}">`
      item.addEventListener('click', async () => {
        try {
          const res = await fetch(avatarEndpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ galleryAvatar: avatar }),
          })
          if (!res.ok) throw new Error()
          showToast('Avatar frissítve')
          const imgUrl = isMarveen ? `/api/marveen/avatar?t=${Date.now()}` : `/api/agents/${encodeURIComponent(currentAgent.name)}/avatar?t=${Date.now()}`
          document.getElementById('agentDetailAvatar').innerHTML = `<img src="${imgUrl}" alt="">`
          gallery.hidden = true
          loadAgents()
        } catch {
          showToast('Hiba az avatar mentése során')
        }
      })
      grid.appendChild(item)
    }
  }
})

// === Process control ===
function updateProcessControl(agent) {
  const running = agent.running || false
  const dot = document.getElementById('processDot')
  const label = document.getElementById('processLabel')
  const uptime = document.getElementById('processUptime')
  const startBtn = document.getElementById('agentStartBtn')
  const stopBtn = document.getElementById('agentStopBtn')

  dot.className = 'process-dot ' + (running ? 'running' : 'stopped')
  label.textContent = running ? 'Fut' : 'Leállva'
  startBtn.hidden = running
  stopBtn.hidden = !running

  if (running && agent.session) {
    uptime.textContent = `tmux: ${agent.session}`
  } else {
    uptime.textContent = ''
  }
}

document.getElementById('agentStartBtn').addEventListener('click', async () => {
  if (!currentAgent) return
  const btn = document.getElementById('agentStartBtn')
  btn.disabled = true
  btn.querySelector('.btn-text').hidden = true
  btn.querySelector('.btn-loading').hidden = false

  try {
    const res = await fetch(`/api/agents/${encodeURIComponent(currentAgent.name)}/start`, { method: 'POST' })
    if (!res.ok) {
      const err = await res.json()
      throw new Error(err.error || 'Indítási hiba')
    }
    showToast('Ágens elindítva!')
    // Refresh
    const detailRes = await fetch(`/api/agents/${encodeURIComponent(currentAgent.name)}`)
    if (detailRes.ok) {
      currentAgent = await detailRes.json()
      updateProcessControl(currentAgent)
    }
    loadAgents()
  } catch (err) {
    showToast(`Hiba: ${err.message}`)
  } finally {
    btn.disabled = false
    btn.querySelector('.btn-text').hidden = false
    btn.querySelector('.btn-loading').hidden = true
  }
})

document.getElementById('agentStopBtn').addEventListener('click', async () => {
  if (!currentAgent) return
  if (!confirm('Biztosan leállítod az ágenst?')) return

  try {
    const res = await fetch(`/api/agents/${encodeURIComponent(currentAgent.name)}/stop`, { method: 'POST' })
    if (!res.ok) {
      const err = await res.json()
      throw new Error(err.error || 'Leállítási hiba')
    }
    showToast('Ágens leállítva')
    const detailRes = await fetch(`/api/agents/${encodeURIComponent(currentAgent.name)}`)
    if (detailRes.ok) {
      currentAgent = await detailRes.json()
      updateProcessControl(currentAgent)
    }
    loadAgents()
  } catch (err) {
    showToast(`Hiba: ${err.message}`)
  }
})

// === Tab switching ===
document.getElementById('agentTabNav').addEventListener('click', (e) => {
  const btn = e.target.closest('.tab-btn')
  if (!btn) return
  switchAgentTab(btn.dataset.tab)
})

function switchAgentTab(tab) {
  document.querySelectorAll('#agentTabNav .tab-btn').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab))
  document.getElementById('tabOverview').hidden = tab !== 'overview'
  document.getElementById('tabSettings').hidden = tab !== 'settings'
  document.getElementById('tabTelegram').hidden = tab !== 'telegram'
  document.getElementById('tabSkills').hidden = tab !== 'skills'
}

// === Settings save buttons ===
document.getElementById('saveModelBtn').addEventListener('click', async () => {
  if (!currentAgent || currentAgent.role === 'main') return
  try {
    const res = await fetch(`/api/agents/${encodeURIComponent(currentAgent.name)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: document.getElementById('editAgentModel').value }),
    })
    if (!res.ok) throw new Error()
    showToast('Modell mentve (újraindítás szükséges)')
    loadAgents()
  } catch { showToast('Hiba a mentés során') }
})

document.getElementById('saveClaudeMdBtn').addEventListener('click', async () => {
  if (!currentAgent) return
  try {
    const res = await fetch(`/api/agents/${encodeURIComponent(currentAgent.name)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ claudeMd: document.getElementById('editClaudeMd').value }),
    })
    if (!res.ok) throw new Error()
    showToast('CLAUDE.md mentve')
  } catch { showToast('Hiba a mentés során') }
})

document.getElementById('saveSoulMdBtn').addEventListener('click', async () => {
  if (!currentAgent) return
  try {
    const res = await fetch(`/api/agents/${encodeURIComponent(currentAgent.name)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ soulMd: document.getElementById('editSoulMd').value }),
    })
    if (!res.ok) throw new Error()
    showToast('SOUL.md mentve')
  } catch { showToast('Hiba a mentés során') }
})

document.getElementById('saveMcpJsonBtn').addEventListener('click', async () => {
  if (!currentAgent) return
  try {
    const res = await fetch(`/api/agents/${encodeURIComponent(currentAgent.name)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mcpJson: document.getElementById('editMcpJson').value }),
    })
    if (!res.ok) throw new Error()
    showToast('.mcp.json mentve')
  } catch { showToast('Hiba a mentés során') }
})

// === Telegram tab ===
function updateTelegramTab(agent) {
  const connected = agent.hasTelegram || false
  const running = agent.running || false
  document.getElementById('tgNotConnected').hidden = connected
  document.getElementById('tgConnected').hidden = !connected
  if (connected) {
    document.getElementById('tgBotUsername').textContent = agent.telegramBotUsername || '@bot'
    document.getElementById('tgRunNotice').hidden = running
    document.getElementById('tgRunningNotice').hidden = !running
  }
  document.getElementById('tgTokenInput').value = ''
  if (connected) refreshPendingPairings()
}

document.getElementById('tgConnectBtn').addEventListener('click', async () => {
  if (!currentAgent) return
  const token = document.getElementById('tgTokenInput').value.trim()
  if (!token) {
    document.getElementById('tgTokenInput').focus()
    return
  }

  const btn = document.getElementById('tgConnectBtn')
  btn.disabled = true
  btn.querySelector('.btn-text').hidden = true
  btn.querySelector('.btn-loading').hidden = false

  try {
    const res = await fetch(`/api/agents/${encodeURIComponent(currentAgent.name)}/telegram`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ botToken: token }),
    })
    if (!res.ok) {
      const err = await res.json()
      throw new Error(err.error || 'Kapcsolódási hiba')
    }
    const result = await res.json()
    showToast('Telegram bot sikeresen csatlakoztatva!')
    // Refresh detail
    await openAgentDetail(currentAgent.name)
    loadAgents()
  } catch (err) {
    showToast(`Hiba: ${err.message}`)
  } finally {
    btn.disabled = false
    btn.querySelector('.btn-text').hidden = false
    btn.querySelector('.btn-loading').hidden = true
  }
})

document.getElementById('tgTestBtn').addEventListener('click', async () => {
  if (!currentAgent) return
  try {
    const res = await fetch(`/api/agents/${encodeURIComponent(currentAgent.name)}/telegram/test`, { method: 'POST' })
    if (!res.ok) throw new Error()
    showToast('Kapcsolat rendben!')
  } catch {
    showToast('Kapcsolat tesztelése sikertelen')
  }
})

// Pairing: refresh pending list
async function refreshPendingPairings() {
  if (!currentAgent) return
  const listEl = document.getElementById('tgPendingList')
  try {
    const res = await fetch(`/api/agents/${encodeURIComponent(currentAgent.name)}/telegram/pending`)
    if (!res.ok) return
    const pending = await res.json()
    listEl.innerHTML = ''
    if (pending.length === 0) {
      listEl.innerHTML = '<div style="font-size:12px; color:var(--text-muted); padding:6px 0;">Nincs várakozó párosítás</div>'
      return
    }
    for (const p of pending) {
      const item = document.createElement('div')
      item.className = 'tg-pending-item'
      const created = new Date(p.createdAt).toLocaleString('hu-HU')
      item.innerHTML = `
        <div>
          <span class="tg-pending-code">${escapeHtml(p.code)}</span>
          <span class="tg-pending-sender">Sender: ${escapeHtml(p.senderId)}</span>
        </div>
        <button class="btn-primary btn-compact" style="padding:5px 12px; font-size:12px; margin:0" data-code="${escapeHtml(p.code)}">Jóváhagyás</button>
      `
      item.querySelector('button').addEventListener('click', async () => {
        await approvePairing(p.code)
      })
      listEl.appendChild(item)
    }
  } catch { /* ignore */ }
}

async function approvePairing(code) {
  if (!currentAgent) return
  try {
    const res = await fetch(`/api/agents/${encodeURIComponent(currentAgent.name)}/telegram/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    })
    if (!res.ok) {
      const err = await res.json()
      throw new Error(err.error || 'Jóváhagyási hiba')
    }
    showToast('Párosítás jóváhagyva!')
    refreshPendingPairings()
  } catch (err) {
    showToast(`Hiba: ${err.message}`)
  }
}

document.getElementById('tgRefreshPendingBtn').addEventListener('click', refreshPendingPairings)

document.getElementById('tgApproveBtn').addEventListener('click', async () => {
  const code = document.getElementById('tgPairCode').value.trim()
  if (!code) { document.getElementById('tgPairCode').focus(); return }
  await approvePairing(code)
  document.getElementById('tgPairCode').value = ''
})

document.getElementById('tgDisconnectBtn').addEventListener('click', async () => {
  if (!currentAgent) return
  if (!confirm('Biztosan leválasztod a Telegram botot?')) return
  try {
    await fetch(`/api/agents/${encodeURIComponent(currentAgent.name)}/telegram`, { method: 'DELETE' })
    showToast('Telegram bot leválasztva')
    await openAgentDetail(currentAgent.name)
    loadAgents()
  } catch {
    showToast('Hiba a leválasztás során')
  }
})

// === Skills ===
async function loadSkills(agentName) {
  const listEl = document.getElementById('skillList')
  const emptyEl = document.getElementById('skillEmpty')
  listEl.innerHTML = ''

  try {
    const res = await fetch(`/api/agents/${encodeURIComponent(agentName)}/skills`)
    if (!res.ok) throw new Error()
    const skills = await res.json()

    emptyEl.hidden = skills.length > 0
    document.getElementById('agentDetailSkillCount').textContent = skills.length

    for (const skill of skills) {
      const item = document.createElement('div')
      item.className = 'skill-item'
      item.innerHTML = `
        <div class="skill-item-info">
          <div class="skill-item-name">${escapeHtml(skill.name)}</div>
          ${skill.description ? `<div class="skill-item-desc">${escapeHtml(skill.description)}</div>` : ''}
        </div>
        <div class="skill-item-actions">
          <button class="btn-icon btn-icon-danger" title="Törlés">${trashIcon()}</button>
        </div>
      `
      item.querySelector('.btn-icon-danger').addEventListener('click', async () => {
        if (!confirm(`Skill törlése: ${skill.name}?`)) return
        try {
          await fetch(`/api/agents/${encodeURIComponent(agentName)}/skills/${encodeURIComponent(skill.name)}`, { method: 'DELETE' })
          showToast('Skill törölve')
          loadSkills(agentName)
        } catch {
          showToast('Hiba a törlés során')
        }
      })
      listEl.appendChild(item)
    }
  } catch {
    emptyEl.hidden = false
    document.getElementById('agentDetailSkillCount').textContent = '0'
  }
}

// Add skill button
document.getElementById('addSkillBtn').addEventListener('click', () => {
  document.getElementById('skillName').value = ''
  document.getElementById('skillDescription').value = ''
  skillFile = null
  document.getElementById('skillFileName').textContent = ''
  // Reset to create tab
  document.querySelectorAll('.skill-tab-btn').forEach(b => b.classList.toggle('active', b.dataset.skillTab === 'create'))
  document.getElementById('skillTabCreate').hidden = false
  document.getElementById('skillTabImport').hidden = true
  openModal(skillModalOverlay)
  setTimeout(() => document.getElementById('skillName').focus(), 200)
})

// Skill modal tab switching
document.querySelectorAll('.skill-tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.skill-tab-btn').forEach(b => b.classList.toggle('active', b === btn))
    document.getElementById('skillTabCreate').hidden = btn.dataset.skillTab !== 'create'
    document.getElementById('skillTabImport').hidden = btn.dataset.skillTab !== 'import'
  })
})

// File upload area
const skillFileArea = document.getElementById('skillFileArea')
const skillFileInput = document.getElementById('skillFileInput')
let skillFile = null

skillFileArea.addEventListener('click', () => skillFileInput.click())
skillFileArea.addEventListener('dragover', (e) => { e.preventDefault(); skillFileArea.style.borderColor = 'var(--accent)' })
skillFileArea.addEventListener('dragleave', () => { skillFileArea.style.borderColor = '' })
skillFileArea.addEventListener('drop', (e) => {
  e.preventDefault()
  skillFileArea.style.borderColor = ''
  const file = e.dataTransfer.files[0]
  if (file) { skillFile = file; document.getElementById('skillFileName').textContent = file.name }
})
skillFileInput.addEventListener('change', () => {
  const file = skillFileInput.files[0]
  if (file) { skillFile = file; document.getElementById('skillFileName').textContent = file.name }
})

// Create skill
document.getElementById('saveSkillBtn').addEventListener('click', async () => {
  if (!currentAgent) return
  const name = document.getElementById('skillName').value.trim()
  if (!name) { document.getElementById('skillName').focus(); return }

  const btn = document.getElementById('saveSkillBtn')
  btn.disabled = true
  btn.querySelector('.btn-text').hidden = true
  btn.querySelector('.btn-loading').hidden = false

  try {
    const res = await fetch(`/api/agents/${encodeURIComponent(currentAgent.name)}/skills`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name,
        description: document.getElementById('skillDescription').value.trim(),
      }),
    })
    if (!res.ok) {
      const err = await res.json()
      throw new Error(err.error || 'Hiba')
    }
    closeModal(skillModalOverlay)
    showToast('Skill hozzáadva')
    loadSkills(currentAgent.name)
  } catch (err) {
    showToast(`Hiba: ${err.message}`)
  } finally {
    btn.disabled = false
    btn.querySelector('.btn-text').hidden = false
    btn.querySelector('.btn-loading').hidden = true
  }
})

// Import skill
document.getElementById('importSkillBtn').addEventListener('click', async () => {
  if (!currentAgent || !skillFile) { showToast('Válassz egy .skill fájlt'); return }

  const btn = document.getElementById('importSkillBtn')
  btn.disabled = true
  btn.querySelector('.btn-text').hidden = true
  btn.querySelector('.btn-loading').hidden = false

  try {
    const formData = new FormData()
    formData.append('file', skillFile)
    const res = await fetch(`/api/agents/${encodeURIComponent(currentAgent.name)}/skills/import`, {
      method: 'POST',
      body: formData,
    })
    if (!res.ok) {
      const err = await res.json()
      throw new Error(err.error || 'Import hiba')
    }
    const result = await res.json()
    closeModal(skillModalOverlay)
    showToast(`Skill importálva: ${result.imported.join(', ')}`)
    skillFile = null
    document.getElementById('skillFileName').textContent = ''
    loadSkills(currentAgent.name)
  } catch (err) {
    showToast(`Hiba: ${err.message}`)
  } finally {
    btn.disabled = false
    btn.querySelector('.btn-text').hidden = false
    btn.querySelector('.btn-loading').hidden = true
  }
})

// ============================================================
// === Schedules ===
// ============================================================

const scheduleList = document.getElementById('scheduleList')
const scheduleEmpty = document.getElementById('scheduleEmpty')
const scheduleModalOverlay = document.getElementById('scheduleModalOverlay')
const scheduleFrequency = document.getElementById('scheduleFrequency')
const scheduleTimeGroup = document.getElementById('scheduleTimeGroup')
const customScheduleGroup = document.getElementById('customScheduleGroup')
const saveScheduleBtn = document.getElementById('saveScheduleBtn')

let schedules = []
let scheduleAgents = []
let currentScheduleView = 'list'

// Modal wiring
document.getElementById('addScheduleBtn').addEventListener('click', () => {
  resetScheduleForm()
  document.getElementById('scheduleModalTitle').textContent = 'Új ütemezett feladat'
  document.getElementById('scheduleName').disabled = false
  openModal(scheduleModalOverlay)
  loadScheduleAgents().then(() => {
    setTimeout(() => document.getElementById('scheduleName').focus(), 200)
  })
})
document.getElementById('scheduleModalClose').addEventListener('click', () => closeModal(scheduleModalOverlay))
scheduleModalOverlay.addEventListener('click', (e) => { if (e.target === scheduleModalOverlay) closeModal(scheduleModalOverlay) })

// Frequency change handler
scheduleFrequency.addEventListener('change', () => {
  const freq = scheduleFrequency.value
  const needsTime = ['daily', 'weekdays', 'weekly-mon', 'weekly-fri'].includes(freq)
  const isCustom = freq === 'custom'
  scheduleTimeGroup.hidden = !needsTime
  customScheduleGroup.hidden = !isCustom
  if (isCustom) document.getElementById('scheduleCustomCron').focus()
})

// View toggle buttons
document.querySelectorAll('.view-btn[data-view]').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.view-btn[data-view]').forEach(b => b.classList.remove('active'))
    btn.classList.add('active')
    currentScheduleView = btn.dataset.view
    document.getElementById('scheduleListView').hidden = currentScheduleView !== 'list'
    document.getElementById('scheduleTimelineView').hidden = currentScheduleView !== 'timeline'
    document.getElementById('scheduleWeekView').hidden = currentScheduleView !== 'week'
    if (currentScheduleView === 'timeline') renderTimeline(schedules)
    if (currentScheduleView === 'week') renderWeekView(schedules)
  })
})

function resetScheduleForm() {
  document.getElementById('scheduleName').value = ''
  document.getElementById('scheduleDesc').value = ''
  document.getElementById('schedulePrompt').value = ''
  scheduleFrequency.value = 'daily'
  document.getElementById('scheduleTime').value = '09:00'
  document.getElementById('scheduleCustomCron').value = ''
  customScheduleGroup.hidden = true
  scheduleTimeGroup.hidden = false
  document.getElementById('expandQuestions').hidden = true
  document.getElementById('expandStatus').textContent = ''
  expandAnswers = []
  document.getElementById('scheduleEditName').value = ''
  saveScheduleBtn.disabled = false
  saveScheduleBtn.querySelector('.btn-text').hidden = false
  saveScheduleBtn.querySelector('.btn-loading').hidden = true
}

function getScheduleCron() {
  const freq = scheduleFrequency.value
  if (freq === 'custom') return document.getElementById('scheduleCustomCron').value.trim()

  const time = document.getElementById('scheduleTime').value || '09:00'
  const [h, m] = time.split(':').map(Number)

  switch (freq) {
    case 'daily': return `${m} ${h} * * *`
    case 'weekdays': return `${m} ${h} * * 1-5`
    case 'weekly-mon': return `${m} ${h} * * 1`
    case 'weekly-fri': return `${m} ${h} * * 5`
    case 'hourly': return `0 * * * *`
    case 'every2h': return `0 */2 * * *`
    case 'every4h': return `0 */4 * * *`
    case 'every30m': return `*/30 * * * *`
    default: return `${m} ${h} * * *`
  }
}

function parseCronToForm(cron) {
  const parts = cron.split(' ')
  if (parts.length < 5) { scheduleFrequency.value = 'custom'; customScheduleGroup.hidden = false; document.getElementById('scheduleCustomCron').value = cron; return }
  const [minute, hour, dom, month, dow] = parts

  // Interval patterns
  if (minute === '*/30' && hour === '*') { scheduleFrequency.value = 'every30m'; scheduleTimeGroup.hidden = true; customScheduleGroup.hidden = true; return }
  if (minute === '0' && hour === '*') { scheduleFrequency.value = 'hourly'; scheduleTimeGroup.hidden = true; customScheduleGroup.hidden = true; return }
  if (minute === '0' && hour === '*/2') { scheduleFrequency.value = 'every2h'; scheduleTimeGroup.hidden = true; customScheduleGroup.hidden = true; return }
  if (minute === '0' && hour === '*/4') { scheduleFrequency.value = 'every4h'; scheduleTimeGroup.hidden = true; customScheduleGroup.hidden = true; return }

  // Time-based patterns
  const h = parseInt(hour); const m = parseInt(minute)
  if (!isNaN(h) && !isNaN(m)) {
    const timeStr = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
    document.getElementById('scheduleTime').value = timeStr
    scheduleTimeGroup.hidden = false
    customScheduleGroup.hidden = true

    if (dow === '1-5') { scheduleFrequency.value = 'weekdays'; return }
    if (dow === '1') { scheduleFrequency.value = 'weekly-mon'; return }
    if (dow === '5') { scheduleFrequency.value = 'weekly-fri'; return }
    if (dow === '*' && dom === '*') { scheduleFrequency.value = 'daily'; return }
  }

  // Fallback to custom
  scheduleFrequency.value = 'custom'
  customScheduleGroup.hidden = false
  scheduleTimeGroup.hidden = true
  document.getElementById('scheduleCustomCron').value = cron
}

function describeCron(cron) {
  const parts = cron.split(' ')
  if (parts.length < 5) return cron
  const [minute, hour, dom, month, dow] = parts

  // Interval patterns
  if (minute.startsWith('*/')) return `${minute.split('/')[1]} percenként`
  if (hour.startsWith('*/')) return `${hour.split('/')[1]} óránként`
  if (minute === '0' && hour === '*') return 'Minden órában'

  // Time-based
  const h = parseInt(hour); const m = parseInt(minute)
  if (!isNaN(h) && !isNaN(m)) {
    const timeStr = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
    const dowNames = { '1': 'Hétfőn', '2': 'Kedden', '3': 'Szerdán', '4': 'Csütörtökön', '5': 'Pénteken', '6': 'Szombaton', '0': 'Vasárnap', '7': 'Vasárnap' }
    if (dow === '1-5') return `Hétköznap ${timeStr}`
    if (dow === '0,6' || dow === '6,0') return `Hétvégén ${timeStr}`
    if (dowNames[dow]) return `${dowNames[dow]} ${timeStr}`
    if (dow === '*' && dom === '*') return `Naponta ${timeStr}`
    if (dom !== '*') return `Minden hónap ${dom}. napján ${timeStr}`
  }

  return cron
}

function cronToHours(cron) {
  const parts = cron.split(' ')
  if (parts.length < 5) return []
  const hour = parts[1]

  if (hour === '*') return Array.from({length: 24}, (_, i) => i)
  if (hour.includes('/')) {
    const step = parseInt(hour.split('/')[1])
    if (isNaN(step) || step <= 0) return []
    return Array.from({length: 24}, (_, i) => i).filter(h => h % step === 0)
  }
  if (hour.includes(',')) return hour.split(',').map(Number).filter(n => !isNaN(n))
  if (hour.includes('-')) {
    const [start, end] = hour.split('-').map(Number)
    if (isNaN(start) || isNaN(end)) return []
    return Array.from({length: end - start + 1}, (_, i) => start + i)
  }
  const h = parseInt(hour)
  return isNaN(h) ? [] : [h]
}

function cronToMinute(cron) {
  const parts = cron.split(' ')
  if (parts.length < 1) return 0
  const m = parseInt(parts[0])
  return isNaN(m) ? 0 : m
}

async function loadScheduleAgents() {
  try {
    const res = await fetch('/api/schedules/agents')
    scheduleAgents = await res.json()
    const sel = document.getElementById('scheduleAgent')
    sel.innerHTML = ''
    for (const a of scheduleAgents) {
      const opt = document.createElement('option')
      opt.value = a.name
      opt.textContent = a.label || a.name
      sel.appendChild(opt)
    }
  } catch (err) {
    console.error('Ágens lista hiba:', err)
  }
}

async function loadSchedules() {
  try {
    const [schedulesRes] = await Promise.all([
      fetch('/api/schedules'),
      loadScheduleAgents(),
    ])
    schedules = await schedulesRes.json()
    renderScheduleList(schedules)
    if (currentScheduleView === 'timeline') renderTimeline(schedules)
  } catch (err) {
    console.error('Ütemezés betöltés hiba:', err)
  }
}

function renderScheduleList(tasks) {
  scheduleList.innerHTML = ''
  scheduleEmpty.hidden = tasks.length > 0

  for (const task of tasks) {
    const row = document.createElement('div')
    row.className = 'schedule-row'
    const agent = scheduleAgents.find(a => a.name === task.agent) || { name: task.agent || 'marveen', avatar: '/api/marveen/avatar', label: task.agent || 'marveen' }

    row.innerHTML = `
      <div class="schedule-agent-avatar">
        <img src="${agent.avatar}?t=${Date.now()}" alt="" onerror="this.style.display='none'">
      </div>
      <div class="schedule-info">
        <div class="schedule-title">
          ${escapeHtml(task.description || task.name)}
          <span class="badge ${task.enabled ? 'badge-active' : 'badge-paused'}">${task.enabled ? 'aktív' : 'szünet'}</span>
        </div>
        <div class="schedule-meta">
          <span class="schedule-cron">${escapeHtml(task.schedule)}</span>
          <span>${describeCron(task.schedule)}</span>
          <span class="schedule-agent-name">${escapeHtml(agent.label || agent.name)}</span>
        </div>
      </div>
      <div class="schedule-actions">
        <button class="btn-icon" data-action="toggle" title="${task.enabled ? 'Szüneteltetés' : 'Folytatás'}">
          ${task.enabled ? pauseIcon() : playIcon()}
        </button>
        <button class="btn-icon btn-icon-danger" data-action="delete" title="Törlés">
          ${trashIcon()}
        </button>
      </div>
    `

    // Row click -> edit (but not action buttons)
    row.addEventListener('click', (e) => {
      if (e.target.closest('.btn-icon')) return
      openEditSchedule(task)
    })

    // Action buttons
    row.querySelector('[data-action="toggle"]').addEventListener('click', async (e) => {
      e.stopPropagation()
      try {
        await fetch(`/api/schedules/${encodeURIComponent(task.name)}/toggle`, { method: 'POST' })
        showToast(task.enabled ? 'Feladat szüneteltetve' : 'Feladat újraindult')
        loadSchedules()
      } catch { showToast('Hiba történt') }
    })

    row.querySelector('[data-action="delete"]').addEventListener('click', async (e) => {
      e.stopPropagation()
      if (!confirm('Biztosan törlöd ezt a feladatot?')) return
      try {
        await fetch(`/api/schedules/${encodeURIComponent(task.name)}`, { method: 'DELETE' })
        showToast('Feladat törölve')
        loadSchedules()
      } catch { showToast('Hiba a törlés során') }
    })

    scheduleList.appendChild(row)
  }
}

function renderTimeline(tasks) {
  const hoursEl = document.getElementById('timelineHours')
  const bodyEl = document.getElementById('timelineBody')
  hoursEl.innerHTML = ''
  bodyEl.innerHTML = ''

  // Build hour labels
  for (let h = 0; h < 24; h++) {
    const hourDiv = document.createElement('div')
    hourDiv.className = 'timeline-hour'
    hourDiv.textContent = h.toString().padStart(2, '0')
    hoursEl.appendChild(hourDiv)
  }

  // Group tasks by agent
  const agentTasks = {}
  for (const task of tasks) {
    const agentName = task.agent || 'marveen'
    if (!agentTasks[agentName]) agentTasks[agentName] = []
    agentTasks[agentName].push(task)
  }

  // If no tasks, show empty state
  if (Object.keys(agentTasks).length === 0) {
    bodyEl.innerHTML = '<div class="schedule-empty" style="padding:40px;text-align:center;color:var(--text-muted)">Nincsenek ütemezett feladatok</div>'
    return
  }

  for (const [agentName, agTasks] of Object.entries(agentTasks)) {
    const agent = scheduleAgents.find(a => a.name === agentName) || { name: agentName, avatar: '/api/marveen/avatar', label: agentName }

    const row = document.createElement('div')
    row.className = 'timeline-row'

    // Agent label
    row.innerHTML = `
      <div class="timeline-agent">
        <div class="timeline-agent-avatar">
          <img src="${agent.avatar}?t=${Date.now()}" alt="" onerror="this.style.display='none'">
        </div>
        <span class="timeline-agent-name">${escapeHtml(agent.label || agent.name)}</span>
      </div>
      <div class="timeline-track"></div>
    `

    const track = row.querySelector('.timeline-track')

    // Place markers for each task
    for (const task of agTasks) {
      const hours = cronToHours(task.schedule)
      const minute = cronToMinute(task.schedule)

      for (const h of hours) {
        const pct = ((h * 60 + minute) / (24 * 60)) * 100
        const marker = document.createElement('div')
        marker.className = 'timeline-marker' + (task.enabled ? '' : ' disabled')
        marker.style.left = `calc(${pct}% - 16px)`
        marker.innerHTML = `
          <img src="${agent.avatar}?t=${Date.now()}" alt="" onerror="this.style.display='none'">
          <div class="timeline-marker-tooltip">${escapeHtml(task.description || task.name)} - ${h.toString().padStart(2, '0')}:${minute.toString().padStart(2, '0')}</div>
        `
        marker.addEventListener('click', () => openEditSchedule(task))
        track.appendChild(marker)
      }
    }

    // "Now" indicator
    const now = new Date()
    const nowMinutes = now.getHours() * 60 + now.getMinutes()
    const nowPct = (nowMinutes / (24 * 60)) * 100
    const nowLine = document.createElement('div')
    nowLine.className = 'timeline-now'
    nowLine.style.left = `${nowPct}%`
    track.appendChild(nowLine)

    bodyEl.appendChild(row)
  }
}

function cronMatchesDay(cron, dayOfWeek) {
  // dayOfWeek: 0=Sun, 1=Mon, ..., 6=Sat
  const parts = cron.split(' ')
  if (parts.length < 5) return false
  const dow = parts[4]
  if (dow === '*') return true
  if (dow.includes(',')) return dow.split(',').map(Number).includes(dayOfWeek)
  if (dow.includes('-')) {
    const [start, end] = dow.split('-').map(Number)
    return dayOfWeek >= start && dayOfWeek <= end
  }
  return parseInt(dow) === dayOfWeek || (dayOfWeek === 0 && dow === '7')
}

function renderWeekView(data) {
  const grid = document.getElementById('weekGrid')
  grid.innerHTML = ''

  const dayNames = ['H', 'K', 'Sze', 'Cs', 'P', 'Szo', 'V']
  const dayNamesFull = ['Hétfő', 'Kedd', 'Szerda', 'Csütörtök', 'Péntek', 'Szombat', 'Vasárnap']
  const dayNums = [1, 2, 3, 4, 5, 6, 0]

  const today = new Date()
  const todayDow = today.getDay()

  function expandDay(targetCol) {
    grid.querySelectorAll('.week-day').forEach(d => d.classList.remove('week-day-expanded'))
    targetCol.classList.add('week-day-expanded')
  }

  for (let i = 0; i < 7; i++) {
    const dayDow = dayNums[i]
    const isToday = dayDow === todayDow
    const dayCol = document.createElement('div')
    dayCol.className = 'week-day' + (isToday ? ' week-day-today week-day-expanded' : '')

    const header = document.createElement('div')
    header.className = 'week-day-header'
    header.textContent = dayCol.classList.contains('week-day-expanded') ? dayNamesFull[i] : dayNames[i]
    header.dataset.short = dayNames[i]
    header.dataset.full = dayNamesFull[i]
    dayCol.appendChild(header)

    const tasksForDay = data.filter(t => t.enabled && cronMatchesDay(t.schedule, dayDow))

    // Collapsed count badge
    const countDiv = document.createElement('div')
    countDiv.className = 'week-day-count'
    countDiv.innerHTML = `<span class="week-day-count-num">${tasksForDay.length}</span>`
    dayCol.appendChild(countDiv)

    // Expanded task list (positioned by time)
    const tasksDiv = document.createElement('div')
    tasksDiv.className = 'week-day-tasks'

    if (tasksForDay.length === 0) {
      const empty = document.createElement('div')
      empty.className = 'week-day-empty'
      empty.textContent = 'Nincs feladat'
      dayCol.appendChild(empty)
    }

    // Add hour grid lines (6:00 - 22:00)
    for (let hr = 6; hr <= 22; hr += 2) {
      const pct = (hr / 24) * 100
      const line = document.createElement('div')
      line.className = 'week-hour-line'
      line.style.top = `${pct}%`
      tasksDiv.appendChild(line)
      const label = document.createElement('div')
      label.className = 'week-hour-label'
      label.style.top = `${pct}%`
      label.textContent = `${String(hr).padStart(2,'0')}:00`
      tasksDiv.appendChild(label)
    }

    // Group tasks by same time slot for side-by-side layout
    const timeSlots = {}
    for (const task of tasksForDay) {
      const parts = task.schedule.split(' ')
      const h = parseInt(parts[1]); const m = parseInt(parts[0])
      const key = `${h}:${m}`
      if (!timeSlots[key]) timeSlots[key] = []
      timeSlots[key].push(task)
    }

    for (const [key, tasks] of Object.entries(timeSlots)) {
      const [h, m] = key.split(':').map(Number)
      const topPct = ((h * 60 + m) / (24 * 60)) * 100
      const timeLabel = `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`
      const count = tasks.length

      tasks.forEach((task, idx) => {
        const agent = scheduleAgents.find(a => a.name === task.agent) || { name: task.agent || 'marveen', avatar: '/api/marveen/avatar' }

        const card = document.createElement('div')
        card.className = 'week-task-card'
        card.style.top = `${topPct}%`

        // Side by side: divide available width (after 32px label margin)
        const availableStart = 32 // px from left for hour labels
        const gap = 4
        if (count > 1) {
          card.style.left = `calc(${availableStart}px + ${idx} * ((100% - ${availableStart + 8}px) / ${count}) + ${idx * gap}px)`
          card.style.width = `calc((100% - ${availableStart + 8 + (count - 1) * gap}px) / ${count})`
        } else {
          card.style.left = `${availableStart}px`
          card.style.right = '8px'
        }

        card.innerHTML = `
          <div class="week-task-avatar"><img src="${agent.avatar}?t=${Date.now()}" alt=""></div>
          <div class="week-task-info">
            <div class="week-task-time">${timeLabel}</div>
            <div class="week-task-name">${escapeHtml(task.description || task.name)}</div>
          </div>
        `
        card.addEventListener('click', (e) => { e.stopPropagation(); openEditSchedule(task) })
        tasksDiv.appendChild(card)
      })
    }

    dayCol.appendChild(tasksDiv)

    // Click to expand
    dayCol.addEventListener('click', () => {
      if (!dayCol.classList.contains('week-day-expanded')) {
        expandDay(dayCol)
        // Update headers
        grid.querySelectorAll('.week-day-header').forEach(hdr => {
          hdr.textContent = hdr.closest('.week-day-expanded') ? hdr.dataset.full : hdr.dataset.short
        })
      }
    })

    grid.appendChild(dayCol)
  }
}

function openEditSchedule(task) {
  // Reset expand state
  document.getElementById('expandQuestions').hidden = true
  document.getElementById('expandStatus').textContent = ''
  expandAnswers = []

  loadScheduleAgents().then(() => {
    document.getElementById('scheduleModalTitle').textContent = 'Feladat szerkesztése'
    document.getElementById('scheduleName').value = task.name
    document.getElementById('scheduleName').disabled = true
    document.getElementById('scheduleDesc').value = task.description || ''
    document.getElementById('schedulePrompt').value = task.prompt || ''
    document.getElementById('scheduleEditName').value = task.name

    // Set agent
    const agentSel = document.getElementById('scheduleAgent')
    if (agentSel.querySelector(`option[value="${task.agent}"]`)) {
      agentSel.value = task.agent
    }

    // Parse cron back to frequency + time
    parseCronToForm(task.schedule)

    openModal(scheduleModalOverlay)
  })
}

// Save schedule (create or update)
// === Prompt expand ===
let expandAnswers = []

document.getElementById('expandPromptBtn').addEventListener('click', async () => {
  const prompt = document.getElementById('schedulePrompt').value.trim()
  if (!prompt) { document.getElementById('schedulePrompt').focus(); return }

  const statusEl = document.getElementById('expandStatus')
  const questionsEl = document.getElementById('expandQuestions')
  const btn = document.getElementById('expandPromptBtn')

  btn.disabled = true
  statusEl.textContent = 'Kérdések generálása...'
  expandAnswers = []

  try {
    const agent = document.getElementById('scheduleAgent').value
    const res = await fetch('/api/schedules/expand-questions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt, agent }),
    })
    if (!res.ok) throw new Error()
    const questions = await res.json()

    questionsEl.innerHTML = ''
    questionsEl.hidden = false
    statusEl.textContent = ''

    for (const q of questions) {
      const qDiv = document.createElement('div')
      qDiv.className = 'expand-question'

      const qText = document.createElement('div')
      qText.className = 'expand-question-text'
      qText.textContent = q.question
      qDiv.appendChild(qText)

      const optionsDiv = document.createElement('div')
      optionsDiv.className = 'expand-options'
      for (const opt of q.options) {
        const optBtn = document.createElement('button')
        optBtn.type = 'button'
        optBtn.className = 'expand-option'
        optBtn.textContent = opt
        optBtn.addEventListener('click', () => {
          optionsDiv.querySelectorAll('.expand-option').forEach(o => o.classList.remove('selected'))
          optBtn.classList.add('selected')
          // Store answer
          const existing = expandAnswers.find(a => a.question === q.question)
          if (existing) existing.answer = opt
          else expandAnswers.push({ question: q.question, answer: opt })
        })
        optionsDiv.appendChild(optBtn)
      }
      qDiv.appendChild(optionsDiv)
      questionsEl.appendChild(qDiv)
    }

    // Apply button
    const applyRow = document.createElement('div')
    applyRow.className = 'expand-apply-row'
    const applyBtn = document.createElement('button')
    applyBtn.type = 'button'
    applyBtn.className = 'btn-primary btn-compact'
    applyBtn.innerHTML = '<span class="btn-text">Prompt kibővítése</span><span class="btn-loading" hidden><span class="spinner"></span></span>'
    applyBtn.addEventListener('click', async () => {
      if (expandAnswers.length === 0) { showToast('Válaszolj legalább egy kérdésre'); return }
      applyBtn.disabled = true
      applyBtn.querySelector('.btn-text').hidden = true
      applyBtn.querySelector('.btn-loading').hidden = false
      try {
        const res2 = await fetch('/api/schedules/expand-prompt', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ prompt, answers: expandAnswers }),
        })
        if (!res2.ok) throw new Error()
        const { prompt: expanded } = await res2.json()
        document.getElementById('schedulePrompt').value = expanded
        questionsEl.hidden = true
        showToast('Prompt kibővítve!')
      } catch {
        showToast('Hiba a kibővítés során')
      } finally {
        applyBtn.disabled = false
        applyBtn.querySelector('.btn-text').hidden = false
        applyBtn.querySelector('.btn-loading').hidden = true
      }
    })
    applyRow.appendChild(applyBtn)
    questionsEl.appendChild(applyRow)
  } catch {
    statusEl.textContent = 'Hiba a kérdések generálásakor'
  } finally {
    btn.disabled = false
  }
})

saveScheduleBtn.addEventListener('click', async () => {
  const editName = document.getElementById('scheduleEditName').value
  const name = document.getElementById('scheduleName').value.trim()
  const description = document.getElementById('scheduleDesc').value.trim()
  const prompt = document.getElementById('schedulePrompt').value.trim()
  const schedule = getScheduleCron()
  const agent = document.getElementById('scheduleAgent').value

  if (!name) { document.getElementById('scheduleName').focus(); return }
  if (!prompt) { document.getElementById('schedulePrompt').focus(); return }
  if (!schedule) { showToast('Válassz ütemezést'); return }

  saveScheduleBtn.disabled = true
  saveScheduleBtn.querySelector('.btn-text').hidden = true
  saveScheduleBtn.querySelector('.btn-loading').hidden = false

  try {
    if (editName) {
      // Update
      const res = await fetch(`/api/schedules/${encodeURIComponent(editName)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ description, prompt, schedule, agent }),
      })
      if (!res.ok) {
        const err = await res.json()
        throw new Error(err.error || 'Hiba')
      }
      showToast('Feladat frissítve')
    } else {
      // Create
      const res = await fetch('/api/schedules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, description, prompt, schedule, agent }),
      })
      if (!res.ok) {
        const err = await res.json()
        throw new Error(err.error || 'Ismeretlen hiba')
      }
      showToast('Feladat létrehozva!')
    }
    closeModal(scheduleModalOverlay)
    loadSchedules()
  } catch (err) {
    showToast(`Hiba: ${err.message}`)
  } finally {
    saveScheduleBtn.disabled = false
    saveScheduleBtn.querySelector('.btn-text').hidden = false
    saveScheduleBtn.querySelector('.btn-loading').hidden = true
  }
})

// ============================================================
// === Memories (Tier System + Daily Log) ===
// ============================================================

const memList = document.getElementById('memList')
const memEmpty = document.getElementById('memEmpty')
const memStats = document.getElementById('memStats')
const memSearchInput = document.getElementById('memSearchInput')
const memModalOverlay = document.getElementById('memModalOverlay')

let memSearchTimer = null
let currentMemTier = 'hot'
let currentLogDate = new Date().toISOString().split('T')[0]
let logDates = []

const tierLabels = { hot: '\u{1F525} Hot', warm: '\u{1F321}\uFE0F Warm', cold: '\u2744\uFE0F Cold', shared: '\u{1F517} Shared' }
const tierColors = { hot: '#dc3c3c', warm: '#d97757', cold: '#6a9bcc', shared: '#9a8a30' }

// Populate agent dropdowns from API
async function loadMemAgents() {
  try {
    const res = await fetch('/api/schedules/agents')
    const agents = await res.json()
    const sel = document.getElementById('memAgentFilter')
    const memSel = document.getElementById('memAgent')
    sel.innerHTML = '<option value="">Minden agens</option>'
    memSel.innerHTML = ''
    for (const a of agents) {
      sel.innerHTML += `<option value="${a.name}">${a.label}</option>`
      memSel.innerHTML += `<option value="${a.name}">${a.label}</option>`
    }
  } catch {}
}

// Agent filter change
document.getElementById('memAgentFilter').addEventListener('change', () => {
  if (currentMemTier === 'graph') {
    loadMemoryGraph()
  } else if (currentMemTier === 'log') {
    loadDailyLog()
  } else {
    loadMemories()
  }
})

// Search with debounce
memSearchInput.addEventListener('input', () => {
  clearTimeout(memSearchTimer)
  memSearchTimer = setTimeout(loadMemories, 300)
})

// Enter to search immediately
memSearchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    clearTimeout(memSearchTimer)
    loadMemories()
  }
})

// Tab switching
document.getElementById('memTabs').addEventListener('click', (e) => {
  const tab = e.target.closest('.mem-tab')
  if (!tab) return
  document.querySelectorAll('.mem-tab').forEach(t => t.classList.remove('active'))
  tab.classList.add('active')
  currentMemTier = tab.dataset.tier

  const isLog = currentMemTier === 'log'
  const isGraph = currentMemTier === 'graph'
  document.getElementById('memTierView').hidden = isLog || isGraph
  document.getElementById('memLogView').hidden = !isLog
  document.getElementById('memGraphView').hidden = !isGraph

  if (isGraph) {
    loadMemoryGraph()
  } else if (isLog) {
    loadDailyLog()
  } else {
    loadMemories()
  }
})

// Add memory button
document.getElementById('memAddBtn').addEventListener('click', () => {
  document.getElementById('memModalTitle').textContent = 'Uj emlek'
  document.getElementById('memContent').value = ''
  document.getElementById('memTier').value = (currentMemTier === 'log' || currentMemTier === 'graph') ? 'warm' : currentMemTier
  document.getElementById('memKeywords').value = ''
  document.getElementById('memEditId').value = ''
  openModal(memModalOverlay)
  setTimeout(() => document.getElementById('memContent').focus(), 200)
})

// Close memory modal
document.getElementById('memModalClose').addEventListener('click', () => closeModal(memModalOverlay))
memModalOverlay.addEventListener('click', (e) => { if (e.target === memModalOverlay) closeModal(memModalOverlay) })

// Save memory (create or edit)
document.getElementById('saveMemBtn').addEventListener('click', async () => {
  const content = document.getElementById('memContent').value.trim()
  if (!content) { document.getElementById('memContent').focus(); return }

  const editId = document.getElementById('memEditId').value
  const tier = document.getElementById('memTier').value
  const agentId = document.getElementById('memAgent').value
  const keywords = document.getElementById('memKeywords').value.trim()

  try {
    if (editId) {
      await fetch(`/api/memories/${editId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content, tier, agent_id: agentId, keywords }),
      })
      showToast('Emlek frissitve')
    } else {
      await fetch('/api/memories', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agent_id: agentId, content, tier, keywords }),
      })
      showToast('Emlek letrehozva')
    }
    closeModal(memModalOverlay)
    loadMemories()
    loadMemStats()
  } catch {
    showToast('Hiba a mentes soran')
  }
})

async function loadMemStats() {
  try {
    const res = await fetch('/api/memories/stats')
    const stats = await res.json()
    memStats.innerHTML = `
      <div class="stat-card"><div class="stat-value">${stats.total}</div><div class="stat-label">Összes</div></div>
      ${Object.entries(stats.byTier || {}).map(([tier, count]) =>
        `<div class="stat-card"><div class="stat-value" style="color:${tierColors[tier] || 'var(--accent)'}">${count}</div><div class="stat-label">${tierLabels[tier] || tier}</div></div>`
      ).join('')}
    `
  } catch (err) {
    console.error('Stats hiba:', err)
  }
}

async function loadMemories() {
  if (currentMemTier === 'log' || currentMemTier === 'graph') return
  const q = memSearchInput.value.trim()
  const agent = document.getElementById('memAgentFilter').value
  const params = new URLSearchParams()
  if (q) params.set('q', q)
  if (agent) params.set('agent', agent)
  if (currentMemTier) params.set('tier', currentMemTier)
  params.set('limit', '50')

  try {
    const res = await fetch(`/api/memories?${params}`)
    const memories = await res.json()
    renderMemories(memories)
  } catch (err) {
    console.error('Memoria betoltes hiba:', err)
  }
}

function renderMemories(memories) {
  memList.innerHTML = ''
  memEmpty.hidden = memories.length > 0

  for (const mem of memories) {
    const item = document.createElement('div')
    item.className = 'mem-item'

    const tier = mem.tier || mem.category || 'warm'
    const tierBadge = tierLabels[tier] || tier
    const badgeClass = 'badge-' + tier
    const shortContent = mem.content.length > 120 ? mem.content.slice(0, 120) + '...' : mem.content
    const agentLabel = mem.agent_id || 'marveen'

    // Build keywords HTML
    let keywordsHtml = ''
    if (mem.keywords) {
      const kws = typeof mem.keywords === 'string' ? mem.keywords.split(',').map(k => k.trim()).filter(Boolean) : mem.keywords
      if (kws.length > 0) {
        keywordsHtml = `<div class="mem-keywords">${kws.map(k => `<span class="mem-keyword-tag">${escapeHtml(k)}</span>`).join('')}</div>`
      }
    }

    item.innerHTML = `
      <div class="mem-item-header">
        <span class="badge ${badgeClass}">${tierBadge}</span>
        <span class="mem-agent-badge">${escapeHtml(agentLabel)}</span>
        <span class="mem-date">${escapeHtml(mem.created_label || '')}</span>
        ${typeof mem.salience === 'number' ? `<span class="mem-salience" title="Relevancia ertek">S: ${mem.salience.toFixed(2)}</span>` : ''}
      </div>
      <div class="mem-content-short">${escapeHtml(shortContent)}</div>
      <div class="mem-content-full">${escapeHtml(mem.content)}</div>
      ${keywordsHtml}
      <div class="mem-item-footer">
        <button class="btn-secondary" data-edit-memid="${mem.id}" style="padding:6px 14px; font-size:12px;">Szerkesztes</button>
        <button class="btn-danger" data-memid="${mem.id}" style="padding:6px 14px; font-size:12px;">Torles</button>
      </div>
    `

    // Toggle expand
    item.addEventListener('click', (e) => {
      if (e.target.closest('.btn-danger') || e.target.closest('.btn-secondary')) return
      item.classList.toggle('expanded')
    })

    // Edit
    const editBtn = item.querySelector('[data-edit-memid]')
    editBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      document.getElementById('memModalTitle').textContent = 'Emlek szerkesztese'
      document.getElementById('memContent').value = mem.content
      document.getElementById('memTier').value = tier
      document.getElementById('memKeywords').value = mem.keywords || ''
      document.getElementById('memEditId').value = mem.id
      if (mem.agent_id) document.getElementById('memAgent').value = mem.agent_id
      openModal(memModalOverlay)
    })

    // Delete
    const delBtn = item.querySelector('.btn-danger')
    delBtn.addEventListener('click', async (e) => {
      e.stopPropagation()
      if (!confirm('Biztosan torlod ezt az emleket?')) return
      try {
        await fetch(`/api/memories/${mem.id}`, { method: 'DELETE' })
        showToast('Emlek torolve')
        loadMemories()
        loadMemStats()
      } catch {
        showToast('Hiba a torles soran')
      }
    })

    memList.appendChild(item)
  }
}

// === Memory Graph (Force-directed) ===

let graphNodes = []
let graphEdges = []
let graphSim = null
let graphCanvas = null
let graphCtx = null
let graphDragging = null
let graphHover = null

const GRAPH_TIER_COLORS = {
  hot: '#dc3c3c',
  warm: '#d97757',
  cold: '#6a9bcc',
  shared: '#b0a040',
}

async function loadMemoryGraph() {
  const agent = document.getElementById('memAgentFilter').value
  const params = new URLSearchParams()
  if (agent) params.set('agent', agent)
  params.set('limit', '200')

  try {
    const res = await fetch(`/api/memories?${params}`)
    const memories = await res.json()

    const emptyEl = document.getElementById('graphEmpty')
    if (!memories || memories.length === 0) {
      emptyEl.hidden = false
      document.getElementById('memGraphCanvas').hidden = true
      return
    }
    emptyEl.hidden = true
    document.getElementById('memGraphCanvas').hidden = false

    buildGraph(memories)
    startGraphSimulation()
  } catch (err) {
    console.error('Graph betoltes hiba:', err)
  }
}

function buildGraph(memories) {
  graphNodes = []
  graphEdges = []

  const canvas = document.getElementById('memGraphCanvas')
  const rect = canvas.parentElement.getBoundingClientRect()
  const dpr = window.devicePixelRatio || 1
  canvas.width = rect.width * dpr
  canvas.height = rect.height * dpr
  canvas.style.width = rect.width + 'px'
  canvas.style.height = rect.height + 'px'
  graphCanvas = canvas
  graphCtx = canvas.getContext('2d')
  graphCtx.setTransform(dpr, 0, 0, dpr, 0, 0)

  const w = rect.width
  const h = rect.height

  // Create nodes from memories
  for (const mem of memories) {
    const keywords = (mem.keywords || '').split(',').map(k => k.trim()).filter(Boolean)
    const label = mem.content.slice(0, 40).replace(/\n/g, ' ')
    graphNodes.push({
      id: mem.id,
      x: w / 2 + (Math.random() - 0.5) * w * 0.6,
      y: h / 2 + (Math.random() - 0.5) * h * 0.6,
      vx: (Math.random() - 0.5) * 2,
      vy: (Math.random() - 0.5) * 2,
      radius: 6 + Math.min(keywords.length * 2, 10),
      label: label,
      tier: mem.tier || mem.category || 'warm',
      agent: mem.agent_id || 'marveen',
      keywords: keywords,
      mem: mem,
    })
  }

  // Create edges based on shared keywords
  for (let i = 0; i < graphNodes.length; i++) {
    for (let j = i + 1; j < graphNodes.length; j++) {
      const a = graphNodes[i]
      const b = graphNodes[j]
      const shared = a.keywords.filter(k => b.keywords.includes(k))
      if (shared.length > 0) {
        graphEdges.push({ source: i, target: j, strength: shared.length })
      }
      // Also connect same-agent same-tier with low probability
      if (a.agent === b.agent && a.tier === b.tier && Math.random() < 0.3) {
        graphEdges.push({ source: i, target: j, strength: 0.5 })
      }
    }
  }
}

function startGraphSimulation() {
  if (graphSim) cancelAnimationFrame(graphSim)

  let frame = 0
  const maxFrames = 300

  function tick() {
    if (frame > maxFrames) {
      renderGraph()
      return
    }
    frame++
    const damping = 0.95 + (frame / maxFrames) * 0.04

    const w = graphCanvas.width / (window.devicePixelRatio || 1)
    const h = graphCanvas.height / (window.devicePixelRatio || 1)
    const nodes = graphNodes

    // Repulsion (all nodes push each other away)
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        let dx = nodes[j].x - nodes[i].x
        let dy = nodes[j].y - nodes[i].y
        let dist = Math.sqrt(dx * dx + dy * dy) || 1
        let force = 800 / (dist * dist)
        let fx = (dx / dist) * force
        let fy = (dy / dist) * force
        nodes[i].vx -= fx
        nodes[i].vy -= fy
        nodes[j].vx += fx
        nodes[j].vy += fy
      }
    }

    // Attraction (edges pull connected nodes together)
    for (const edge of graphEdges) {
      const a = nodes[edge.source]
      const b = nodes[edge.target]
      let dx = b.x - a.x
      let dy = b.y - a.y
      let dist = Math.sqrt(dx * dx + dy * dy) || 1
      let force = (dist - 80) * 0.005 * edge.strength
      let fx = (dx / dist) * force
      let fy = (dy / dist) * force
      a.vx += fx
      a.vy += fy
      b.vx -= fx
      b.vy -= fy
    }

    // Center gravity
    for (const node of nodes) {
      node.vx += (w / 2 - node.x) * 0.001
      node.vy += (h / 2 - node.y) * 0.001
    }

    // Apply velocity with damping
    for (const node of nodes) {
      if (node === graphDragging) continue
      node.vx *= damping
      node.vy *= damping
      node.x += node.vx
      node.y += node.vy
      // Bounds
      node.x = Math.max(20, Math.min(w - 20, node.x))
      node.y = Math.max(20, Math.min(h - 20, node.y))
    }

    renderGraph()
    graphSim = requestAnimationFrame(tick)
  }

  tick()
}

function renderGraph() {
  const ctx = graphCtx
  const dpr = window.devicePixelRatio || 1
  const w = graphCanvas.width / dpr
  const h = graphCanvas.height / dpr

  ctx.clearRect(0, 0, w, h)

  const cs = getComputedStyle(document.documentElement)
  const borderColor = cs.getPropertyValue('--border').trim() || '#d1cfc5'
  const textColor = cs.getPropertyValue('--text').trim() || '#141413'
  const textMuted = cs.getPropertyValue('--text-muted').trim() || '#87867f'
  const bgCard = cs.getPropertyValue('--bg-card').trim() || '#fff'

  // Draw edges
  ctx.lineWidth = 0.5
  for (const edge of graphEdges) {
    const a = graphNodes[edge.source]
    const b = graphNodes[edge.target]
    ctx.strokeStyle = borderColor
    ctx.globalAlpha = 0.3 + Math.min(edge.strength * 0.2, 0.5)
    ctx.beginPath()
    ctx.moveTo(a.x, a.y)
    ctx.lineTo(b.x, b.y)
    ctx.stroke()
  }
  ctx.globalAlpha = 1

  // Draw nodes
  for (const node of graphNodes) {
    const color = GRAPH_TIER_COLORS[node.tier] || '#d97757'
    const isHover = node === graphHover

    if (isHover) {
      ctx.shadowColor = color
      ctx.shadowBlur = 15
    }

    ctx.fillStyle = color
    ctx.globalAlpha = isHover ? 1 : 0.8
    ctx.beginPath()
    ctx.arc(node.x, node.y, isHover ? node.radius + 2 : node.radius, 0, Math.PI * 2)
    ctx.fill()

    ctx.shadowBlur = 0
    ctx.globalAlpha = 1

    // Label for larger nodes or hover
    if (isHover || node.radius > 10) {
      ctx.fillStyle = textColor
      ctx.font = isHover ? 'bold 12px -apple-system, sans-serif' : '10px -apple-system, sans-serif'
      ctx.textAlign = 'center'
      ctx.fillText(node.label, node.x, node.y + node.radius + 14)
    }
  }

  // Hover tooltip
  if (graphHover) {
    const node = graphHover
    const tLabels = { hot: 'Hot', warm: 'Warm', cold: 'Cold', shared: 'Shared' }
    const text = `${tLabels[node.tier] || node.tier} | ${node.agent}`
    const kw = node.keywords.length > 0 ? node.keywords.join(', ') : ''

    ctx.font = 'bold 11px -apple-system, sans-serif'
    const tw = Math.max(ctx.measureText(text).width, kw ? ctx.measureText(kw).width : 0) + 20
    const th = kw ? 50 : 32
    let tx = node.x - tw / 2
    let ty = node.y - node.radius - th - 10

    // Keep tooltip in bounds
    tx = Math.max(5, Math.min(w - tw - 5, tx))
    ty = Math.max(5, ty)

    // Tooltip background
    ctx.fillStyle = bgCard
    ctx.strokeStyle = borderColor
    ctx.lineWidth = 1
    graphRoundRect(ctx, tx, ty, tw, th, 6)
    ctx.fill()
    ctx.stroke()

    ctx.fillStyle = textColor
    ctx.font = 'bold 11px -apple-system, sans-serif'
    ctx.textAlign = 'left'
    ctx.fillText(text, tx + 10, ty + 18)
    if (kw) {
      ctx.font = '10px -apple-system, sans-serif'
      ctx.fillStyle = textMuted
      ctx.fillText(kw, tx + 10, ty + 36)
    }
  }
}

function graphRoundRect(ctx, x, y, w, h, r) {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.lineTo(x + w - r, y)
  ctx.quadraticCurveTo(x + w, y, x + w, y + r)
  ctx.lineTo(x + w, y + h - r)
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h)
  ctx.lineTo(x + r, y + h)
  ctx.quadraticCurveTo(x, y + h, x, y + h - r)
  ctx.lineTo(x, y + r)
  ctx.quadraticCurveTo(x, y, x + r, y)
  ctx.closePath()
}

function openEditMemory(mem) {
  document.getElementById('memModalTitle').textContent = 'Emlek szerkesztese'
  document.getElementById('memAgent').value = mem.agent_id || 'marveen'
  document.getElementById('memTier').value = mem.tier || mem.category || 'warm'
  document.getElementById('memContent').value = mem.content || ''
  document.getElementById('memKeywords').value = mem.keywords || ''
  document.getElementById('memEditId').value = mem.id
  openModal(memModalOverlay)
}

// Graph mouse interaction
;(function initGraphInteraction() {
  const canvas = document.getElementById('memGraphCanvas')

  canvas.addEventListener('mousemove', (e) => {
    const rect = e.target.getBoundingClientRect()
    const mx = e.clientX - rect.left
    const my = e.clientY - rect.top

    if (graphDragging) {
      graphDragging.x = mx
      graphDragging.y = my
      graphDragging.vx = 0
      graphDragging.vy = 0
      renderGraph()
      return
    }

    graphHover = null
    for (const node of graphNodes) {
      const dx = mx - node.x
      const dy = my - node.y
      if (dx * dx + dy * dy < (node.radius + 4) * (node.radius + 4)) {
        graphHover = node
        break
      }
    }
    if (graphNodes.length > 0) renderGraph()
  })

  canvas.addEventListener('mousedown', (e) => {
    if (graphHover) {
      graphDragging = graphHover
      e.target.style.cursor = 'grabbing'
    }
  })

  canvas.addEventListener('dblclick', () => {
    if (graphHover && graphHover.mem) {
      openEditMemory(graphHover.mem)
    }
  })

  document.addEventListener('mouseup', () => {
    if (graphDragging) {
      graphDragging = null
      const c = document.getElementById('memGraphCanvas')
      if (c) c.style.cursor = 'grab'
    }
  })
})()

// === Daily Log ===

async function loadDailyLog() {
  const agent = document.getElementById('memAgentFilter').value || 'marveen'

  try {
    const datesRes = await fetch(`/api/daily-log/dates?agent=${agent}`)
    logDates = await datesRes.json()
  } catch {
    logDates = []
  }

  document.getElementById('logCurrentDate').textContent = formatLogDate(currentLogDate)

  try {
    const res = await fetch(`/api/daily-log?agent=${agent}&date=${currentLogDate}`)
    const entries = await res.json()
    renderLogEntries(entries)
  } catch {
    renderLogEntries([])
  }
}

function renderLogEntries(entries) {
  const el = document.getElementById('logEntries')
  const empty = document.getElementById('logEmpty')
  el.innerHTML = ''
  empty.hidden = entries.length > 0

  for (const entry of entries) {
    const time = new Date(entry.created_at * 1000).toLocaleTimeString('hu-HU', { hour: '2-digit', minute: '2-digit' })
    const div = document.createElement('div')
    div.className = 'log-entry'
    div.innerHTML = `
      <div class="log-entry-time">${time}</div>
      <div class="log-entry-content">${escapeHtml(entry.content)}</div>
    `
    el.appendChild(div)
  }
}

function formatLogDate(dateStr) {
  const d = new Date(dateStr + 'T12:00:00')
  return d.toLocaleDateString('hu-HU', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' })
}

// Date navigation
document.getElementById('logPrevDate').addEventListener('click', () => {
  const d = new Date(currentLogDate)
  d.setDate(d.getDate() - 1)
  currentLogDate = d.toISOString().split('T')[0]
  loadDailyLog()
})
document.getElementById('logNextDate').addEventListener('click', () => {
  const d = new Date(currentLogDate)
  d.setDate(d.getDate() + 1)
  currentLogDate = d.toISOString().split('T')[0]
  loadDailyLog()
})

// === SVG icons ===
function pauseIcon() {
  return '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></svg>'
}
function playIcon() {
  return '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>'
}
function trashIcon() {
  return '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>'
}

// ============================================================
// === Connectors ===
// ============================================================

const connectorGrid = document.getElementById('connectorGrid')
const connectorStats = document.getElementById('connectorStats')
const connectorModalOverlay = document.getElementById('connectorModalOverlay')
const connectorDetailOverlay = document.getElementById('connectorDetailOverlay')
let connectors = []

// Modal wiring
document.getElementById('addConnectorBtn').addEventListener('click', () => {
  document.getElementById('connectorName').value = ''
  document.getElementById('connectorUrl').value = ''
  document.getElementById('connectorCmd').value = ''
  document.getElementById('connectorArgs').value = ''
  document.getElementById('connectorType').value = 'remote'
  document.getElementById('connectorScope').value = 'user'
  document.getElementById('connectorUrlGroup').hidden = false
  document.getElementById('connectorCmdGroup').hidden = true
  document.getElementById('connectorArgsGroup').hidden = true
  openModal(connectorModalOverlay)
})
document.getElementById('connectorModalClose').addEventListener('click', () => closeModal(connectorModalOverlay))
document.getElementById('connectorDetailClose').addEventListener('click', () => closeModal(connectorDetailOverlay))
connectorModalOverlay.addEventListener('click', (e) => { if (e.target === connectorModalOverlay) closeModal(connectorModalOverlay) })
connectorDetailOverlay.addEventListener('click', (e) => { if (e.target === connectorDetailOverlay) closeModal(connectorDetailOverlay) })

// Type toggle
document.getElementById('connectorType').addEventListener('change', () => {
  const isLocal = document.getElementById('connectorType').value === 'local'
  document.getElementById('connectorUrlGroup').hidden = isLocal
  document.getElementById('connectorCmdGroup').hidden = !isLocal
  document.getElementById('connectorArgsGroup').hidden = !isLocal
})

async function loadConnectors() {
  connectorGrid.innerHTML = '<div class="connector-loading"><span class="spinner"></span> Connectorok betoltese...</div>'
  connectorStats.innerHTML = ''
  try {
    const res = await fetch('/api/connectors')
    connectors = await res.json()
    renderConnectors()
  } catch (err) {
    console.error('Connector betoltes hiba:', err)
    connectorGrid.innerHTML = '<div class="connector-loading">Hiba a betoltes soran</div>'
  }
}

function renderConnectors() {
  // Stats
  const connected = connectors.filter(c => c.status === 'connected').length
  const needsAuth = connectors.filter(c => c.status === 'needs_auth').length
  const failed = connectors.filter(c => c.status === 'failed').length
  connectorStats.innerHTML = `
    <div class="stat-card"><div class="stat-value">${connectors.length}</div><div class="stat-label">Összes</div></div>
    <div class="stat-card"><div class="stat-value" style="color:var(--success)">${connected}</div><div class="stat-label">Aktív</div></div>
    ${needsAuth ? `<div class="stat-card"><div class="stat-value" style="color:var(--accent)">${needsAuth}</div><div class="stat-label">Auth szükséges</div></div>` : ''}
    ${failed ? `<div class="stat-card"><div class="stat-value" style="color:var(--danger)">${failed}</div><div class="stat-label">Hibás</div></div>` : ''}
  `

  // Grid
  connectorGrid.innerHTML = ''
  if (connectors.length === 0) {
    connectorGrid.innerHTML = '<div class="connector-loading">Nincsenek MCP connectorok</div>'
    return
  }
  for (const c of connectors) {
    const card = document.createElement('div')
    card.className = 'connector-card'
    card.innerHTML = `
      <div class="connector-status-dot ${c.status}"></div>
      <div class="connector-info">
        <div class="connector-name">${escapeHtml(c.name)}</div>
        <div class="connector-endpoint">${escapeHtml(c.endpoint || '')}</div>
      </div>
      <span class="connector-type-badge ${c.type}">${c.type}</span>
    `
    card.addEventListener('click', () => openConnectorDetail(c))
    connectorGrid.appendChild(card)
  }
}

async function openConnectorDetail(connector) {
  document.getElementById('connectorDetailTitle').textContent = connector.name

  // Fetch detailed info
  try {
    const res = await fetch(`/api/connectors/${encodeURIComponent(connector.name)}`)
    const detail = await res.json()

    const statusLabels = { connected: 'Csatlakozva', needs_auth: 'Auth szükséges', failed: 'Hiba', unknown: 'Ismeretlen' }
    const statusColors = { connected: 'var(--success)', needs_auth: 'var(--accent)', failed: 'var(--danger)', unknown: 'var(--text-muted)' }

    document.getElementById('connectorDetailInfo').innerHTML = `
      <div class="connector-detail-row">
        <span class="meta-label">Statusz</span>
        <span class="meta-value" style="color:${statusColors[detail.status] || ''}">${statusLabels[detail.status] || detail.status}</span>
      </div>
      <div class="connector-detail-row">
        <span class="meta-label">Hatokor</span>
        <span class="meta-value">${escapeHtml(detail.scope || '-')}</span>
      </div>
      ${detail.type ? `<div class="connector-detail-row"><span class="meta-label">Tipus</span><span class="meta-value">${escapeHtml(detail.type)}</span></div>` : ''}
      ${detail.command ? `<div class="connector-detail-row"><span class="meta-label">Parancs</span><span class="meta-value" style="font-family:monospace;font-size:12px">${escapeHtml(detail.command)} ${escapeHtml(detail.args || '')}</span></div>` : ''}
      ${Object.keys(detail.env || {}).length ? `<div class="connector-detail-row"><span class="meta-label">Env</span><span class="meta-value" style="font-family:monospace;font-size:11px">${Object.entries(detail.env).map(([k,v]) => `${k}=${v}`).join(', ')}</span></div>` : ''}
    `
  } catch {
    document.getElementById('connectorDetailInfo').innerHTML = '<p>Részletek betöltése sikertelen</p>'
  }

  // Agent assignment
  try {
    const agentsRes = await fetch('/api/schedules/agents')
    const allAgents = await agentsRes.json()
    const assignableAgents = allAgents.filter(a => a.name !== 'marveen')

    const listEl = document.getElementById('connectorAgentList')
    listEl.innerHTML = ''
    if (assignableAgents.length === 0) {
      listEl.innerHTML = '<p style="color:var(--text-muted);font-size:13px">Nincsenek hozzarendelheto agensek</p>'
    } else {
      for (const agent of assignableAgents) {
        const item = document.createElement('div')
        item.className = 'connector-agent-item'
        item.innerHTML = `
          <input type="checkbox" id="assign-${agent.name}" value="${agent.name}">
          <label for="assign-${agent.name}">${escapeHtml(agent.label || agent.name)}</label>
        `
        listEl.appendChild(item)
      }
    }
  } catch {
    document.getElementById('connectorAgentList').innerHTML = ''
  }

  // Delete button
  document.getElementById('connectorDeleteBtn').onclick = async () => {
    if (!confirm(`Biztosan torlod: ${connector.name}?`)) return
    try {
      await fetch(`/api/connectors/${encodeURIComponent(connector.name)}`, { method: 'DELETE' })
      closeModal(connectorDetailOverlay)
      showToast('Connector törölve')
      loadConnectors()
    } catch {
      showToast('Hiba a torles soran')
    }
  }

  // Assign button
  document.getElementById('connectorAssignBtn').onclick = async () => {
    const checked = [...document.querySelectorAll('#connectorAgentList input:checked')].map(i => i.value)
    if (checked.length === 0) { showToast('Válassz legalább egy ágenst'); return }
    try {
      await fetch(`/api/connectors/${encodeURIComponent(connector.name)}/assign`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agents: checked }),
      })
      showToast('Connector hozzarendelve')
    } catch {
      showToast('Hiba a hozzárendelés során')
    }
  }

  openModal(connectorDetailOverlay)
}

// Save new connector
document.getElementById('saveConnectorBtn').addEventListener('click', async () => {
  const name = document.getElementById('connectorName').value.trim()
  const type = document.getElementById('connectorType').value
  const scope = document.getElementById('connectorScope').value

  if (!name) { document.getElementById('connectorName').focus(); return }

  const data = { name, type, scope }
  if (type === 'remote') {
    data.url = document.getElementById('connectorUrl').value.trim()
    if (!data.url) { document.getElementById('connectorUrl').focus(); return }
  } else {
    data.command = document.getElementById('connectorCmd').value.trim()
    data.args = document.getElementById('connectorArgs').value.trim()
    if (!data.command) { document.getElementById('connectorCmd').focus(); return }
  }

  const btn = document.getElementById('saveConnectorBtn')
  btn.disabled = true
  btn.querySelector('.btn-text').hidden = true
  btn.querySelector('.btn-loading').hidden = false

  try {
    const res = await fetch('/api/connectors', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    })
    if (!res.ok) {
      const err = await res.json()
      throw new Error(err.error || 'Hiba')
    }
    closeModal(connectorModalOverlay)
    showToast('Connector hozzáadva!')
    loadConnectors()
  } catch (err) {
    showToast(`Hiba: ${err.message}`)
  } finally {
    btn.disabled = false
    btn.querySelector('.btn-text').hidden = false
    btn.querySelector('.btn-loading').hidden = true
  }
})

// === Helpers ===
function escapeHtml(str) {
  const d = document.createElement('div')
  d.textContent = str
  return d.innerHTML
}

// === Init ===
populateAvatarGrid()
loadMemAgents()
loadKanban()

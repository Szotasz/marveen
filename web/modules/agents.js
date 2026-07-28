// Agents view + channel management frontend (S-6, issue #3).
//
// Exports:
//   initAgents(opts)           -- inject DI callbacks from app.js
//   loadAgents()               -- fetch + render agent grid
//   startAgentsBusyPoll()      -- terminal-busy tint poller (page enter)
//   stopAgentsBusyPoll()       -- stop poller (page leave)
//   openMarveenDetail()        -- open main-agent detail modal
//   setAgentsView(view)        -- switch grid/tree, triggers DOM update
//   getAgentsActiveView()      -- current view name (for registerPage enter)
//   setAgentsActiveView(v)     -- set view without DOM (for alias callback)
//   getFederatedPeerStatus()   -- read access for Messages page
//   setFederatedPeerStatus(p)  -- updated by loadAgents + loadChatAgentList
//   federatedAgentEntries()    -- used by Messages page sidebar
//   avatarBust()               -- cache-buster query string for avatar URLs

import { escapeHtml, mainAgentId } from './util.js'
import { showToast } from './toast.js'
import { t, getLang } from './i18n.js'
import { switchPage } from './app-core.js'

// ─── Avatar cache-busting epoch ─────────────────────────────────────────────
// Owned here; bumpAvatarEpoch() called only from agents section.
// avatarBust() exported so app.js (skills, memories) uses the same epoch.
let _avatarEpoch = 0
function bumpAvatarEpoch() { _avatarEpoch = Date.now() }
export function avatarBust() { return _avatarEpoch ? `?t=${_avatarEpoch}` : '' }

// ─── Local utilities ─────────────────────────────────────────────────────────


// ─── DI callbacks (injected by initAgents) ───────────────────────────────────
let _openModal = null
let _closeModal = null
let _loadSkills = null
let _openTerminalModal = null
let _openConversationModal = null
let _setChatSelectedAgent = null
let _showSudoModal = null

export function initAgents({
  openModal, closeModal, loadSkills,
  openTerminalModal, openConversationModal, setChatSelectedAgent,
  showSudoModal,
} = {}) {
  _openModal = openModal
  _closeModal = closeModal
  _loadSkills = loadSkills
  _openTerminalModal = openTerminalModal
  _openConversationModal = openConversationModal
  _setChatSelectedAgent = setChatSelectedAgent
  _showSudoModal = showSudoModal
}

// ─── Federated peer status ────────────────────────────────────────────────────
// Populated by loadAgents() and by the Messages page loadChatAgentList().
// Messages page accesses it via the exported get/set below.
let federatedPeerStatus = []
export function getFederatedPeerStatus() { return federatedPeerStatus }
export function setFederatedPeerStatus(peers) { federatedPeerStatus = peers }

// ─── Agents page view state ───────────────────────────────────────────────────
let _agentsActiveView = 'grid'
export function getAgentsActiveView() { return _agentsActiveView }
// Set view name without triggering DOM update (used by team->agents alias).
export function setAgentsActiveView(v) { _agentsActiveView = v }

// === Elements: Agents ===
const agentsGrid = document.getElementById('agentsGrid')
const addBtn = document.getElementById('addAgentBtn')
const agentWizardOverlay = document.getElementById('agentWizardOverlay')
const agentDetailOverlay = document.getElementById('agentDetailOverlay')
const skillModalOverlay = document.getElementById('skillModalOverlay')
const agentName = document.getElementById('agentName')
const agentDesc = document.getElementById('agentDesc')
const agentModel = document.getElementById('agentModel')
// toast DOM ref moved to web/modules/toast.js (S-1 POC)

const AVATARS = [
  '01_robot.png', '02_wizard_girl.png', '03_knight.png', '04_ninja.png',
  '05_pirate.png', '06_scientist_girl.png', '07_astronaut.png', '08_viking.png',
  '09_cowgirl.png', '10_detective.png', '11_chef.png', '12_witch.png',
  '13_samurai.png', '14_fairy_girl.png', '15_firefighter.png', '16_punk_girl.png',
  '17_explorer.png', '18_dj.png', '19_princess.png', '20_alien.png'
]

let selectedAvatar = null
let selectedAvatarFile = null // custom upload chosen in the create wizard (deferred until the agent exists)
let agents = []
let currentAgent = null
// API-safe agent id for the currently open detail modal. Sub-agents key off
// their name; the main agent's detail object carries name:'marveen' for legacy
// UI checks but its real agent-dir id is agentId (MAIN_AGENT_ID, e.g.
// 'gorcsevivan') -- the /api/agents/<id>/skills endpoints need that real id.
export function agentApiName() {
  return currentAgent ? (currentAgent.agentId || currentAgent.name) : ''
}
let wizardStep = 1
let generatedClaudeMd = ''
let generatedSoulMd = ''
let wizardCreatedName = ''


// Wizard open
addBtn.addEventListener('click', () => {
  resetWizard()
  _openModal?.(agentWizardOverlay)
  setTimeout(() => agentName.focus(), 200)
})

// Close buttons
document.getElementById('wizardClose').addEventListener('click', () => _closeModal?.(agentWizardOverlay))
document.getElementById('agentDetailClose').addEventListener('click', () => _closeModal?.(agentDetailOverlay))
document.getElementById('skillModalClose').addEventListener('click', () => _closeModal?.(skillModalOverlay))

// Click-outside-to-close
agentWizardOverlay.addEventListener('click', (e) => { if (e.target === agentWizardOverlay) _closeModal?.(agentWizardOverlay) })
agentDetailOverlay.addEventListener('click', (e) => { if (e.target === agentDetailOverlay) _closeModal?.(agentDetailOverlay) })
skillModalOverlay.addEventListener('click', (e) => { if (e.target === skillModalOverlay) _closeModal?.(skillModalOverlay) })

// Close all modals on Escape
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    document.querySelectorAll('.modal-overlay.active').forEach((o) => _closeModal?.(o))
  }
})

// === Avatar Gallery ===
export function populateAvatarGrid() {
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
      // Gallery pick and custom upload are mutually exclusive.
      selectedAvatarFile = null
      resetCreateAvatarUpload()
    })
    grid.appendChild(item)
  }
}

// === Wizard logic ===
let cachedProfiles = null
async function loadProfiles() {
  if (cachedProfiles) return cachedProfiles
  try {
    const res = await fetch('/api/profiles')
    if (res.ok) cachedProfiles = await res.json()
  } catch {}
  return cachedProfiles || []
}

function populateProfileSelect(selectEl, descEl, selected) {
  loadProfiles().then((profiles) => {
    selectEl.innerHTML = ''
    for (const p of profiles) {
      const opt = document.createElement('option')
      opt.value = p.id
      const tag = p.permissionMode === 'strict' ? ` (${t('agents.strict_mode')})` : ''
      opt.textContent = `${p.label}${tag}`
      if (p.id === selected) opt.selected = true
      selectEl.appendChild(opt)
    }
    const updateDesc = () => {
      const p = profiles.find(x => x.id === selectEl.value)
      descEl.textContent = p ? p.description : ''
    }
    selectEl.onchange = updateDesc
    updateDesc()
  })
}

// Populate the per-agent Claude subscription plan dropdown from the named
// registry (/api/claude-plans). The empty value means "no named plan" -> the
// agent keeps its raw config-dir / host default. The description line shows the
// plan type + config dir and flags a Channels-forbidden plan so the operator
// sees the guardrail context before saving.
function populatePlanSelect(selectEl, descEl, selected) {
  if (!selectEl) return
  fetch('/api/claude-plans')
    .then(res => (res.ok ? res.json() : []))
    .catch(() => [])
    .then((plans) => {
      const known = plans.some(p => p.id === selected)
      const opts = [`<option value="">${escapeHtml(t('agents.settings.plan_default'))}</option>`]
      for (const p of plans) {
        opts.push(`<option value="${escapeHtml(p.id)}">${escapeHtml(p.label)}</option>`)
      }
      // Preserve an already-assigned plan id that is NOT in the loaded registry
      // (registry edited/renamed, OR /api/claude-plans transiently failed and
      // returned []). Without this the dropdown would resolve to '' and a save
      // would silently wipe the real assignment.
      if (selected && !known) {
        opts.push(`<option value="${escapeHtml(selected)}">${escapeHtml(selected)}${escapeHtml(t('agents.settings.plan_not_found_suffix'))}</option>`)
      }
      selectEl.innerHTML = opts.join('')
      selectEl.value = selected || ''
      const updateDesc = () => {
        if (!descEl) return
        const val = selectEl.value
        if (!val) {
          descEl.textContent = t('agents.settings.plan_default_desc')
          return
        }
        const p = plans.find(x => x.id === val)
        if (!p) {
          descEl.textContent = t('agents.settings.plan_unresolved_desc', { id: val })
          return
        }
        const warn = p.channelsAllowed ? '' : t('agents.settings.plan_no_channels')
        descEl.textContent = `${p.planType} · ${p.configDir}${warn}`
      }
      selectEl.onchange = updateDesc
      updateDesc()
    })
}

function resetWizard() {
  wizardStep = 1
  agentName.value = ''
  agentDesc.value = ''
  agentModel.value = 'inherit'
  loadAvailableModels()
  selectedAvatar = null
  selectedAvatarFile = null
  document.querySelectorAll('#avatarGrid .avatar-grid-item').forEach(i => i.classList.remove('selected'))
  resetCreateAvatarUpload()
  generatedClaudeMd = ''
  generatedSoulMd = ''
  wizardCreatedName = ''
  document.getElementById('wizardClaudeMd').value = ''
  document.getElementById('wizardSoulMd').value = ''
  populateProfileSelect(
    document.getElementById('agentProfile'),
    document.getElementById('agentProfileDesc'),
    'default',
  )
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
  statusEl.textContent = t('agents.claude_md_generating')

  try {
    // Create agent via API (returns generated content)
    const res = await fetch('/api/agents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name,
        description: desc,
        model: agentModel.value,
        profile: document.getElementById('agentProfile').value,
      }),
    })

    if (!res.ok) {
      const err = await res.json()
      throw new Error(err.error || 'Ismeretlen hiba')
    }

    const result = await res.json()
    // Backend sanitizes the name (lowercase ASCII, NFD-stripped accents).
    // Use the sanitized form for every follow-up request so accented input
    // like "étrendíró" still resolves to the real agent dir "etrendiro".
    const createdName = result.name || name
    wizardCreatedName = createdName
    statusEl.textContent = t('agents.soul_md_generating')

    // Fetch full agent details to get generated content
    const detailRes = await fetch(`/api/agents/${encodeURIComponent(createdName)}`)
    if (detailRes.ok) {
      const detail = await detailRes.json()
      generatedClaudeMd = detail.claudeMd || detail.content || ''
      generatedSoulMd = detail.soulMd || ''
    }

    statusEl.textContent = t('kanban.breakdown.running')

    // Apply the chosen avatar. Custom upload wins over a gallery pick; both go
    // to the same endpoint (FormData for a file, JSON for a gallery name).
    if (selectedAvatarFile) {
      const form = new FormData()
      form.append('avatar', selectedAvatarFile, selectedAvatarFile.name)
      await fetch(`/api/agents/${encodeURIComponent(createdName)}/avatar`, {
        method: 'POST',
        body: form,
      })
    } else if (selectedAvatar) {
      await fetch(`/api/agents/${encodeURIComponent(createdName)}/avatar`, {
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
  // Use the backend-sanitized name stored in wizardCreatedName, not the raw
  // input field -- accents in the input would miss the real agent dir.
  const name = wizardCreatedName || agentName.value.trim()
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

    _closeModal?.(agentWizardOverlay)
    showToast('Ugynok letrehozva. Kosd be a csatornat a parosatashoz.')
    await loadAgents()
    // Drop the operator straight into the Telegram tab of the new agent so
    // the pairing step is in front of them -- easy to miss otherwise.
    try {
      await openAgentDetail(name)
      switchAgentTab('channel')
    } catch { /* detail open failed, list refresh already happened */ }
  } catch (err) {
    showToast(`Hiba: ${err.message}`)
  } finally {
    createBtn.disabled = false
    createBtn.querySelector('.btn-text').hidden = false
    createBtn.querySelector('.btn-loading').hidden = true
  }
})

// showToast is imported from web/modules/toast.js (S-1 POC, issue #3)

// === Agents API ===
export async function loadAgents() {
  try {
    // The federation status fetch is deliberately failure-proof (.catch ->
    // null): it must NEVER take down the Agents page -- including on an
    // older backend where the route 404s.
    const [agentsRes, marveenRes, fedStatus] = await Promise.all([
      fetch('/api/agents'),
      fetch('/api/marveen'),
      fetch('/api/federation/status').then((r) => (r.ok ? r.json() : null)).catch(() => null),
    ])
    agents = await agentsRes.json()
    if (fedStatus && Array.isArray(fedStatus.peers)) federatedPeerStatus = fedStatus.peers
    if (marveenRes.ok) {
      window._marveen = await marveenRes.json()
      // A backend CHANNEL_PROVIDER-éhez igazitsuk a kliens-default-ot,
      // hogy ne 'telegram' jelenjen meg amikor a backend discord-on van.
      if (window._marveen?.channelProvider) {
        currentChannelProvider = window._marveen.channelProvider
        const sel = document.getElementById('chProviderSelect')
        if (sel) sel.value = currentChannelProvider
        if (typeof updateProviderUI === 'function') updateProviderUI()
      }
    }
    renderAgents()
  } catch (err) {
    console.error('Betöltés hiba:', err)
  }
}

// Format a context-token count for display (e.g. 699884 -> "≈700k token").
function formatContextTokens(n) {
  if (typeof n !== 'number' || !isFinite(n) || n <= 0) return '-'
  if (n < 1000) return `${n} token`
  const k = n / 1000
  return `≈${k < 10 ? k.toFixed(1) : Math.round(k)}k token`
}

// Populate the auto-restart controls + context display from an agent payload.
// Works for sub-agents (agent.name) and the main session (agent.autoRestartId).
function setupAutoRestartUI(agent) {
  const ctxEl = document.getElementById('agentDetailContext')
  if (ctxEl) ctxEl.textContent = formatContextTokens(agent && agent.contextTokens)

  const ar = (agent && agent.autoRestart) || { enabled: false, mode: 'continue', dailyTime: null, intervalHours: null }
  const enabled = document.getElementById('arEnabled')
  const mode = document.getElementById('arMode')
  const schedKind = document.getElementById('arSchedKind')
  const dailyWrap = document.getElementById('arDailyWrap')
  const dailyTime = document.getElementById('arDailyTime')
  const intervalWrap = document.getElementById('arIntervalWrap')
  const intervalHours = document.getElementById('arIntervalHours')
  if (!enabled || !mode || !schedKind) return

  enabled.checked = ar.enabled === true
  mode.value = ar.mode === 'fresh' ? 'fresh' : 'continue'
  if (ar.intervalHours) {
    schedKind.value = 'interval'
    intervalHours.value = ar.intervalHours
  } else {
    schedKind.value = 'daily'
    if (ar.dailyTime) dailyTime.value = ar.dailyTime
  }
  const syncSched = () => {
    const isInterval = schedKind.value === 'interval'
    intervalWrap.hidden = !isInterval
    dailyWrap.hidden = isInterval
  }
  syncSched()
  // Attach the show/hide listener once.
  if (schedKind.dataset.wired !== '1') {
    schedKind.addEventListener('change', syncSched)
    schedKind.dataset.wired = '1'
  }
}

export async function openMarveenDetail() {
  const m = window._marveen
  if (!m) return

  // Reuse the agent detail modal for Marveen
  currentAgent = { ...m, name: mainAgentId(), claudeMd: '', soulMd: '', mcpJson: '', skills: [] }
  setupAutoRestartUI(currentAgent)

  const displayName = m.name || 'Marveen'
  document.getElementById('agentDetailTitle').textContent = displayName
  const avatar = document.getElementById('agentDetailAvatar')
  avatar.className = 'detail-avatar gradient-1'
  avatar.innerHTML = `<img src="/api/marveen/avatar${avatarBust()}" alt="${escapeHtml(displayName)}">`
  document.getElementById('agentDetailName').textContent = displayName
  document.getElementById('agentDetailDesc').textContent = m.description || ''
  document.getElementById('agentDetailModel').textContent = m.model || '-'
  document.getElementById('agentDetailChStatus').innerHTML = `<span class="tg-status"><span class="tg-dot connected"></span>${t('agents.channel.connected')}</span>`
  // Populate the Skills tab for the main agent too: the endpoint returns the
  // global ~/.claude/skills under its real id (agentId), which every agent
  // inherits. Previously this was hard-set to '-' and loadSkills was never
  // called, so the main agent's Skills tab always looked empty.
  _loadSkills?.(agentApiName())

  // Process control for Marveen - always running, no start/stop
  document.getElementById('processDot').className = 'process-dot running'
  document.getElementById('processLabel').textContent = t('agents.status.running')
  document.getElementById('processUptime').textContent = `tmux: ${m.tmuxSession || '-'}`
  document.getElementById('agentStartBtn').hidden = true
  document.getElementById('agentStopBtn').hidden = true
  // Sync the settings tab model select with Marveen's actual model so it
  // doesn't carry over the previously opened sub-agent's selection.
  const marveenModelSelect = document.getElementById('editAgentModel')
  if (marveenModelSelect) {
    // The main agent's real model (e.g. 'claude-opus-4-8') may not match any
    // static option verbatim (the option is 'claude-opus-4-8[1m]'), so a plain
    // .value assignment finds no match and the select silently displays the
    // first option (Fable 5), misrepresenting what the agent actually runs.
    // Inject the real id as an option so the (read-only) select shows the truth
    // -- same trick as the sub-agent panel's dynamic-model-opt.
    const mv = m.activeModel || m.model || ''
    Array.from(marveenModelSelect.querySelectorAll('option.dynamic-model-opt')).forEach(o => o.remove())
    if (mv && !Array.from(marveenModelSelect.options).some(o => o.value === mv)) {
      const opt = document.createElement('option')
      opt.value = mv
      opt.className = 'dynamic-model-opt'
      opt.textContent = mv
      marveenModelSelect.appendChild(opt)
    }
    marveenModelSelect.value = mv
  }
  // Populate the model dropdown groups (auto/manual) AND surface the OpenRouter
  // curation button -- this is the main agent, the only place curation lives.
  loadAvailableModels()
  // Surface the "channels restart" button -- destructive, but mobile-safe
  // when the Telegram plugin wedges and you're away from a terminal.
  document.getElementById('marveenRestartBtn').hidden = false

  // Settings tab - load real CLAUDE.md / SOUL.md / .mcp.json (read-only).
  // Editing the main agent's identity files via the dashboard is intentionally
  // not allowed: a leaked dashboard token would otherwise let a remote user
  // rewrite the live agent's instructions. Edit via filesystem or by asking
  // Marveen on Telegram instead.
  let mFull = m
  try {
    const claudeRes = await fetch('/api/marveen')
    if (claudeRes.ok) {
      mFull = await claudeRes.json()
      document.getElementById('editClaudeMd').value = mFull.claudeMd || ''
      document.getElementById('editSoulMd').value = mFull.soulMd || ''
      document.getElementById('editMcpJson').value = mFull.mcpJson || ''
    }
  } catch {}
  applyMarveenReadonlyMode(true)

  // Telegram tab -- without this the tab stays in the default "not connected"
  // view even though the bot is running and receiving messages.
  updateChannelTab({
    name: mainAgentId(),
    hasTelegram: mFull.hasTelegram !== undefined ? mFull.hasTelegram : true,
    hasDiscord: mFull.hasDiscord,
    hasSlack: mFull.hasSlack,
    telegramBotUsername: mFull.telegramBotUsername,
    running: true,
  })

  // Delete button - hide for Marveen
  document.getElementById('deleteAgentBtn').style.display = 'none'

  document.getElementById('detailAvatarGallery').hidden = true
  switchAgentTab('overview')
  _openModal?.(agentDetailOverlay)
}

function applyMarveenReadonlyMode(readOnly) {
  const textareaIds = ['editClaudeMd', 'editSoulMd', 'editMcpJson']
  // saveModelBtn stays VISIBLE but disabled for Marveen, so the settings tab
  // doesn't look like the row is missing -- the other save buttons (tied to
  // readonly textareas) are hidden because the textareas are also hidden by
  // the readonly note flow.
  const hideButtonIds = ['saveClaudeMdBtn', 'saveSoulMdBtn', 'saveMcpJsonBtn', 'saveAuthModeBtn', 'saveMcpScopeBtn']
  const disableButtonIds = ['saveModelBtn']
  for (const id of textareaIds) {
    const el = document.getElementById(id)
    if (!el) continue
    if (readOnly) el.setAttribute('readonly', 'readonly')
    else el.removeAttribute('readonly')
  }
  const modelSelect = document.getElementById('editAgentModel')
  if (modelSelect) modelSelect.disabled = readOnly
  for (const id of hideButtonIds) {
    const btn = document.getElementById(id)
    if (btn) btn.hidden = readOnly
  }
  for (const id of disableButtonIds) {
    const btn = document.getElementById(id)
    if (btn) { btn.hidden = false; btn.disabled = readOnly }
  }
  const authModeGroup = document.getElementById('authModeGroup')
  if (authModeGroup) authModeGroup.hidden = readOnly
  const memoryIsolationGroup = document.getElementById('memoryIsolationGroup')
  if (memoryIsolationGroup) memoryIsolationGroup.hidden = readOnly
  const note = document.getElementById('marveenReadonlyNote')
  if (note) note.hidden = !readOnly
}


function getAvatarGradient(name) {
  const hash = name.split('').reduce((a, c) => a + c.charCodeAt(0), 0)
  return 'gradient-' + ((hash % 3) + 1)
}

// Tooltip text for the "Fut" / "Leállva" footer indicator (process state).
function processTip(isRunning) {
  return isRunning
    ? t('agents.running_tip')
    : t('agents.stopped_tip')
}

// Tooltip text for the "Online" / "Offline" footer indicator (channel state).
function channelTip(isConnected) {
  return isConnected
    ? t('agents.online_tip')
    : t('agents.offline_tip')
}

// Build the copy-paste tmux attach command for an agent live session. A local
// agent session runs on the orchestrator host (a direct `tmux attach`); a remote
// agent session runs on its configured remoteHost, reached over ssh. Only
// meaningful for running agents.
function tmuxAttachCommand(agent) {
  const session = agent.session || ('agent-' + agent.name)
  const direct = 'tmux attach -t ' + session
  const remoteHost = agent.remoteHost || null
  return remoteHost ? 'ssh ' + remoteHost + " -t '" + direct + "'" : direct
}

// Append a single "copy tmux attach command" button to a running agent card.
// Clicks copy to clipboard and never bubble to the card open-detail handler.
function attachTmuxCopyButtons(card, agent) {
  const cmd = tmuxAttachCommand(agent)
  const row = document.createElement('div')
  row.className = 'agent-tmux-cmds'
  const btn = document.createElement('button')
  btn.type = 'button'
  btn.className = 'tmux-copy-btn'
  btn.setAttribute('aria-label', t('agents.tmux_copy_aria'))
  btn.title = cmd
  btn.innerHTML = '<span class="tmux-copy-ico">⧉</span>tmux'
  btn.addEventListener('click', (e) => {
    e.stopPropagation()
    navigator.clipboard.writeText(cmd).then(() => {
      const orig = btn.innerHTML
      btn.classList.add('copied')
      btn.innerHTML = '<span class="tmux-copy-ico">✓</span>' + t('agents.tmux_copied')
      setTimeout(() => { btn.innerHTML = orig; btn.classList.remove('copied') }, 1400)
    }).catch(() => showToast(t('agents.tmux_copy_failed')))
  })
  row.appendChild(btn)
  card.appendChild(row)
}

function renderAgents() {
  agentsGrid.querySelectorAll('.agent-card:not(.add-card)').forEach((el) => el.remove())

  // Marveen card (always first)
  if (window._marveen) {
    const m = window._marveen
    const displayName = m.name || 'Marveen'
    // The model is no longer hardcoded: /api/marveen reports the configured
    // model (readActiveModelFromProjectDir). Mirror the sub-agent card, which
    // uses the model value as both the badge label and class. Fall back to
    // 'opus' only before /api/marveen has resolved (or on a legacy backend).
    const mainModelLabel = m.model || 'opus'
    const mainModelClass = m.model || 'opus'
    const mCard = document.createElement('div')
    mCard.className = 'agent-card marveen-card'
    mCard.innerHTML = `
      <div class="agent-card-top">
        <div class="agent-avatar gradient-1"><img src="/api/marveen/avatar${avatarBust()}" alt="${escapeHtml(displayName)}"></div>
        <div class="agent-card-info">
          <div class="agent-name">${escapeHtml(displayName)} <span class="marveen-badge">${t('agents.main_badge')}</span></div>
          <div class="agent-desc">${escapeHtml(m.description || '')}</div>
        </div>
      </div>
      <div class="agent-card-footer">
        <span class="agent-model-badge ${escapeHtml(mainModelClass)}">${escapeHtml(mainModelLabel)}</span>
        <span class="process-indicator" title="${t('agents.marveen_process_tip')}"><span class="process-dot running"></span>${t('agents.status.running')}</span>
        <span class="tg-status" title="${t('agents.marveen_channel_tip')}"><span class="tg-dot connected"></span>${t('agents.status.online')}</span>
      </div>
      <div class="agent-card-actions">
        <button class="btn-secondary btn-compact agent-conversation-btn" title="${t('agents.btn.conversation')}">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
          ${t('agents.btn.conversation')}
        </button>
        <button class="btn-secondary btn-compact agent-terminal-btn" title="Terminal">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>
          Terminal
        </button>
      </div>
    `
    mCard.querySelector('.agent-terminal-btn')?.addEventListener('click', (e) => {
      e.stopPropagation(); _openTerminalModal?.(mainAgentId())
    })
    mCard.querySelector('.agent-conversation-btn')?.addEventListener('click', (e) => {
      e.stopPropagation(); _openConversationModal?.(mainAgentId(), t('agents.marveen_boss'))
    })
    mCard.addEventListener('click', () => openMarveenDetail())
    agentsGrid.insertBefore(mCard, addBtn)
  }

  for (const agent of agents) {
    // agent.name is the sanitized id (API/filesystem); displayName keeps the
    // original accented/cased input the user typed.
    const label = agent.displayName || agent.name
    const card = document.createElement('div')
    card.className = 'agent-card'
    card.dataset.name = agent.name
    const initial = label.charAt(0).toUpperCase()
    const gradientClass = getAvatarGradient(agent.name)
    const avatarHtml = (agent.hasImage || agent.hasAvatar)
      ? `<img src="/api/agents/${encodeURIComponent(agent.name)}/avatar${avatarBust()}" alt="${escapeHtml(label)}">`
      : initial

    const modelClass = agent.model && agent.model !== 'inherit' ? agent.model : ''
    const modelLabel = agent.model || 'inherit'
    const chConnected = agentIsConnected(agent)
    const chDotClass = chConnected ? 'connected' : 'disconnected'
    const chLabel = chConnected ? t('agents.status.online') : t('agents.status.offline')
    const isRunning = agent.running || false
    const runDotClass = isRunning ? 'running' : 'stopped'
    const runLabel = isRunning ? t('agents.status.running') : t('agents.status.stopped')

    card.innerHTML = `
      <div class="agent-card-top">
        <div class="agent-avatar ${gradientClass}">${avatarHtml}</div>
        <div class="agent-card-info">
          <div class="agent-name">${escapeHtml(label)}</div>
          <div class="agent-desc">${escapeHtml(agent.description || '')}</div>
        </div>
      </div>
      <div class="agent-card-footer">
        <span class="agent-model-badge ${escapeHtml(modelClass)}">${escapeHtml(modelLabel)}</span>
        <span class="process-indicator" title="${escapeHtml(processTip(isRunning))}"><span class="process-dot ${runDotClass}"></span>${runLabel}</span>
        <span class="tg-status" title="${escapeHtml(channelTip(chConnected))}"><span class="tg-dot ${chDotClass}"></span>${chLabel}</span>
      </div>
      ${agent.needsReauth ? `
        <div class="agent-reauth-banner">
          <span class="agent-reauth-reason">${escapeHtml(agent.reauthReason || t('agents.reauth.reason'))}</span>
          <button class="btn-danger btn-compact agent-login-btn" data-phase="start">${t('agents.btn.login')}</button>
        </div>` : ''}
      <div class="agent-card-actions">
        <button class="btn-secondary btn-compact agent-conversation-btn" title="${t('agents.btn.conversation')}">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
          ${t('agents.btn.conversation')}
        </button>
        <button class="btn-secondary btn-compact agent-terminal-btn" title="Terminal">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>
          Terminal
        </button>
      </div>
    `
    // Login button handler (start → confirm flow)
    card.querySelectorAll('.agent-login-btn').forEach(btn => {
      btn.addEventListener('click', (e) => { e.stopPropagation(); handleAgentLogin(agent.name, btn) })
    })
    // Terminal button
    card.querySelector('.agent-terminal-btn')?.addEventListener('click', (e) => {
      e.stopPropagation(); _openTerminalModal?.(agent.name)
    })
    // Conversation (readable transcript) button
    card.querySelector('.agent-conversation-btn')?.addEventListener('click', (e) => {
      e.stopPropagation(); _openConversationModal?.(agent.name, label)
    })
    card.addEventListener('click', () => openAgentDetail(agent.name))
    // Only running agents have a live session to look at, so only they get the
    // copy-the-tmux-command buttons.
    if (isRunning) attachTmuxCopyButtons(card, agent)
    agentsGrid.insertBefore(card, addBtn)
  }
  renderFederatedAgentCards(agentsGrid, addBtn)
  // Re-apply the live busy tint right after a re-render (renderAgents rebuilds
  // the cards from scratch, dropping the class), so it never blinks off while
  // the page is open.
  if (agentsBusyTimer) refreshAgentTerminalBusy()
}

// === Agents: live "working" tint on Terminal buttons ===
// Reuse the Activity page's data source (/api/agents/activity, same 3s poll,
// same working/idle state derived from the tmux pane) to turn an agent card's
// Terminal button green while that agent is actively working, and clear it when
// it goes idle or stops. No new backend -- just a second consumer of the same
// endpoint. The main (Marveen) card matches on mainAgentId(); sub-agent cards
// match on their data-name.
let agentsBusyTimer = null
export function startAgentsBusyPoll() {
  refreshAgentTerminalBusy()
  if (agentsBusyTimer) clearInterval(agentsBusyTimer)
  agentsBusyTimer = setInterval(refreshAgentTerminalBusy, 3000)
}
export function stopAgentsBusyPoll() {
  if (agentsBusyTimer) { clearInterval(agentsBusyTimer); agentsBusyTimer = null }
}
async function refreshAgentTerminalBusy() {
  if (!agentsGrid) return
  let entries
  try {
    const res = await fetch('/api/agents/activity')
    if (!res.ok) return
    entries = await res.json()
  } catch { return }
  if (!Array.isArray(entries)) return
  const stateByName = new Map(entries.map((e) => [e.name, e.state]))
  const mainId = mainAgentId()
  agentsGrid.querySelectorAll('.agent-card:not(.add-card)').forEach((card) => {
    const btn = card.querySelector('.agent-terminal-btn')
    if (!btn) return
    const id = card.classList.contains('marveen-card') ? mainId : card.dataset.name
    const working = !!id && stateByName.get(id) === 'working'
    btn.classList.toggle('agent-terminal-btn--busy', working)
  })
}

// Federated (remote-system) agents from the manifest-poller cache. Kept in a
// SEPARATE array from `agents`: that global feeds the team editor and the
// create-wizard, where qualified ids would be selectable-and-invalid.
// "remote" already means SSH agents in this codebase -- these are FEDERATED.

// System/plumbing agent names never shown as message targets.
const FEDERATED_HIDDEN_AGENTS = new Set(['heartbeat', 'telegram-coordinator', 'channel-coordinator'])

export function federatedAgentEntries() {
  const out = []
  for (const peer of federatedPeerStatus) {
    const manifest = peer && peer.manifest
    if (!manifest || !Array.isArray(manifest.agents)) continue
    for (const a of manifest.agents) {
      if (!a || typeof a.id !== 'string' || FEDERATED_HIDDEN_AGENTS.has(a.id.split('/').pop())) continue
      out.push({ peer: peer.id, peerState: peer.state, qualified: `${peer.id}/${a.id}`, displayName: a.displayName || a.id, model: a.model || '' })
    }
  }
  return out
}

function renderFederatedAgentCards(agentsGrid, addBtn) {
  for (const fa of federatedAgentEntries()) {
    const card = document.createElement('div')
    card.className = 'agent-card federated-agent-card'
    const reachable = fa.peerState === 'ok'
    // SECURITY: every manifest-derived string is peer-controlled. Text nodes
    // go through escapeHtml; NOTHING peer-controlled may land in an attribute
    // (escapeHtml does not encode quotes). The model badge is a plain text
    // span WITHOUT a model-derived class.
    const gradientClass = 'gradient-' + ((fa.qualified.charCodeAt(0) % 3) + 1)
    card.innerHTML = `
      <div class="agent-card-top">
        <div class="agent-avatar ${gradientClass}">${escapeHtml(fa.displayName.charAt(0).toUpperCase())}</div>
        <div class="agent-card-info">
          <div class="agent-name">${escapeHtml(fa.displayName)} <span class="federated-badge">${t('federation.badge', { peer: fa.peer })}</span></div>
          <div class="agent-desc">${escapeHtml(fa.qualified)}</div>
        </div>
      </div>
      <div class="agent-card-footer">
        <span class="agent-model-badge">${escapeHtml(fa.model)}</span>
        <span class="tg-status"><span class="tg-dot ${reachable ? 'connected' : 'disconnected'}"></span> ${reachable ? t('federation.peer_state.ok') : t('federation.peer_state.' + (fa.peerState || 'unknown'))}</span>
      </div>
      <div class="agent-card-actions">
        <button class="btn-secondary btn-compact federated-message-btn">${t('federation.btn.message')}</button>
      </div>`
    card.querySelector('.federated-message-btn').addEventListener('click', (e) => {
      e.stopPropagation()
      openFederatedThread(fa.qualified)
    })
    agentsGrid.insertBefore(card, addBtn)
  }
}

function openFederatedThread(qualifiedId) {
  _setChatSelectedAgent?.(qualifiedId)
  if (location.hash === '#messages') switchPage('messages')
  else location.hash = 'messages'
}

// === Agent Detail ===
async function openAgentDetail(agentName) {
  if (agentName === mainAgentId()) {
    return openMarveenDetail()
  }

  try {
    const res = await fetch(`/api/agents/${encodeURIComponent(agentName)}`)
    if (!res.ok) throw new Error('Not found')
    currentAgent = await res.json()
  } catch (err) {
    showToast(t('agents.toast.load_failed'))
    return
  }

  const detailLabel = currentAgent.displayName || currentAgent.name

  // Title
  document.getElementById('agentDetailTitle').textContent = detailLabel

  // Overview tab
  const initial = detailLabel.charAt(0).toUpperCase()
  const gradientClass = getAvatarGradient(currentAgent.name)
  const avatar = document.getElementById('agentDetailAvatar')
  avatar.className = 'detail-avatar ' + gradientClass
  avatar.innerHTML = (currentAgent.hasImage || currentAgent.hasAvatar)
    ? `<img src="/api/agents/${encodeURIComponent(currentAgent.name)}/avatar" alt="${escapeHtml(detailLabel)}">`
    : initial
  document.getElementById('agentDetailName').textContent = detailLabel
  document.getElementById('agentDetailDesc').textContent = currentAgent.description || ''
  document.getElementById('agentDetailModel').textContent = currentAgent.activeModel || currentAgent.model || 'inherit'
  document.getElementById('agentDetailModelRestarting').hidden = true

  const chConnected = agentIsConnected(currentAgent)
  document.getElementById('agentDetailChStatus').innerHTML = `<span class="tg-status"><span class="tg-dot ${chConnected ? 'connected' : 'disconnected'}"></span>${chConnected ? t('agents.channel.connected') : t('agents.channel.disconnected')}</span>`

  // Settings tab - load Ollama + DeepSeek models then set value
  loadAvailableModels()
  loadOllamaModels().then(() => {
    const sel = document.getElementById('editAgentModel')
    const mv = currentAgent.activeModel || currentAgent.model || 'claude-opus-4-8[1m]'
    // The model <select> is one shared element reused per agent. A manual
    // OpenRouter id (or openrouter-auto:tier) may not be among the static/auto
    // options, so setting .value would silently show nothing. Inject THIS
    // agent's model as a selectable option (cleaning any stale injected ones
    // first) so every agent always displays its own model, per-agent.
    Array.from(sel.querySelectorAll('option.dynamic-model-opt')).forEach(o => o.remove())
    if (!Array.from(sel.options).some(o => o.value === mv)) {
      const opt = document.createElement('option')
      opt.value = mv
      opt.className = 'dynamic-model-opt'
      opt.textContent = mv.startsWith('openrouter-auto:') ? `🔀 ${mv}` : `🔀 ${mv}`
      sel.appendChild(opt)
    }
    sel.value = mv
  })
  populateProfileSelect(
    document.getElementById('editAgentProfile'),
    document.getElementById('editAgentProfileDesc'),
    currentAgent.securityProfile || 'default',
  )
  // The main agent's Claude login is managed via channels.sh, not the per-agent
  // config path, so plan selection does not apply to it. Hide the whole group.
  const planGroup = document.getElementById('claudePlanGroup')
  if (planGroup) planGroup.hidden = currentAgent.role === 'main'
  populatePlanSelect(
    document.getElementById('editAgentPlan'),
    document.getElementById('editAgentPlanDesc'),
    currentAgent.claudePlan || '',
  )
  renderTeamEditor(currentAgent, agents)
  updateAuthModeUI(currentAgent.authMode || 'shared', currentAgent.hasApiKey || false)
  const memIsoToggle = document.getElementById('memoryIsolationToggle')
  if (memIsoToggle) memIsoToggle.checked = currentAgent.memoryIsolation === true
  loadVoiceConfig(currentAgent.name)
  document.getElementById('editClaudeMd').value = currentAgent.claudeMd || currentAgent.content || ''
  document.getElementById('editSoulMd').value = currentAgent.soulMd || ''
  document.getElementById('editMcpJson').value = currentAgent.mcpJson || ''

  // Auto-restart settings + live context size
  setupAutoRestartUI(currentAgent)

  // Telegram tab
  updateChannelTab(currentAgent)

  // Skills tab
  await _loadSkills?.(currentAgent.name)

  // MCP scope tab -- wrapped so a render failure never blocks the modal
  try {
    await loadMcpScope(currentAgent)
  } catch (err) {
    console.error('MCP scope tab load failed:', err)
  }

  // Process control
  updateProcessControl(currentAgent)

  // Channels restart button is Marveen-only -- hide on normal agents.
  document.getElementById('marveenRestartBtn').hidden = true

  // Restore editable Settings (Marveen detail flips this to read-only).
  applyMarveenReadonlyMode(false)

  // Delete button (restore visibility for normal agents)
  document.getElementById('deleteAgentBtn').style.display = ''
  document.getElementById('deleteAgentBtn').onclick = async () => {
    if (!confirm(t('agents.confirm.delete', { name: currentAgent.name }))) return
    try {
      await fetch(`/api/agents/${encodeURIComponent(currentAgent.name)}`, { method: 'DELETE' })
      _closeModal?.(agentDetailOverlay)
      showToast(t('agents.toast.deleted'))
      loadAgents()
    } catch (err) {
      showToast(t('common.error_delete'))
    }
  }

  // Export button: download a portable .tar.gz bundle of this agent. Offers to
  // include channel tokens (off by default -- the safe-to-share variant).
  // The download goes through the auth-wrapped fetch (the global fetch shim
  // injects the Bearer header) and is turned into a Blob download, rather than
  // a plain navigation -- a window.location download cannot carry the
  // Authorization header and the API would 401 it.
  document.getElementById('exportAgentBtn').onclick = async () => {
    if (!currentAgent) return
    const withSecrets = confirm(
      'Belevegyük a titkokat (channel bot token, párosítási állapot)?\n\n' +
      'OK = igen, csak saját gépek közötti átvitelhez.\n' +
      'Mégse = nem, biztonságosan megosztható (csak identitás + viselkedés).'
    )
    const name = currentAgent.name
    const url = `/api/agents/${encodeURIComponent(name)}/export${withSecrets ? '?secrets=1' : ''}`
    try {
      const res = await fetch(url)
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        showToast(data.error || 'Hiba az exportálás során')
        return
      }
      const blob = await res.blob()
      const objectUrl = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = objectUrl
      a.download = `marveen-agent-${name}.tar.gz`
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(objectUrl)
      showToast(`Ügynök exportálva${withSecrets ? ' (titkokkal)' : ''}`)
    } catch {
      showToast('Hiba az exportálás során')
    }
  }

  // Reset to first tab, hide avatar gallery
  document.getElementById('detailAvatarGallery').hidden = true
  switchAgentTab('overview')
  _openModal?.(agentDetailOverlay)
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
        showToast(t('agents.toast.avatar_updated'))
        bumpAvatarEpoch()
        // Update the detail avatar display
        document.getElementById('agentDetailAvatar').innerHTML = `<img src="/api/agents/${encodeURIComponent(currentAgent.name)}/avatar${avatarBust()}" alt="">`
        document.getElementById('detailAvatarGallery').hidden = true
        loadAgents()
      } catch {
        showToast(t('agents.toast.avatar_error'))
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
          showToast(t('agents.toast.avatar_updated'))
          bumpAvatarEpoch()
          const imgUrl = isMarveen ? `/api/marveen/avatar${avatarBust()}` : `/api/agents/${encodeURIComponent(currentAgent.name)}/avatar${avatarBust()}`
          document.getElementById('agentDetailAvatar').innerHTML = `<img src="${imgUrl}" alt="">`
          gallery.hidden = true
          loadAgents()
        } catch {
          showToast(t('agents.toast.avatar_error'))
        }
      })
      grid.appendChild(item)
    }
  }
})

// === Avatar file upload ===
;(() => {
  const zone = document.getElementById('avatarUploadZone')
  const fileInput = document.getElementById('avatarFileInput')
  const content = document.getElementById('avatarUploadContent')
  const preview = document.getElementById('avatarUploadPreview')
  const previewImg = document.getElementById('avatarPreviewImg')
  const clearBtn = document.getElementById('avatarPreviewClear')
  const MAX_SIZE = 1024 * 1024

  zone.addEventListener('click', (e) => {
    if (e.target === clearBtn || clearBtn.contains(e.target)) return
    fileInput.click()
  })
  zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('drag-over') })
  zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'))
  zone.addEventListener('drop', (e) => {
    e.preventDefault()
    zone.classList.remove('drag-over')
    const file = e.dataTransfer.files[0]
    if (file) handleAvatarFile(file)
  })
  fileInput.addEventListener('change', () => {
    if (fileInput.files[0]) handleAvatarFile(fileInput.files[0])
  })
  clearBtn.addEventListener('click', (e) => {
    e.stopPropagation()
    resetAvatarUpload()
  })

  function resetAvatarUpload() {
    fileInput.value = ''
    content.hidden = false
    preview.hidden = true
  }

  async function handleAvatarFile(file) {
    if (!file.type.match(/^image\/(png|jpe?g|webp)$/)) {
      showToast(t('agents.toast.avatar_format'))
      return
    }
    if (file.size > MAX_SIZE) {
      showToast(t('agents.toast.avatar_size'))
      return
    }
    previewImg.src = URL.createObjectURL(file)
    content.hidden = true
    preview.hidden = false
    await uploadAvatarFile(file)
  }

  async function uploadAvatarFile(file) {
    if (!currentAgent) return
    const isMarveen = currentAgent.role === 'main'
    const endpoint = isMarveen ? '/api/marveen/avatar' : `/api/agents/${encodeURIComponent(currentAgent.name)}/avatar`
    const form = new FormData()
    form.append('avatar', file, file.name)
    try {
      const res = await fetch(endpoint, { method: 'POST', body: form })
      if (!res.ok) throw new Error()
      showToast(t('agents.toast.avatar_uploaded'))
      bumpAvatarEpoch()
      const imgUrl = isMarveen ? `/api/marveen/avatar${avatarBust()}` : `/api/agents/${encodeURIComponent(currentAgent.name)}/avatar${avatarBust()}`
      document.getElementById('agentDetailAvatar').innerHTML = `<img src="${imgUrl}" alt="">`
      document.getElementById('detailAvatarGallery').hidden = true
      resetAvatarUpload()
      loadAgents()
    } catch {
      showToast(t('common.error_save'))
      resetAvatarUpload()
    }
  }
})()

// === Create-wizard avatar upload ===
// Mirrors the detail-modal uploader, but the agent does not exist yet, so the
// file is held in `selectedAvatarFile` and POSTed after creation (see the
// wizard create flow). Hoisted so populateAvatarGrid()/resetWizard() can reset.
function resetCreateAvatarUpload() {
  const fileInput = document.getElementById('createAvatarFileInput')
  const content = document.getElementById('createAvatarUploadContent')
  const preview = document.getElementById('createAvatarUploadPreview')
  if (!fileInput || !content || !preview) return
  fileInput.value = ''
  content.hidden = false
  preview.hidden = true
}
;(() => {
  const zone = document.getElementById('createAvatarUploadZone')
  if (!zone) return
  const fileInput = document.getElementById('createAvatarFileInput')
  const content = document.getElementById('createAvatarUploadContent')
  const preview = document.getElementById('createAvatarUploadPreview')
  const previewImg = document.getElementById('createAvatarPreviewImg')
  const clearBtn = document.getElementById('createAvatarPreviewClear')
  const MAX_SIZE = 1024 * 1024

  zone.addEventListener('click', (e) => {
    if (e.target === clearBtn || clearBtn.contains(e.target)) return
    fileInput.click()
  })
  zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('drag-over') })
  zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'))
  zone.addEventListener('drop', (e) => {
    e.preventDefault()
    zone.classList.remove('drag-over')
    const file = e.dataTransfer.files[0]
    if (file) handleCreateAvatarFile(file)
  })
  fileInput.addEventListener('change', () => {
    if (fileInput.files[0]) handleCreateAvatarFile(fileInput.files[0])
  })
  clearBtn.addEventListener('click', (e) => {
    e.stopPropagation()
    selectedAvatarFile = null
    resetCreateAvatarUpload()
  })

  function handleCreateAvatarFile(file) {
    if (!file.type.match(/^image\/(png|jpe?g|webp)$/)) {
      showToast(t('agents.toast.avatar_format'))
      return
    }
    if (file.size > MAX_SIZE) {
      showToast(t('agents.toast.avatar_size'))
      return
    }
    // Custom upload and gallery pick are mutually exclusive.
    selectedAvatar = null
    document.querySelectorAll('#avatarGrid .avatar-grid-item').forEach(i => i.classList.remove('selected'))
    selectedAvatarFile = file
    previewImg.src = URL.createObjectURL(file)
    content.hidden = true
    preview.hidden = false
  }
})()

// === Process control ===
function updateProcessControl(agent) {
  const running = agent.running || false
  const dot = document.getElementById('processDot')
  const label = document.getElementById('processLabel')
  const uptime = document.getElementById('processUptime')
  const startBtn = document.getElementById('agentStartBtn')
  const stopBtn = document.getElementById('agentStopBtn')

  dot.className = 'process-dot ' + (running ? 'running' : 'stopped')
  label.textContent = running ? t('agents.status.running') : t('agents.status.stopped')
  startBtn.hidden = running
  stopBtn.hidden = !running

  if (running && agent.session) {
    uptime.textContent = `tmux: ${agent.session}`
  } else {
    uptime.textContent = ''
  }
}

document.getElementById('marveenRestartBtn').addEventListener('click', async () => {
  if (!confirm(t('agents.confirm.hard_restart'))) return
  const btn = document.getElementById('marveenRestartBtn')
  btn.disabled = true
  try {
    const res = await fetch('/api/marveen/restart', { method: 'POST' })
    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      throw new Error(err.error || t('agents.toast.restart_failed'))
    }
    showToast(t('agents.toast.marveen_restarted'))
  } catch (err) {
    showToast(`Hiba: ${err.message}`)
  } finally {
    btn.disabled = false
  }
})

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
      throw new Error(err.error || t('agents.toast.start_failed'))
    }
    showToast(t('agents.toast.started'))
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
  if (!confirm(t('agents.confirm.stop'))) return

  try {
    const res = await fetch(`/api/agents/${encodeURIComponent(currentAgent.name)}/stop`, { method: 'POST' })
    if (!res.ok) {
      const err = await res.json()
      throw new Error(err.error || t('agents.toast.stop_failed'))
    }
    showToast(t('agents.toast.stopped'))
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

let currentChannelProvider = 'telegram'
// Az induláskor a backend CHANNEL_PROVIDER-jét lekérjük, és a dropdown +
// state default-ot ahhoz igazitjuk -- igy ha a backend discord-on van,
// a UI nem hardcode-olt 'telegram'-mal indul barmelyik oldalra is navigal a user.
;(async function initChannelProviderDefault() {
  try {
    const res = await fetch('/api/marveen')
    if (!res.ok) return
    const data = await res.json()
    if (!data.channelProvider || data.channelProvider === currentChannelProvider) return
    currentChannelProvider = data.channelProvider
    const sel = document.getElementById('chProviderSelect')
    if (sel) sel.value = currentChannelProvider
    if (typeof updateProviderUI === 'function') updateProviderUI()
  } catch { /* ignore -- a kepernyo default-on marad */ }
})()
let channelAutoPollTimer = null
function startChannelAutoPoll() {
  if (channelAutoPollTimer) return
  channelAutoPollTimer = setInterval(() => {
    if (!currentAgent) return
    if (document.getElementById('tabChannel').hidden) return
    refreshPendingPairings()
    refreshAllowedList()
    refreshInvites()
    refreshChannelRequests()
  }, 4000)
}
function stopChannelAutoPoll() {
  if (channelAutoPollTimer) { clearInterval(channelAutoPollTimer); channelAutoPollTimer = null }
}

function channelApiBase() {
  return `/api/agents/${encodeURIComponent(currentAgent.name)}/channels/${currentChannelProvider}`
}

function switchAgentTab(tab) {
  document.querySelectorAll('#agentTabNav .tab-btn').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab))
  document.getElementById('tabOverview').hidden = tab !== 'overview'
  document.getElementById('tabSettings').hidden = tab !== 'settings'
  document.getElementById('tabChannel').hidden = tab !== 'channel'
  document.getElementById('tabSkills').hidden = tab !== 'skills'
  document.getElementById('tabTeam').hidden = tab !== 'team'
  document.getElementById('tabMcpScope').hidden = tab !== 'mcp-scope'
  if (tab === 'channel') startChannelAutoPoll()
  else stopChannelAutoPoll()
}

// === Settings save buttons ===
async function loadOllamaModels() {
  const group = document.getElementById('ollamaModelGroup')
  if (!group) return
  group.innerHTML = ''
  try {
    const res = await fetch('/api/ollama/models')
    const models = await res.json()
    for (const m of models) {
      const opt = document.createElement('option')
      opt.value = m.name
      opt.textContent = `${m.name} (${m.size})`
      group.appendChild(opt)
    }
  } catch { /* Ollama not available */ }
}

// Populates the DeepSeek optgroups in both the wizard and the agent edit
// panel. Backend gates the list behind a vault entry, so an empty array
// here means the operator has not configured an API key yet -- in that
// case we hide the optgroup and surface a hint pointing to the Vault page.
export async function loadAvailableModels() {
  try {
    const res = await fetch('/api/models/available')
    if (!res.ok) return
    const data = await res.json()
    const deepseekModels = Array.isArray(data.deepseek) ? data.deepseek : []
    const editGroup = document.getElementById('deepseekModelGroup')
    const wizardGroup = document.getElementById('agentModelDeepseekGroup')
    const hint = document.getElementById('deepseekHint')
    for (const group of [editGroup, wizardGroup]) {
      if (!group) continue
      group.innerHTML = ''
      if (deepseekModels.length === 0) {
        group.style.display = 'none'
        continue
      }
      group.style.display = ''
      for (const m of deepseekModels) {
        const opt = document.createElement('option')
        opt.value = m.id
        opt.textContent = m.label
        group.appendChild(opt)
      }
    }
    if (hint) hint.style.display = deepseekModels.length === 0 ? 'block' : 'none'

    // OpenRouter: two optgroups per select (Auto = weekly-fresh tier
    // recommendation, value `openrouter-auto:<tier>`; Manual = the 2 concrete
    // ids per tier). Backend gates the whole block behind the vault key, so a
    // null payload means OpenRouter is not connected -> keep the groups hidden.
    const or = data.openrouter
    const orTiers = or && Array.isArray(or.tiers) ? or.tiers : []
    // Auto = one entry per tier in the dropdown (weekly-fresh recommendation).
    const autoGroups = [document.getElementById('openrouterAutoGroup'), document.getElementById('agentModelOpenrouterAutoGroup')]
    for (const g of autoGroups) {
      if (!g) continue
      g.innerHTML = ''
      if (orTiers.length === 0) { g.style.display = 'none'; continue }
      g.style.display = ''
      for (const t of orTiers) {
        const opt = document.createElement('option')
        opt.value = t.autoId
        opt.textContent = `${t.label} - auto (${t.auto})`
        g.appendChild(opt)
      }
    }
    // Manual = the user-curated list -> "OpenRouter - kézi" optgroup in every
    // select. Curated once (main agent's browse popup, checkboxes); assignable
    // per agent here. Empty list -> group hidden.
    const orManual = Array.isArray(data.openrouterManual) ? data.openrouterManual : []
    openrouterCurated = new Set(orManual.map(m => m.id))
    const manualGroups = [document.getElementById('openrouterManualGroup'), document.getElementById('agentModelOpenrouterManualGroup')]
    for (const g of manualGroups) {
      if (!g) continue
      g.innerHTML = ''
      if (orManual.length === 0) { g.style.display = 'none'; continue }
      g.style.display = ''
      for (const m of orManual) {
        const opt = document.createElement('option')
        opt.value = m.id
        opt.textContent = `🔀 ${m.name || m.id}`
        g.appendChild(opt)
      }
    }
    // Browse popup = the curation UI (tick/untick which manual models exist).
    // MAIN AGENT ONLY -- sub-agents just pick from the curated dropdown above.
    // Keep the name checks for compatibility with legacy /api/marveen payloads
    // that predate the explicit role field.
    const mid = (typeof mainAgentId === 'function') ? mainAgentId() : ''
    const isMainAgent = !!currentAgent && (
      currentAgent.role === 'main' ||
      currentAgent.name === mid ||
      currentAgent.agentId === mid
    )
    const orBtn = document.getElementById('openrouterBrowseBtn')
    if (orBtn) orBtn.style.display = (data.openrouterConfigured && isMainAgent) ? '' : 'none'
  } catch { /* dashboard not available */ }
}

// --- OpenRouter manual-list curation (tick models into the shared dropdown) ---
let openrouterAllModels = null
let openrouterCurated = new Set()  // ids currently in the curated manual list

async function openOpenrouterModal() {
  const modal = document.getElementById('openrouterModal')
  const listEl = document.getElementById('openrouterModalList')
  const agentEl = document.getElementById('openrouterModalAgent')
  const searchEl = document.getElementById('openrouterModalSearch')
  const freeEl = document.getElementById('openrouterModalFreeOnly')
  if (!modal || !listEl) return
  // The modal markup lives inside the (hidden) connectors page; reparent it to
  // <body> so it renders full-viewport regardless of which tab is active.
  if (modal.parentElement !== document.body) document.body.appendChild(modal)
  if (agentEl) agentEl.textContent = (currentAgent && (currentAgent.displayName || currentAgent.name)) || 'ágens'
  // Two competing .modal-overlay CSS rules: one hides via [hidden], the other
  // via opacity/visibility (toggled by .active). Set both so the modal shows
  // regardless of which rule wins the cascade.
  modal.hidden = false
  modal.classList.add('active')
  listEl.innerHTML = '<div style="padding:14px;color:var(--text-muted);font-size:13px">Modellek betöltése…</div>'
  if (searchEl) searchEl.value = ''
  if (freeEl) freeEl.checked = false
  try {
    // Load the full model list (cached) and the current curated set in parallel
    // so the checkboxes render already ticked for the manual models in the list.
    const [allRes, curRes] = await Promise.all([
      openrouterAllModels ? Promise.resolve(null) : fetch('/api/openrouter/models'),
      fetch('/api/openrouter/manual'),
    ])
    if (allRes) {
      if (!allRes.ok) throw new Error('fetch failed')
      const data = await allRes.json()
      openrouterAllModels = Array.isArray(data.models) ? data.models : []
    }
    if (curRes && curRes.ok) {
      const cur = await curRes.json()
      openrouterCurated = new Set((Array.isArray(cur.models) ? cur.models : []).map(m => m.id))
    }
    renderOpenrouterList()
  } catch {
    listEl.innerHTML = '<div style="padding:14px;color:var(--danger,#dc2626);font-size:13px">Nem sikerült betölteni az OpenRouter modelleket.</div>'
  }
}

function renderOpenrouterList() {
  const listEl = document.getElementById('openrouterModalList')
  const countEl = document.getElementById('openrouterModalCount')
  const q = (document.getElementById('openrouterModalSearch')?.value || '').toLowerCase().trim()
  const freeOnly = !!document.getElementById('openrouterModalFreeOnly')?.checked
  if (!listEl || !openrouterAllModels) return
  const rows = openrouterAllModels.filter(m => {
    if (freeOnly && !m.free) return false
    if (!q) return true
    return (m.id + ' ' + m.name).toLowerCase().includes(q)
  })
  // Ticked (curated) models float to the top so the current selection is visible.
  rows.sort((a, b) => {
    const ca = openrouterCurated.has(a.id), cb = openrouterCurated.has(b.id)
    if (ca !== cb) return ca ? -1 : 1
    return a.id.localeCompare(b.id)
  })
  if (countEl) countEl.textContent = `${rows.length} modell · ${openrouterCurated.size} kézi listán`
  listEl.innerHTML = ''
  for (const m of rows.slice(0, 400)) {
    const checked = openrouterCurated.has(m.id)
    const row = document.createElement('label')
    row.className = 'openrouter-model-row'
    row.style.cssText = 'display:flex;align-items:flex-start;gap:10px;padding:8px 10px;border-bottom:1px solid var(--border);cursor:pointer;font-size:13px'
    const price = m.free ? '<span style="color:var(--success,#16a34a);font-weight:600">ingyenes</span>'
      : `$${m.promptPrice.toFixed(2)}/$${m.completionPrice.toFixed(2)} /M`
    const ctx = m.contextLength ? ` · ${Math.round(m.contextLength / 1000)}k ctx` : ''
    const cb = document.createElement('input')
    cb.type = 'checkbox'
    cb.checked = checked
    cb.style.cssText = 'margin-top:3px;flex:0 0 auto'
    cb.addEventListener('change', () => toggleCuratedModel(m.id, m.name, cb.checked))
    const info = document.createElement('div')
    info.style.cssText = 'flex:1 1 auto;min-width:0'
    info.innerHTML = `<div style="font-weight:600">${escapeHtml(m.name)}</div>`
      + `<div style="color:var(--text-muted);font-size:11.5px"><code>${escapeHtml(m.id)}</code> · ${price}${ctx}</div>`
    row.appendChild(cb)
    row.appendChild(info)
    row.addEventListener('mouseenter', () => { row.style.background = 'var(--surface-hover, #f1f5f9)' })
    row.addEventListener('mouseleave', () => { row.style.background = '' })
    listEl.appendChild(row)
  }
  if (rows.length === 0) listEl.innerHTML = '<div style="padding:14px;color:var(--text-muted);font-size:13px">Nincs találat.</div>'
}

// Tick/untick a model into the curated manual list. Persists server-side, then
// refreshes the shared dropdown so the "kézi" optgroup reflects the change.
async function toggleCuratedModel(id, name, checked) {
  // Optimistic local update so the checkbox + counter feel instant.
  if (checked) openrouterCurated.add(id); else openrouterCurated.delete(id)
  const countEl = document.getElementById('openrouterModalCount')
  if (countEl) {
    const total = countEl.textContent.split('·')[0].trim()
    countEl.textContent = `${total} · ${openrouterCurated.size} kézi listán`
  }
  try {
    const res = await fetch('/api/openrouter/manual', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, name, checked }),
    })
    if (!res.ok) throw new Error('save failed')
    const data = await res.json()
    openrouterCurated = new Set((Array.isArray(data.models) ? data.models : []).map(m => m.id))
    // Repopulate the dropdown "kézi" optgroups without disturbing selections.
    loadAvailableModels()
  } catch {
    // Roll back the optimistic change on failure.
    if (checked) openrouterCurated.delete(id); else openrouterCurated.add(id)
    renderOpenrouterList()
  }
}

function closeOpenrouterModal() {
  const modal = document.getElementById('openrouterModal')
  if (modal) { modal.hidden = true; modal.classList.remove('active') }
}

document.getElementById('openrouterBrowseBtn')?.addEventListener('click', openOpenrouterModal)
document.getElementById('openrouterModalClose')?.addEventListener('click', closeOpenrouterModal)
document.getElementById('openrouterModalCancel')?.addEventListener('click', closeOpenrouterModal)
document.getElementById('openrouterModalSearch')?.addEventListener('input', renderOpenrouterList)
document.getElementById('openrouterModalFreeOnly')?.addEventListener('change', renderOpenrouterList)

let modelRestartPollTimer = null
let modelRestartPollName = null

function stopModelRestartPolling() {
  if (modelRestartPollTimer) { clearInterval(modelRestartPollTimer); modelRestartPollTimer = null }
  modelRestartPollName = null
}

function startModelRestartPolling(name, expectedModel, triggeredAt) {
  stopModelRestartPolling()
  modelRestartPollName = name
  const badge = document.getElementById('agentDetailModelRestarting')
  const display = document.getElementById('agentDetailModel')
  const processLabel = document.getElementById('processLabel')
  const processDot = document.getElementById('processDot')
  const deadline = Date.now() + 60000
  modelRestartPollTimer = setInterval(async () => {
    if (modelRestartPollName !== name || !currentAgent || currentAgent.name !== name) {
      stopModelRestartPolling(); return
    }
    if (Date.now() > deadline) {
      stopModelRestartPolling()
      badge.hidden = true
      if (currentAgent) updateProcessControl(currentAgent)
      showToast(t('agents.toast.restart_state_error'))
      return
    }
    try {
      const r = await fetch(`/api/agents/${encodeURIComponent(name)}`)
      if (!r.ok) return
      const data = await r.json()
      // The new tmux session's creation timestamp is the reliable "restart
      // complete" signal. Claude Code writes the "model" field into the
      // session jsonl only when it answers a message, so activeModel may
      // stay null/old until the agent receives its first prompt -- waiting
      // for that match would time out on idle agents. The configured model
      // is what the agent was just started with via --model.
      const restarted = data.runningSince && data.runningSince >= triggeredAt
      if (restarted) {
        const displayModel = data.activeModel || data.model
        if (currentAgent && currentAgent.name === name) {
          currentAgent.activeModel = data.activeModel
          currentAgent.runningSince = data.runningSince
          currentAgent.model = data.model
          currentAgent.running = !!data.running
          currentAgent.session = data.session
          display.textContent = displayModel
        }
        badge.hidden = true
        processDot.className = 'process-dot running'
        processLabel.textContent = t('agents.status.running')
        stopModelRestartPolling()
        const liveMatched = data.activeModel === expectedModel
        showToast(liveMatched
          ? t('agents.model.toast_active', { model: displayModel })
          : t('agents.model.toast_restarted', { model: displayModel }))
      }
    } catch { /* network blip, keep polling */ }
  }, 2000)
}

document.getElementById('saveModelBtn').addEventListener('click', async () => {
  if (!currentAgent || currentAgent.role === 'main') return
  const newModel = document.getElementById('editAgentModel').value
  const name = currentAgent.name
  try {
    const res = await fetch(`/api/agents/${encodeURIComponent(name)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: newModel }),
    })
    if (!res.ok) throw new Error()
    currentAgent.model = newModel
    const triggeredAt = Math.floor(Date.now() / 1000)
    document.getElementById('agentDetailModelRestarting').hidden = false
    document.getElementById('processLabel').textContent = t('agents.process_label')
    document.getElementById('processDot').className = 'process-dot restarting'
    showToast(t('agents.toast.model_save_restart'))
    loadAgents()
    const restartRes = await fetch(`/api/agents/${encodeURIComponent(name)}/restart`, { method: 'POST' })
    if (!restartRes.ok) {
      document.getElementById('agentDetailModelRestarting').hidden = true
      if (currentAgent) updateProcessControl(currentAgent)
      showToast(t('agents.restart_failed'))
      return
    }
    startModelRestartPolling(name, newModel, triggeredAt)
  } catch { showToast(t('common.error_save')) }
})

document.getElementById('modelSuggestBtn').addEventListener('click', async () => {
  if (!currentAgent) return
  const resultDiv = document.getElementById('modelSuggestionResult')
  resultDiv.style.display = 'block'
  resultDiv.textContent = t('agents.model.analyzing')
  try {
    const res = await fetch('/api/agents/model-suggest', { method: 'POST' })
    if (!res.ok) throw new Error()
    const { results } = await res.json()
    const entry = results.find(r => r.agent === currentAgent.name)
    if (!entry) {
      resultDiv.textContent = t('agents.model.no_data')
      return
    }
    resultDiv.style.color = entry.changeAdvised ? 'var(--warning, #e6a817)' : 'var(--success)'
    resultDiv.style.whiteSpace = 'pre-wrap'
    resultDiv.style.fontFamily = 'monospace'
    resultDiv.style.fontSize = '12px'
    resultDiv.textContent = entry.reason
  } catch { resultDiv.textContent = t('agents.model.error') }
})

document.getElementById('analyzeAllModelsBtn').addEventListener('click', async () => {
  const panel = document.getElementById('agentsModelAnalysis')
  panel.style.display = 'block'
  panel.innerHTML = '<p style="color:var(--text-muted);font-size:13px">' + t('agents.model.analyzing_all') + '</p>'
  try {
    const res = await fetch('/api/agents/model-suggest', { method: 'POST' })
    if (!res.ok) throw new Error()
    const { results } = await res.json()
    const changes = results.filter(r => r.changeAdvised)
    const ok = results.filter(r => !r.changeAdvised)
    let html = '<div style="font-size:13px;padding:12px 14px;background:var(--surface-hover);border-radius:8px;border:1px solid var(--border)">'
    html += `<p style="margin:0 0 8px;font-weight:600">${t('agents.model.title', { n: results.length })}</p>`
    if (changes.length === 0) {
      html += '<p style="color:var(--success);margin:0">' + t('agents.model.all_ok') + '</p>'
    } else {
      html += `<p style="color:var(--warning, #e6a817);margin:0 0 8px">${t('agents.model.changes_n', { n: changes.length })}</p>`
      html += '<ul style="margin:0 0 10px;padding-left:18px">'
      for (const r of changes) {
        const safeReason = r.reason.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
        html += `<li style="margin-bottom:6px"><strong>${r.agent}</strong>: ${r.currentModel} &rarr; ${r.suggestedModel}`
        html += ` <details style="display:inline-block;vertical-align:top;margin-left:4px"><summary style="cursor:pointer;font-size:11px;color:var(--text-muted)">${t('agents.model.details')}</summary>`
        html += `<pre style="white-space:pre-wrap;font-size:11px;margin:4px 0 0;background:var(--surface);padding:6px 8px;border-radius:4px;color:var(--text-muted)">${safeReason}</pre></details></li>`
      }
      html += '</ul>'
      if (ok.length > 0) {
        html += `<p style="color:var(--text-muted);margin:0;font-size:12px">${t('agents.model.ok_agents', { list: ok.map(r => r.agent).join(', ') })}</p>`
      }
      html += `<button class="btn-secondary btn-compact" id="createModelChangeCardsBtn" style="margin-top:10px">${t('agents.model.create_cards_btn')}</button>`
    }
    html += '</div>'
    panel.innerHTML = html
    const createBtn = document.getElementById('createModelChangeCardsBtn')
    if (createBtn) {
      createBtn.addEventListener('click', async () => {
        if (!confirm(t('agents.model.cards_confirm', { n: changes.length }))) return
        createBtn.disabled = true
        createBtn.textContent = t('agents.model.creating_cards')
        let created = 0
        for (const r of changes) {
          try {
            await fetch('/api/kanban', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                title: t('agents.model.card_title', { agent: r.agent }),
                description: t('agents.model.card_desc', { current: r.currentModel, suggested: r.suggestedModel, reason: r.reason }),
                assignee: 'marveen',
                priority: 'normal',
                status: 'planned',
              }),
            })
            created++
          } catch { /* skip failed card */ }
        }
        showToast(t('agents.model.cards_created', { n: created }))
        createBtn.textContent = t('agents.model.cards_created', { n: created })
      })
    }
  } catch { panel.innerHTML = '<p style="color:var(--error);font-size:13px">' + t('agents.model.error') + '</p>' }
})

// === Export ALL agents (whole fleet) into one .tar.gz bundle ===
const exportAllAgentsBtn = document.getElementById('exportAllAgentsBtn')
if (exportAllAgentsBtn) {
  exportAllAgentsBtn.addEventListener('click', async () => {
    const withSecrets = confirm(
      'Belevegyük a titkokat (channel bot tokenek, párosítási állapot) MINDEN ügynöknél?\n\n' +
      'OK = igen, csak saját gépek közötti átvitelhez.\n' +
      'Mégse = nem, biztonságosan megosztható (csak identitás + viselkedés).'
    )
    const url = `/api/agents/export-all${withSecrets ? '?secrets=1' : ''}`
    try {
      const res = await fetch(url)
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        showToast(data.error || 'Hiba az exportálás során')
        return
      }
      const blob = await res.blob()
      const objectUrl = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = objectUrl
      a.download = 'marveen-fleet.tar.gz'
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(objectUrl)
      showToast(`Flotta exportálva${withSecrets ? ' (titkokkal)' : ''}`)
    } catch {
      showToast('Hiba az exportálás során')
    }
  })
}

// === Agent import (upload a .tar.gz bundle exported from another machine) ===
// Accepts both a single-agent bundle and a whole-fleet bundle -- the backend
// auto-detects the format from the manifest.
const importAgentBtn = document.getElementById('importAgentBtn')
const importAgentFile = document.getElementById('importAgentFile')
if (importAgentBtn && importAgentFile) {
  importAgentBtn.addEventListener('click', () => importAgentFile.click())
  importAgentFile.addEventListener('change', async () => {
    const file = importAgentFile.files && importAgentFile.files[0]
    if (!file) return
    // Reset the input so picking the same file again re-fires change.
    const upload = async (overwrite) => {
      const form = new FormData()
      form.append('file', file)
      if (overwrite) form.append('overwrite', '1')
      const res = await fetch('/api/agents/import', { method: 'POST', body: form })
      const data = await res.json().catch(() => ({}))
      return { res, data }
    }
    try {
      let { res, data } = await upload(false)
      if (res.status === 409) {
        const prompt = data.kind === 'fleet'
          ? 'Néhány ügynök már létezik ezen a gépen. Felülírjuk az ütközőket?'
          : `Már létezik "${data.name || ''}" nevű ügynök. Felülírjuk?`
        if (confirm(prompt)) {
          ;({ res, data } = await upload(true))
        } else {
          return
        }
      }
      if (!res.ok) { showToast(data.error || 'Hiba az importálás során'); return }
      const note = data.includedSecrets ? ' (titkokkal)' : ''
      if (data.kind === 'fleet') {
        const n = (data.imported || []).length
        const skipped = (data.skipped || []).length
        showToast(`Flotta importálva: ${n} ügynök${note}${skipped ? ` (${skipped} kihagyva)` : ''}`)
      } else {
        showToast(`Ügynök importálva: ${data.name}${note}${data.overwritten ? ' (felülírva)' : ''}`)
      }
      loadAgents()
    } catch {
      showToast('Hiba az importálás során')
    } finally {
      importAgentFile.value = ''
    }
  })
}

document.getElementById('saveAutoRestartBtn').addEventListener('click', async () => {
  if (!currentAgent) return
  // Auto-restart applies to the main session too, so (unlike model/profile) we
  // do NOT skip role === 'main'. The store key is autoRestartId for the main
  // session, the sanitized name for sub-agents.
  const id = currentAgent.autoRestartId || currentAgent.name
  const schedKind = document.getElementById('arSchedKind').value
  const cfg = {
    enabled: document.getElementById('arEnabled').checked,
    mode: document.getElementById('arMode').value === 'fresh' ? 'fresh' : 'continue',
    dailyTime: schedKind === 'daily' ? document.getElementById('arDailyTime').value : null,
    intervalHours: schedKind === 'interval' ? Number(document.getElementById('arIntervalHours').value) : null,
    handoff: false,
  }
  try {
    const res = await fetch(`/api/agents/${encodeURIComponent(id)}/auto-restart`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(cfg),
    })
    if (!res.ok) throw new Error()
    const body = await res.json()
    if (currentAgent) currentAgent.autoRestart = body.autoRestart
    showToast(t('agents.toast.auto_restart_saved'))
  } catch { showToast(t('common.error_save')) }
})

// ---- voice config UI -------------------------------------------------------

async function loadVoiceConfig(agentName) {
  const voiceModelSel = document.getElementById('editAgentVoiceModel')
  if (!voiceModelSel) return
  const banner = document.getElementById('voiceNotInstalledBanner')
  const controls = document.getElementById('voiceInstalledControls')
  try {
    // Check toolkit installation first
    const statusR = await fetch('/api/voice/status')
    if (!statusR.ok) return
    const status = await statusR.json()

    if (!status.installed) {
      if (banner) banner.hidden = false
      if (controls) controls.hidden = true
      return
    }
    if (banner) banner.hidden = true
    if (controls) controls.hidden = false

    const r = await fetch(`/api/agents/${encodeURIComponent(agentName)}/voice-config`)
    if (!r.ok) return
    const cfg = await r.json()
    voiceModelSel.innerHTML = (cfg.availableVoices || []).map(v =>
      `<option value="${v}"${v === cfg.voiceModel ? ' selected' : ''}>${v}</option>`
    ).join('')
    const modeInput = document.querySelector(`input[name="voiceResponseMode"][value="${cfg.responseMode || 'text'}"]`)
    if (modeInput) modeInput.checked = true
  } catch { /* silent */ }
}

let _voiceInstallPollTimer = null

document.getElementById('voiceInstallBtn').addEventListener('click', async () => {
  const btn = document.getElementById('voiceInstallBtn')
  const sudoHint = document.getElementById('voiceInstallSudoHint')
  const progress = document.getElementById('voiceInstallProgress')

  if (sudoHint) sudoHint.hidden = true
  btn.disabled = true
  btn.textContent = 'Indítás...'

  try {
    const r = await fetch('/api/voice/install', { method: 'POST' })
    if (!r.ok) throw new Error(await r.text())
    const data = await r.json()

    if (data.needsSudo) {
      // Show sudo command -- user must run it then click again
      if (sudoHint) {
        sudoHint.hidden = false
        sudoHint.innerHTML = 'A rendszercsomagok telepítéséhez futtasd terminálon:<br><code style="display:block;margin-top:4px;word-break:break-all">' + escapeHtml(data.sudoCommand) + '</code><br>Ezután kattints újra a Telepítés gombra.'
      }
      btn.disabled = false
      btn.textContent = 'Telepítés'
      return
    }

    if (data.alreadyInstalled) {
      if (currentAgent) loadVoiceConfig(currentAgent.name)
      return
    }

    // Install started -- poll /api/voice/status until installed=true.
    // Max 4 minutes (80 × 3s); on timeout show a hint and re-enable the button
    // so the user can retry (the only failure signal from a fire-and-forget spawn).
    if (progress) progress.hidden = false
    btn.textContent = 'Telepítés...'
    clearInterval(_voiceInstallPollTimer)
    let _voiceInstallPollCount = 0
    const VOICE_INSTALL_MAX_POLLS = 80 // 80 × 3s = 4 min
    _voiceInstallPollTimer = setInterval(async () => {
      _voiceInstallPollCount++
      try {
        const sr = await fetch('/api/voice/status')
        const s = await sr.json()
        if (s.installed) {
          clearInterval(_voiceInstallPollTimer)
          _voiceInstallPollTimer = null
          if (progress) progress.hidden = true
          if (currentAgent) loadVoiceConfig(currentAgent.name)
          return
        }
      } catch { /* keep polling */ }
      if (_voiceInstallPollCount >= VOICE_INSTALL_MAX_POLLS) {
        clearInterval(_voiceInstallPollTimer)
        _voiceInstallPollTimer = null
        if (progress) progress.hidden = true
        if (sudoHint) {
          sudoHint.hidden = false
          sudoHint.textContent = 'A telepítés tovább tart vagy elakadt. Ellenőrizd a dashboard logjait, majd próbáld újra.'
        }
        btn.disabled = false
        btn.textContent = 'Újrapróbálás'
      }
    }, 3000)
  } catch {
    btn.disabled = false
    btn.textContent = 'Telepítés'
    showToast('Hiba a telepítés során')
  }
})

document.getElementById('saveVoiceConfigBtn').addEventListener('click', async () => {
  if (!currentAgent) return
  const modeEl = document.querySelector('input[name="voiceResponseMode"]:checked')
  const modelEl = document.getElementById('editAgentVoiceModel')
  if (!modeEl || !modelEl) return
  try {
    const r = await fetch(`/api/agents/${encodeURIComponent(currentAgent.name)}/voice-config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ responseMode: modeEl.value, voiceModel: modelEl.value }),
    })
    if (!r.ok) throw new Error()
    showToast('Hangbeállítás mentve')
  } catch { showToast('Hiba a mentés során') }
})

document.getElementById('saveProfileBtn').addEventListener('click', async () => {
  if (!currentAgent || currentAgent.role === 'main') return
  const profile = document.getElementById('editAgentProfile').value
  try {
    const res = await fetch(`/api/agents/${encodeURIComponent(currentAgent.name)}/security`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profile }),
    })
    if (!res.ok) throw new Error()
    const body = await res.json()
    showToast(body.requiresRestart ? t('agents.toast.profile_saved_restart') : t('agents.toast.profile_saved'))
    loadAgents()
  } catch { showToast(t('agents.toast.profile_error')) }
})

document.getElementById('savePlanBtn').addEventListener('click', async () => {
  // The main agent's login comes up via channels.sh, not this path, so its
  // plan is not settable here (the selector is hidden for it anyway).
  if (!currentAgent || currentAgent.role === 'main') return
  const claudePlan = document.getElementById('editAgentPlan').value
  try {
    const res = await fetch(`/api/agents/${encodeURIComponent(currentAgent.name)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ claudePlan }),
    })
    if (!res.ok) throw new Error()
    currentAgent.claudePlan = claudePlan || null
    showToast(t('agents.toast.plan_saved'))
    loadAgents()
  } catch { showToast(t('agents.toast.plan_error')) }
})

// === Auth Mode ===
function selectAuthModeCard(mode) {
  document.querySelectorAll('.auth-mode-card').forEach(c => {
    const isSelected = c.dataset.mode === mode
    c.classList.toggle('selected', isSelected)
    c.querySelector('input[type="radio"]').checked = isSelected
  })
  document.getElementById('authModeSharedSection').hidden = mode !== 'shared'
  document.getElementById('authModeApiKeySection').hidden = mode !== 'api'
  document.getElementById('authModeOwnTeamSection').hidden = mode !== 'own_team'
  document.getElementById('authFlowResult').hidden = true
  document.getElementById('authFlowError').hidden = true
  document.getElementById('authSharedError').hidden = true
}

function updateAuthModeUI(mode, hasApiKey) {
  selectAuthModeCard(mode)
  const keyInput = document.getElementById('editAgentApiKey')
  keyInput.value = ''
  if (mode === 'api') {
    const statusEl = document.getElementById('authModeApiKeyStatus')
    statusEl.textContent = hasApiKey ? t('agents.api_key.ok') : t('agents.api_key.missing')
    statusEl.style.color = hasApiKey ? 'var(--success)' : 'var(--warning)'
  }
}

document.querySelectorAll('.auth-mode-card').forEach(card => {
  card.addEventListener('click', () => {
    selectAuthModeCard(card.dataset.mode)
  })
})

document.getElementById('authSharedApplyBtn').addEventListener('click', async () => {
  if (!currentAgent) return
  const btn = document.getElementById('authSharedApplyBtn')
  const btnText = btn.querySelector('.btn-text')
  const btnLoading = btn.querySelector('.btn-loading')
  const errorDiv = document.getElementById('authSharedError')
  errorDiv.hidden = true
  btnText.hidden = true
  btnLoading.hidden = false
  btn.disabled = true
  try {
    const base = `/api/agents/${encodeURIComponent(currentAgent.name)}`
    const saveRes = await fetch(base, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ authMode: 'shared' }),
    })
    if (!saveRes.ok) throw new Error('Save failed')
    if (currentAgent.running) {
      await fetch(`${base}/stop`, { method: 'POST' })
      await new Promise(r => setTimeout(r, 2000))
      const startRes = await fetch(`${base}/start`, { method: 'POST' })
      const startData = await startRes.json()
      if (!startRes.ok) {
        errorDiv.textContent = startData.error || t('agents.error.restart')
        errorDiv.hidden = false
        return
      }
    }
    showToast(t('agents.toast.host_oauth_restart'))
    loadAgents()
    const detailRes = await fetch(base)
    if (detailRes.ok) {
      currentAgent = await detailRes.json()
      updateAuthModeUI(currentAgent.authMode || 'shared', currentAgent.hasApiKey || false)
      updateProcessControl(currentAgent)
    }
  } catch {
    errorDiv.textContent = t('agents.error.apply')
    errorDiv.hidden = false
  } finally {
    btnText.hidden = false
    btnLoading.hidden = true
    btn.disabled = false
  }
})

document.getElementById('authFlowInitBtn').addEventListener('click', async () => {
  if (!currentAgent) return
  const btn = document.getElementById('authFlowInitBtn')
  const btnText = btn.querySelector('.btn-text')
  const btnLoading = btn.querySelector('.btn-loading')
  const resultDiv = document.getElementById('authFlowResult')
  const errorDiv = document.getElementById('authFlowError')
  resultDiv.hidden = true
  errorDiv.hidden = true
  btnText.hidden = true
  btnLoading.hidden = false
  btn.disabled = true
  try {
    const res = await fetch(`/api/agents/${encodeURIComponent(currentAgent.name)}/auth/init`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    })
    const data = await res.json()
    if (data.ok && data.authUrl) {
      const urlEl = document.getElementById('authFlowUrl')
      urlEl.href = data.authUrl
      urlEl.textContent = data.authUrl
      resultDiv.hidden = false
    } else {
      errorDiv.textContent = data.error || 'Auth URL nem talalhato'
      errorDiv.hidden = false
    }
  } catch {
    errorDiv.textContent = t('agents.error.auth_network')
    errorDiv.hidden = false
  } finally {
    btnText.hidden = false
    btnLoading.hidden = true
    btn.disabled = false
  }
})

document.getElementById('authFlowCopyBtn').addEventListener('click', () => {
  const url = document.getElementById('authFlowUrl').textContent
  navigator.clipboard.writeText(url).then(() => showToast('URL masolva'))
})

document.getElementById('memoryIsolationToggle').addEventListener('change', async (e) => {
  if (!currentAgent || currentAgent.role === 'main') return
  const enabled = e.target.checked
  try {
    const res = await fetch(`/api/agents/${encodeURIComponent(currentAgent.name)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ memoryIsolation: enabled }),
    })
    if (!res.ok) throw new Error()
    currentAgent.memoryIsolation = enabled
    showToast(t(enabled ? 'agents.toast.memory_isolation_on' : 'agents.toast.memory_isolation_off'))
  } catch {
    e.target.checked = !enabled
    showToast(t('common.error_save'))
  }
})

document.getElementById('saveAuthModeBtn').addEventListener('click', async () => {
  if (!currentAgent || currentAgent.role === 'main') return
  const mode = document.querySelector('input[name="authMode"]:checked')?.value || 'shared'
  const payload = { authMode: mode }
  if (mode === 'api') {
    const key = document.getElementById('editAgentApiKey').value.trim()
    if (key) payload.apiKey = key
  }
  try {
    const res = await fetch(`/api/agents/${encodeURIComponent(currentAgent.name)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    if (!res.ok) throw new Error()
    showToast(t('agents.toast.auth_mode_saved'))
    loadAgents()
    const detailRes = await fetch(`/api/agents/${encodeURIComponent(currentAgent.name)}`)
    if (detailRes.ok) {
      const updated = await detailRes.json()
      currentAgent = updated
      updateAuthModeUI(updated.authMode || 'shared', updated.hasApiKey || false)
    }
  } catch { showToast(t('common.error_save')) }
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
    showToast(t('agents.claude_md_saved'))
  } catch { showToast(t('common.error_save')) }
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
    showToast(t('agents.soul_md_saved'))
  } catch { showToast(t('common.error_save')) }
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
  } catch { showToast(t('common.error_save')) }
})

// === MCP scope tab ===

// Read-only tool id prefixes -- used to auto-populate the "readonly" preset.
const MCP_READONLY_PREFIXES = ['list_', 'get_', 'search_', 'check_', 'find_', 'fetch_', 'read_', 'directory_tree']

function isMcpToolReadonly(toolId) {
  return MCP_READONLY_PREFIXES.some((p) => toolId.startsWith(p))
}

// Build the mcpScope object from the current UI state.
// Returns null when mode is "full" (unmanaged, no mcpScope field).
function buildMcpScopeValue() {
  const mode = document.querySelector('input[name="mcpScopeMode"]:checked')?.value || 'full'
  if (mode === 'full') return null

  const scope = {}
  const serverSections = document.querySelectorAll('#mcpScopeServerList .mcp-server-section')
  for (const section of serverSections) {
    const serverKey = section.dataset.server
    if (!serverKey) continue
    const allToggle = section.querySelector('.mcp-server-all-toggle')
    if (allToggle?.checked) {
      scope[serverKey] = '*'
      continue
    }
    const checked = [...section.querySelectorAll('.mcp-tool-cb:checked')].map((cb) => cb.value)
    // Custom tools entered via free-text input
    const customItems = [...section.querySelectorAll('.mcp-custom-tool-tag')].map((el) => el.dataset.tool)
    const allTools = [...new Set([...checked, ...customItems])].filter(Boolean)
    // null means server is explicitly blocked (empty whitelist under managed mode)
    scope[serverKey] = allTools.length > 0 ? allTools : null
  }
  return scope
}

// Render a single server section (accordion-style) inside #mcpScopeServerList.
function renderMcpServerSection(serverKey, catalogEntry, currentServerScope) {
  const tools = catalogEntry?.tools || []
  const isAllStar = currentServerScope === '*'
  const allowedSet = Array.isArray(currentServerScope) ? new Set(currentServerScope) : new Set()
  const isBlocked = !isAllStar && currentServerScope !== undefined && allowedSet.size === 0

  const section = document.createElement('div')
  section.className = 'mcp-server-section'
  section.dataset.server = serverKey

  const serverLabel = catalogEntry?.name || serverKey
  const icon = catalogEntry?.icon || ''

  section.innerHTML = `
    <div class="mcp-server-header">
      <span class="mcp-server-icon">${icon}</span>
      <strong class="mcp-server-name">${escapeHtml(serverLabel)}</strong>
      <label class="mcp-server-all-label">
        <input type="checkbox" class="mcp-server-all-toggle" ${isAllStar ? 'checked' : ''}>
        <span data-i18n="agents.mcp_scope.server_all_toggle">${t('agents.mcp_scope.server_all_toggle')}</span>
      </label>
      ${isBlocked ? `<span class="mcp-scope-blocked-badge">${t('agents.mcp_scope.server_blocked')}</span>` : ''}
    </div>
    <div class="mcp-tool-list" ${isAllStar ? 'style="display:none"' : ''}>
      ${tools.length === 0 ? renderCustomToolSection(serverKey, allowedSet) : ''}
    </div>
  `

  if (tools.length > 0) {
    const toolList = section.querySelector('.mcp-tool-list')
    for (const tool of tools) {
      const isChecked = isAllStar || allowedSet.has(tool.id)
      const row = document.createElement('label')
      row.className = 'mcp-tool-row'
      row.innerHTML = `
        <input type="checkbox" class="mcp-tool-cb" value="${escapeHtml(tool.id)}" ${isChecked ? 'checked' : ''}>
        <span class="mcp-tool-label">${escapeHtml(tool.label)}</span>
        <code class="mcp-tool-id">${escapeHtml(tool.id)}</code>
        ${tool.dangerous ? `<span class="mcp-tool-danger-badge">${t('agents.mcp_scope.dangerous_badge')}</span>` : ''}
      `
      toolList.appendChild(row)
    }
    // Custom tool input for tools not in catalog
    const customSection = document.createElement('div')
    customSection.innerHTML = renderCustomToolSection(serverKey, allowedSet, tools.map((t) => t.id))
    toolList.appendChild(customSection)
  }

  // "All tools" toggle hides/shows the checkbox list
  const allToggle = section.querySelector('.mcp-server-all-toggle')
  const toolListEl = section.querySelector('.mcp-tool-list')
  allToggle.addEventListener('change', () => {
    toolListEl.style.display = allToggle.checked ? 'none' : ''
    if (!allToggle.checked) {
      section.querySelector('.mcp-scope-blocked-badge')?.remove()
    }
  })

  return section
}

// Render the free-text custom tool input row for servers without a tool catalog.
function renderCustomToolSection(serverKey, existingCustomSet, catalogToolIds = []) {
  const customTools = [...existingCustomSet].filter((id) => !catalogToolIds.includes(id))
  const tags = customTools.map((id) =>
    `<span class="mcp-custom-tool-tag" data-tool="${escapeHtml(id)}">${escapeHtml(id)}<button class="mcp-custom-tool-remove" data-tool="${escapeHtml(id)}">&times;</button></span>`
  ).join('')
  return `
    <div class="mcp-custom-tool-row">
      <div class="mcp-custom-tool-tags" id="customTags_${escapeHtml(serverKey)}">${tags}</div>
      <div class="mcp-custom-tool-input-row">
        <input type="text" class="mcp-custom-tool-input" placeholder="${t('agents.mcp_scope.unknown_server_hint')}">
        <button type="button" class="btn-compact btn-secondary mcp-custom-tool-add">${t('agents.mcp_scope.add_custom_tool')}</button>
      </div>
    </div>
  `
}

function wireCustomToolInputs(container) {
  container.querySelectorAll('.mcp-custom-tool-add').forEach((btn) => {
    btn.addEventListener('click', () => {
      const row = btn.closest('.mcp-custom-tool-row')
      const input = row.querySelector('.mcp-custom-tool-input')
      const toolId = input.value.trim()
      if (!toolId) return
      const serverKey = btn.closest('.mcp-server-section')?.dataset.server || ''
      const tagsEl = row.querySelector('.mcp-custom-tool-tags') || document.getElementById(`customTags_${serverKey}`)
      if (!tagsEl) return
      const tag = document.createElement('span')
      tag.className = 'mcp-custom-tool-tag'
      tag.dataset.tool = toolId
      tag.innerHTML = `${escapeHtml(toolId)}<button class="mcp-custom-tool-remove" data-tool="${escapeHtml(toolId)}">&times;</button>`
      tag.querySelector('.mcp-custom-tool-remove').addEventListener('click', () => tag.remove())
      tagsEl.appendChild(tag)
      input.value = ''
    })
  })
  container.querySelectorAll('.mcp-custom-tool-remove').forEach((btn) => {
    btn.addEventListener('click', () => btn.closest('.mcp-custom-tool-tag')?.remove())
  })
}

let _mcpCatalogCache = null
async function fetchMcpCatalog() {
  if (_mcpCatalogCache) return _mcpCatalogCache
  try {
    const res = await fetch('/api/mcp-catalog')
    if (res.ok) _mcpCatalogCache = await res.json()
  } catch { /* offline -- proceed without catalog */ }
  return _mcpCatalogCache || []
}

async function loadMcpScope(agent) {
  const serverListEl = document.getElementById('mcpScopeServerList')
  const noServersEl = document.getElementById('mcpScopeNoServers')
  const unmanagedHint = document.getElementById('mcpScopeUnmanagedHint')
  if (!serverListEl) return

  serverListEl.innerHTML = ''

  // Parse .mcp.json to get configured server keys
  let mcpJson = {}
  try { mcpJson = JSON.parse(agent.mcpJson || '{}') } catch { /* ignore */ }
  const serverKeys = Object.keys(mcpJson.mcpServers || {})

  if (serverKeys.length === 0) {
    if (noServersEl) noServersEl.style.display = ''
    serverListEl.style.display = 'none'
    return
  }
  if (noServersEl) noServersEl.style.display = 'none'

  // Current mcpScope from agent config
  const currentScope = agent.mcpScope || null

  // Preset mode
  let mode = 'full'
  if (currentScope !== null && currentScope !== undefined) {
    // Check if all servers are set to readonly-only tools
    const allReadonly = serverKeys.every((key) => {
      const s = currentScope[key]
      return Array.isArray(s) && s.every(isMcpToolReadonly)
    })
    mode = allReadonly ? 'readonly' : 'custom'
  }
  const modeInput = document.querySelector(`input[name="mcpScopeMode"][value="${mode}"]`)
  if (modeInput) modeInput.checked = true
  if (unmanagedHint) unmanagedHint.style.display = mode === 'full' ? '' : 'none'
  serverListEl.style.display = mode === 'custom' ? '' : 'none'

  // Wire preset radio buttons
  document.querySelectorAll('input[name="mcpScopeMode"]').forEach((radio) => {
    radio.addEventListener('change', () => {
      const m = document.querySelector('input[name="mcpScopeMode"]:checked')?.value
      serverListEl.style.display = m === 'custom' ? '' : 'none'
      if (unmanagedHint) unmanagedHint.style.display = m === 'full' ? '' : 'none'
    })
  })

  const catalog = await fetchMcpCatalog()
  const catalogMap = {}
  for (const entry of catalog) catalogMap[entry.id] = entry

  for (const serverKey of serverKeys) {
    // Match server key to catalog: try exact id match or prefix match
    try {
      const catalogEntry = catalogMap[serverKey] ||
        Object.values(catalogMap).find((e) => serverKey.startsWith(e.id))
      const serverScope = currentScope ? currentScope[serverKey] : undefined
      const section = renderMcpServerSection(serverKey, catalogEntry, serverScope)
      serverListEl.appendChild(section)
    } catch (err) {
      console.error(`MCP scope: failed to render server "${serverKey}":`, err)
    }
  }

  try {
    wireCustomToolInputs(serverListEl)
  } catch (err) {
    console.error('MCP scope: wireCustomToolInputs failed:', err)
  }
}

document.getElementById('saveMcpScopeBtn').addEventListener('click', async () => {
  if (!currentAgent) return
  const mode = document.querySelector('input[name="mcpScopeMode"]:checked')?.value || 'full'

  let scopeValue = null
  if (mode === 'readonly') {
    // Auto-build readonly scope: only list/get/search tools from catalog per server
    let mcpJson = {}
    try { mcpJson = JSON.parse(currentAgent.mcpJson || '{}') } catch { /* ignore */ }
    const serverKeys = Object.keys(mcpJson.mcpServers || {})
    const catalog = await fetchMcpCatalog()
    const catalogMap = {}
    for (const entry of catalog) catalogMap[entry.id] = entry
    scopeValue = {}
    for (const serverKey of serverKeys) {
      const catalogEntry = catalogMap[serverKey] ||
        Object.values(catalogMap).find((e) => serverKey.startsWith(e.id))
      if (catalogEntry?.tools) {
        const readonlyTools = catalogEntry.tools.filter((t) => isMcpToolReadonly(t.id)).map((t) => t.id)
        scopeValue[serverKey] = readonlyTools.length > 0 ? readonlyTools : null
      } else {
        // Unknown server: no tools to whitelist -> block
        scopeValue[serverKey] = null
      }
    }
  } else if (mode === 'custom') {
    scopeValue = buildMcpScopeValue()
    // Warn if any dangerous tools are newly included
    const hasDangerous = Object.values(scopeValue || {}).some((v) =>
      Array.isArray(v) && v.some((id) => !isMcpToolReadonly(id))
    )
    if (hasDangerous && !confirm(t('agents.mcp_scope.confirm_dangerous'))) return
  }
  // mode === 'full' -> scopeValue stays null (removes mcpScope field)

  try {
    const res = await fetch(`/api/agents/${encodeURIComponent(currentAgent.name)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mcpScope: scopeValue }),
    })
    if (!res.ok) throw new Error()
    currentAgent.mcpScope = scopeValue
    showToast(t('agents.mcp_scope.save_ok'))
  } catch { showToast(t('agents.mcp_scope.save_error')) }
})

// === Channel tab ===
// Provider-aware "connected" check: a sub-agent record carries hasTelegram /
// hasDiscord / hasSlack flags from the backend, Marveen carries the same
// shape from /api/marveen. Falls back to hasTelegram for legacy callers.
function agentIsConnected(agent) {
  if (!agent) return false
  if (currentChannelProvider === 'discord') return !!agent.hasDiscord
  if (currentChannelProvider === 'slack') return !!agent.hasSlack
  if (currentChannelProvider === 'teams') return !!agent.hasTeams
  return !!agent.hasTelegram
}

function getProviderLabel() {
  if (currentChannelProvider === 'discord') return 'Discord'
  if (currentChannelProvider === 'slack') return 'Slack'
  if (currentChannelProvider === 'teams') return 'Microsoft Teams'
  return 'Telegram'
}

// Connected-view help text per provider. Returns innerHTML for the
// #chHowtoContent <div> -- swapped on every updateProviderUI() call so the
// "Hogyan adj hozzá több embert vagy csoportot?" panel matches the active
// channel provider.
function buildHowtoHtml() {
  if (currentChannelProvider === 'discord') return t('channel.howto.discord')
  if (currentChannelProvider === 'slack') return t('channel.howto.slack')
  if (currentChannelProvider === 'teams') return t('channel.howto.teams')
  return t('channel.howto.telegram')
}

function updateProviderUI() {
  const isTg = currentChannelProvider === 'telegram'
  const title = document.getElementById('chSetupTitle')
  const steps = document.getElementById('chSetupSteps')
  const label = document.getElementById('chTokenLabel')
  const input = document.getElementById('chTokenInput')
  const slackGroup = document.getElementById('chSlackAppTokenGroup')
  const manifestBtnGroup = document.getElementById('chSlackManifestBtnGroup')
  const smokeTestBtn = document.getElementById('chSmokeTestBtn')
  const reconnectBtn = document.getElementById('chReconnectBtn')
  const howto = document.getElementById('chHowtoContent')
  const pairingInfo = document.getElementById('chPairingInfo')
  const discordChannelGroup = document.getElementById('chDiscordChannelIdGroup')
  const tokenGroup = document.getElementById('chTokenGroup')
  // Teams config is terminal-driven (creds land in the .env via setup-azure-bot.sh),
  // not a dashboard token paste -- default the token field visible, hide it for teams.
  if (tokenGroup) tokenGroup.hidden = false

  if (isTg) {
    if (title) title.textContent = t('channel.setup.tg_title')
    if (steps) steps.innerHTML = t('channel.setup.tg_steps')
    if (label) label.textContent = 'Bot API Token'
    if (input) input.placeholder = '123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11'
    if (slackGroup) slackGroup.hidden = true
    if (manifestBtnGroup) manifestBtnGroup.hidden = true
    if (smokeTestBtn) smokeTestBtn.hidden = true
    if (discordChannelGroup) discordChannelGroup.hidden = true
    if (pairingInfo) pairingInfo.textContent = t('channel.setup.tg_pairing')
  } else if (currentChannelProvider === 'discord') {
    if (title) title.textContent = t('channel.setup.discord_title')
    if (steps) steps.innerHTML = t('channel.setup.discord_steps')
    if (label) label.textContent = 'Bot Token'
    if (input) input.placeholder = 'MTIzNDU2Nzg5MDEyMzQ1Njc4OQ...'
    if (slackGroup) slackGroup.hidden = true
    if (manifestBtnGroup) manifestBtnGroup.hidden = true
    if (smokeTestBtn) smokeTestBtn.hidden = true
    if (discordChannelGroup) discordChannelGroup.hidden = false
    if (pairingInfo) pairingInfo.textContent = t('channel.setup.discord_pairing')
  } else if (currentChannelProvider === 'teams') {
    if (title) title.textContent = t('channel.setup.teams_title')
    if (steps) steps.innerHTML = t('channel.setup.teams_steps')
    if (slackGroup) slackGroup.hidden = true
    if (manifestBtnGroup) manifestBtnGroup.hidden = true
    if (smokeTestBtn) smokeTestBtn.hidden = true
    if (discordChannelGroup) discordChannelGroup.hidden = true
    // No dashboard token entry for Teams -- creds come from the terminal setup.
    if (tokenGroup) tokenGroup.hidden = true
    if (pairingInfo) pairingInfo.textContent = t('channel.setup.teams_pairing')
  } else {
    if (title) title.textContent = t('channel.setup.slack_title')
    if (steps) steps.innerHTML = t('channel.setup.slack_steps')
    if (label) label.textContent = 'Bot Token (xoxb-...)'
    if (input) input.placeholder = 'xoxb-...'
    if (slackGroup) slackGroup.hidden = false
    if (manifestBtnGroup) manifestBtnGroup.hidden = false
    if (smokeTestBtn) smokeTestBtn.hidden = false
    if (discordChannelGroup) discordChannelGroup.hidden = true
    if (pairingInfo) pairingInfo.textContent = t('channel.setup.slack_pairing')
  }
  if (howto) howto.innerHTML = buildHowtoHtml()
  if (reconnectBtn) {
    reconnectBtn.hidden = !(currentAgent && currentAgent.running && agentIsConnected(currentAgent))
  }
}

function updateChannelTab(agent) {
  const connected = agentIsConnected(agent)
  const running = agent.running || false
  document.getElementById('chNotConnected').hidden = connected
  document.getElementById('chConnected').hidden = !connected
  if (connected) {
    document.getElementById('chBotUsername').textContent = agent.telegramBotUsername || '@bot'
    document.getElementById('chRunNotice').hidden = running
    document.getElementById('chRunningNotice').hidden = !running
  }
  document.getElementById('chTokenInput').value = ''
  const slackInput = document.getElementById('chSlackAppToken')
  if (slackInput) slackInput.value = ''
  const discordChanInput = document.getElementById('chDiscordChannelId')
  if (discordChanInput) discordChanInput.value = ''
  updateProviderUI()
  if (connected && running) {
    refreshChannelHealth()
  } else {
    document.getElementById('chDisconnectedNotice').hidden = true
    document.getElementById('chReconnectBtn').hidden = true
  }
  if (connected) {
    refreshPendingPairings()
    refreshAllowedList()
    refreshInvites()
    refreshChannelRequests()
  }
}

async function refreshChannelHealth() {
  if (!currentAgent) return
  try {
    const res = await fetch(`/api/agents/${encodeURIComponent(currentAgent.name)}/channel/health`)
    if (!res.ok) return
    const data = await res.json()
    const notice = document.getElementById('chDisconnectedNotice')
    const btn = document.getElementById('chReconnectBtn')
    if (!data.healthy) {
      if (notice) notice.hidden = false
      if (btn) btn.hidden = false
    } else {
      if (notice) notice.hidden = true
      if (btn) btn.hidden = false
    }
  } catch { /* ignore */ }
}

document.getElementById('chProviderSelect').addEventListener('change', (e) => {
  currentChannelProvider = e.target.value
  updateProviderUI()
  if (currentAgent) {
    updateChannelTab(currentAgent)
  }
})

document.getElementById('chConnectBtn').addEventListener('click', async () => {
  if (!currentAgent) return
  const token = document.getElementById('chTokenInput').value.trim()
  if (!token) {
    document.getElementById('chTokenInput').focus()
    return
  }

  const payload = { botToken: token }
  if (currentChannelProvider === 'slack') {
    const appToken = document.getElementById('chSlackAppToken').value.trim()
    if (appToken) payload.appToken = appToken
  } else if (currentChannelProvider === 'discord') {
    const channelId = document.getElementById('chDiscordChannelId').value.trim()
    if (channelId) payload.channelId = channelId
  }

  const btn = document.getElementById('chConnectBtn')
  btn.disabled = true
  btn.querySelector('.btn-text').hidden = true
  btn.querySelector('.btn-loading').hidden = false

  try {
    const res = await fetch(`${channelApiBase()}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    if (res.status === 409) {
      const err = await res.json()
      if (err.error === 'managed-settings-missing') {
        _showSudoModal?.(err.sudoCommand)
        return
      }
    }
    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      throw new Error(err.error || 'Kapcsolodasi hiba')
    }
    const result = await res.json()
    showToast(`${getProviderLabel()} sikeresen csatlakoztatva!`)
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

document.getElementById('chTestBtn').addEventListener('click', async () => {
  if (!currentAgent) return
  try {
    const res = await fetch(`${channelApiBase()}/test`, { method: 'POST' })
    if (!res.ok) throw new Error()
    showToast('Kapcsolat rendben!')
  } catch {
    showToast(t('channel.toast.smoke_failed'))
  }
})

document.getElementById('chReconnectBtn').addEventListener('click', async () => {
  if (!currentAgent) return
  const btn = document.getElementById('chReconnectBtn')
  const origText = btn.textContent
  btn.disabled = true
  btn.textContent = t('agents.btn.reconnect')
  try {
    const res = await fetch(`/api/agents/${encodeURIComponent(currentAgent.name)}/channel/reconnect`, { method: 'POST' })
    const data = await res.json()
    if (data.ok) {
      showToast('Channel-MCP reconnect sikeres')
      document.getElementById('chDisconnectedNotice').hidden = true
    } else {
      showToast(data.message || 'Reconnect sikertelen', true)
    }
  } catch {
    showToast('Reconnect hiba', true)
  } finally {
    btn.disabled = false
    btn.textContent = origText
  }
})

document.getElementById('chSmokeTestBtn').addEventListener('click', async () => {
  if (!currentAgent) return
  const btn = document.getElementById('chSmokeTestBtn')
  const origText = btn.textContent
  btn.disabled = true
  btn.textContent = t('agents.btn.running')
  try {
    const res = await fetch(`/api/agents/${encodeURIComponent(currentAgent)}/channels/slack/smoke-test`, { method: 'POST' })
    const data = await res.json()
    if (!res.ok) {
      showToast(data.error || 'Smoke-test sikertelen', true)
      return
    }
    showSmokeTestResult(data.output || 'OK')
  } catch {
    showToast('Smoke-test hiba', true)
  } finally {
    btn.disabled = false
    btn.textContent = origText
  }
})

function showSmokeTestResult(output) {
  const overlay = document.createElement('div')
  overlay.className = 'modal-overlay'
  overlay.innerHTML = `
    <div class="modal-content" style="max-width:600px">
      <h3>${t('channel.smoke_test.title')}</h3>
      <pre style="background:#1a1a2e;color:#e0e0e0;padding:12px;border-radius:6px;overflow-x:auto;font-size:13px;max-height:400px;white-space:pre-wrap">${output.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}</pre>
      <div style="text-align:right;margin-top:12px">
        <button class="btn-secondary" id="smokeTestCloseBtn">${t('common.btn.close')}</button>
      </div>
    </div>`
  document.body.appendChild(overlay)
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove() })
  document.getElementById('smokeTestCloseBtn').addEventListener('click', () => overlay.remove())
}

// Pairing: refresh pending list
async function refreshPendingPairings() {
  if (!currentAgent) return
  const listEl = document.getElementById('chPendingList')
  try {
    const res = await fetch(`${channelApiBase()}/pending`)
    if (!res.ok) return
    const pending = await res.json()
    listEl.innerHTML = ''
    if (pending.length === 0) {
      listEl.innerHTML = `<div style="font-size:12px; color:var(--text-muted); padding:6px 0;">${t('channel.pending.empty')}</div>`
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
        <button class="btn-primary btn-compact" style="padding:5px 12px; font-size:12px; margin:0" data-code="${escapeHtml(p.code)}">${t('common.btn.approve')}</button>
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
    const res = await fetch(`${channelApiBase()}/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    })
    if (!res.ok) {
      const err = await res.json()
      throw new Error(err.error || t('channel.toast.approve_error'))
    }
    showToast(t('channel.toast.pairing_approved'))
    refreshPendingPairings()
    refreshAllowedList()
  } catch (err) {
    showToast(`Hiba: ${err.message}`)
  }
}

document.getElementById('chRefreshPendingBtn').addEventListener('click', refreshPendingPairings)

async function refreshAllowedList() {
  if (!currentAgent) return
  const listEl = document.getElementById('chAllowedList')
  try {
    const res = await fetch(`${channelApiBase()}/allowed`)
    if (!res.ok) return
    const data = await res.json()
    const users = data.users || []
    const groups = data.groups || []
    if (users.length === 0 && groups.length === 0) {
      listEl.innerHTML = `<div class="tg-allowed-empty">${t('channel.allowed.empty')}</div>`
      return
    }
    listEl.innerHTML = ''
    for (const id of users) {
      const item = document.createElement('div')
      item.className = 'tg-allowed-item'
      item.innerHTML = `
        <div class="tg-allowed-meta">
          <span class="tg-allowed-kind">DM</span>
          <span class="tg-allowed-id">${escapeHtml(id)}</span>
        </div>
        <button class="btn-icon-danger" title="${t('common.btn.remove')}" data-kind="user" data-id="${escapeHtml(id)}">&times;</button>
      `
      item.querySelector('button').addEventListener('click', () => removeAllowed('user', id))
      listEl.appendChild(item)
    }
    for (const g of groups) {
      const item = document.createElement('div')
      item.className = 'tg-allowed-item'
      item.innerHTML = `
        <div class="tg-allowed-meta">
          <span class="tg-allowed-kind tg-allowed-kind-group">${t('channel.badge.group')}</span>
          <span class="tg-allowed-id">${escapeHtml(g.id)}</span>
        </div>
        <button class="btn-icon-danger" title="${t('common.btn.remove')}" data-kind="group" data-id="${escapeHtml(g.id)}">&times;</button>
      `
      item.querySelector('button').addEventListener('click', () => removeAllowed('group', g.id))
      listEl.appendChild(item)
    }
  } catch { /* ignore */ }
}

async function removeAllowed(kind, id) {
  if (!currentAgent) return
  const label = kind === 'user' ? t('channel.kind.user') : t('channel.kind.group')
  if (!confirm(t('channel.confirm.remove', { label, id }))) return
  try {
    const res = await fetch(`${channelApiBase()}/allowed/${kind}/${encodeURIComponent(id)}`, { method: 'DELETE' })
    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      throw new Error(err.error || t('channel.toast.remove_error'))
    }
    showToast(t('common.toast.removed'))
    refreshAllowedList()
  } catch (err) {
    showToast(`Hiba: ${err.message}`)
  }
}

document.getElementById('chRefreshAllowedBtn').addEventListener('click', refreshAllowedList)

async function refreshInvites() {
  if (!currentAgent) return
  const listEl = document.getElementById('chInviteList')
  try {
    const res = await fetch(`${channelApiBase()}/invites`)
    if (!res.ok) return
    const items = await res.json()
    if (!items.length) {
      listEl.innerHTML = `<div class="tg-allowed-empty">${t('channel.invite.empty')}</div>`
      return
    }
    listEl.innerHTML = ''
    for (const inv of items) {
      const item = document.createElement('div')
      item.className = 'tg-allowed-item'
      const expiresIn = Math.max(0, Math.floor((inv.expiresAt - Date.now()) / 60000))
      const status = inv.used
        ? `<span class="tg-allowed-kind" style="background:rgba(180,180,180,0.15); color:var(--text-muted);">${t('channel.invite.used_badge')}</span>`
        : `<span class="tg-allowed-kind tg-allowed-kind-group">${t('channel.invite.active_badge', { min: expiresIn })}</span>`
      const linkHtml = inv.deepLink
        ? `<a href="${escapeHtml(inv.deepLink)}" target="_blank" class="tg-allowed-id" style="text-decoration:underline;">${escapeHtml(inv.deepLink)}</a>`
        : `<span class="tg-allowed-id">${t('channel.invite.no_username')}</span>`
      item.innerHTML = `
        <div class="tg-allowed-meta" style="flex-wrap:wrap; gap:6px;">
          ${status}
          ${linkHtml}
        </div>
        <div style="display:flex; gap:6px;">
          ${inv.deepLink && !inv.used ? `<button class="btn-secondary btn-compact" data-link="${escapeHtml(inv.deepLink)}" style="padding:4px 10px; font-size:11px; margin:0;">${t('common.btn.copy_btn')}</button>` : ''}
          <button class="btn-icon-danger" title="${t('channel.btn.revoke')}" data-token="${escapeHtml(inv.token)}">&times;</button>
        </div>
      `
      const copyBtn = item.querySelector('button[data-link]')
      if (copyBtn) {
        copyBtn.addEventListener('click', async (e) => {
          const link = e.currentTarget.getAttribute('data-link')
          try { await navigator.clipboard.writeText(link); showToast(t('common.toast.copied')) }
          catch { showToast(t('common.toast.copy_failed')) }
        })
      }
      const revokeBtn = item.querySelector('button[data-token]')
      if (revokeBtn) {
        revokeBtn.addEventListener('click', () => revokeInviteToken(inv.token))
      }
      listEl.appendChild(item)
    }
  } catch { /* ignore */ }
}

async function generateInvite() {
  if (!currentAgent) return
  const btn = document.getElementById('chGenerateInviteBtn')
  btn.disabled = true
  btn.textContent = t('channel.btn.invite_gen')
  try {
    const res = await fetch(`${channelApiBase()}/invites`, { method: 'POST' })
    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      throw new Error(err.error || 'Sikertelen')
    }
    const data = await res.json()
    if (data.deepLink) {
      try { await navigator.clipboard.writeText(data.deepLink); showToast(t('channel.toast.invite_copied')) }
      catch { showToast(t('channel.toast.invite_created')) }
    } else {
      showToast(t('channel.toast.invite_pending'))
    }
    refreshInvites()
  } catch (err) {
    showToast(`Hiba: ${err.message}`)
  } finally {
    btn.disabled = false
    btn.textContent = t('channel.btn.invite_new')
  }
}

async function revokeInviteToken(token) {
  if (!currentAgent) return
  if (!confirm(t('channel.confirm.revoke'))) return
  try {
    const res = await fetch(`${channelApiBase()}/invites/${encodeURIComponent(token)}`, { method: 'DELETE' })
    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      throw new Error(err.error || 'Sikertelen')
    }
    showToast(t('channel.toast.invite_revoked'))
    refreshInvites()
  } catch (err) {
    showToast(`Hiba: ${err.message}`)
  }
}

document.getElementById('chGenerateInviteBtn').addEventListener('click', generateInvite)
document.getElementById('chRefreshInvitesBtn').addEventListener('click', refreshInvites)

// --- Channel Requests (Slack channel opt-in) ---
async function refreshChannelRequests() {
  if (!currentAgent) return
  const section = document.getElementById('chRequestSection')
  const listEl = document.getElementById('chRequestList')
  const badge = document.getElementById('chRequestBadge')
  if (currentChannelProvider !== 'slack') {
    section.hidden = true
    return
  }
  try {
    const res = await fetch(`/api/agents/${encodeURIComponent(currentAgent.name)}/channel-requests`)
    if (!res.ok) { section.hidden = true; return }
    const items = await res.json()
    if (!items.length) {
      section.hidden = true
      badge.hidden = true
      return
    }
    section.hidden = false
    badge.hidden = false
    badge.textContent = items.length
    listEl.innerHTML = ''
    for (const req of items) {
      const item = document.createElement('div')
      item.className = 'tg-allowed-item'
      const name = req.channel_name ? escapeHtml(req.channel_name) : req.channel_id
      const ts = new Date(req.requested_at * 1000).toLocaleString('hu-HU')
      const userId = req.user_id ? `<span class="tg-allowed-id">user: ${escapeHtml(req.user_id)}</span>` : ''
      item.innerHTML = `
        <div class="tg-allowed-meta">
          <span class="tg-allowed-kind tg-allowed-kind-group">#${name}</span>
          ${userId}
          <span class="tg-allowed-id" style="font-size:11px;color:var(--text-muted)">${ts}</span>
        </div>
        <div style="display:flex;gap:6px">
          <button class="btn-primary btn-compact" data-approve="${req.id}" style="padding:4px 10px;font-size:11px;margin:0">${t('common.btn.approve')}</button>
          <button class="btn-icon-danger" data-deny="${req.id}" title="${t('channel.btn.deny')}">&times;</button>
        </div>
      `
      item.dataset.reqId = req.id
      item.querySelector('[data-approve]').addEventListener('click', () => openApproveModal(req.id, req.channel_name || req.channel_id, req.user_id))
      item.querySelector('[data-deny]').addEventListener('click', () => denyChannelRequest(req.id, item))
      listEl.appendChild(item)
    }
  } catch { section.hidden = true }
}

let _approveReqId = null

function openApproveModal(id, channelName, userId) {
  _approveReqId = id
  const desc = document.getElementById('chApproveModalDesc')
  const userNote = userId ? t('channel.approve.requester', { user: escapeHtml(userId) }) : ''
  desc.textContent = t('channel.approve.desc', { channel: escapeHtml(channelName), requester: userNote })
  document.getElementById('chApproveRequireMention').checked = true
  document.getElementById('chApproveAllowFromAll').checked = false
  document.getElementById('chApproveModalOverlay').hidden = false
}

async function submitApproveModal() {
  const id = _approveReqId
  if (!id) return
  const requireMention = document.getElementById('chApproveRequireMention').checked
  const allowFromAll = document.getElementById('chApproveAllowFromAll').checked
  const confirmBtn = document.getElementById('chApproveModalConfirm')
  confirmBtn.querySelector('.btn-text').hidden = true
  confirmBtn.querySelector('.btn-loading').hidden = false
  confirmBtn.disabled = true
  try {
    const res = await fetch(`/api/agents/${encodeURIComponent(currentAgent.name)}/channel-requests/${id}/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requireMention, allowFromAll }),
    })
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Hiba')
    document.getElementById('chApproveModalOverlay').hidden = true
    const item = document.querySelector(`[data-req-id="${id}"]`)
    if (item) item.remove()
    showToast(t('channel.toast.approved'))
    refreshChannelRequests()
  } catch (err) {
    showToast(`Hiba: ${err.message}`)
  } finally {
    confirmBtn.querySelector('.btn-text').hidden = false
    confirmBtn.querySelector('.btn-loading').hidden = true
    confirmBtn.disabled = false
  }
}

async function denyChannelRequest(id, itemEl) {
  if (itemEl?.dataset.denying) return
  if (itemEl) itemEl.dataset.denying = '1'
  if (itemEl) itemEl.remove()
  try {
    const res = await fetch(`/api/agents/${encodeURIComponent(currentAgent.name)}/channel-requests/${id}/deny`, { method: 'POST' })
    if (!res.ok) throw new Error('Hiba')
    showToast(t('channel.toast.denied'))
    refreshChannelRequests()
  } catch (err) {
    showToast(`Hiba: ${err.message}`)
    refreshChannelRequests()
  }
}

;(function initApproveModal() {
  function closeApproveModal() { document.getElementById('chApproveModalOverlay').hidden = true }
  document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('chApproveModalConfirm').addEventListener('click', submitApproveModal)
    document.getElementById('chApproveModalClose').addEventListener('click', closeApproveModal)
    document.getElementById('chApproveModalCancel').addEventListener('click', closeApproveModal)
    document.getElementById('chApproveModalOverlay').addEventListener('click', (e) => { if (e.target === e.currentTarget) closeApproveModal() })
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !document.getElementById('chApproveModalOverlay').hidden) closeApproveModal()
    })
  })
})()

document.getElementById('chApproveBtn').addEventListener('click', async () => {
  const code = document.getElementById('chPairCode').value.trim()
  if (!code) { document.getElementById('chPairCode').focus(); return }
  await approvePairing(code)
  document.getElementById('chPairCode').value = ''
  refreshAllowedList()
})

document.getElementById('chDisconnectBtn').addEventListener('click', async () => {
  if (!currentAgent) return
  const provLabel = getProviderLabel()
  if (!confirm(`Biztosan levalasztod a ${provLabel} csatornat?`)) return
  try {
    await fetch(`${channelApiBase()}`, { method: 'DELETE' })
    showToast(`${provLabel} levalasztva`)
    await openAgentDetail(currentAgent.name)
    loadAgents()
  } catch {
    showToast(t('channel.toast.disconnect_error'))
  }
})


// === Team org-chart (now embedded in Agents page, tree view) ===
async function loadTeamGraph() {
  const container = document.getElementById('teamGraph')
  if (!container) return
  container.innerHTML = '<div class="team-empty">' + t('team.loading') + '</div>'
  try {
    const res = await fetch('/api/team/graph')
    if (!res.ok) throw new Error('HTTP ' + res.status)
    const data = await res.json()
    renderTeamGraph(container, data, { editable: true })
  } catch (err) {
    container.innerHTML = `<div class="team-empty">${t('team.error', { msg: err.message || err })}</div>`
  }
}

// Persist a drag-and-drop reporting change: `childId` now reports to `parentId`.
// Guards (also enforced server-side) keep the caller from creating a cycle or
// writing a no-op. On success the graph is reloaded so the tree re-lays-out.
async function saveTeamReportsTo(childId, parentId, ctx) {
  const { byId, parentOf, descendantsOf, mainAgentId } = ctx
  if (!childId || childId === parentId || childId === mainAgentId) return
  if (parentOf.get(childId) === parentId) return  // already the parent
  if (descendantsOf(childId).has(parentId)) { showToast(t('team.drop.cycle')); return }
  try {
    const r = await fetch(`/api/agents/${encodeURIComponent(childId)}/team`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reportsTo: parentId }),
    })
    if (!r.ok) throw new Error('HTTP ' + r.status)
    const result = await r.json().catch(() => ({}))
    if (result.cycleRejected) { showToast(t('team.drop.cycle')); return }
    const childLabel = (byId.get(childId) || {}).label || childId
    const parentLabel = (byId.get(parentId) || {}).label || parentId
    showToast(t('team.drop.saved', { child: childLabel, parent: parentLabel }))
    loadTeamGraph()
  } catch {
    showToast(t('team.drop.error'))
  }
}

function renderTeamGraph(container, data, opts = {}) {
  const editable = !!opts.editable
  const { nodes, edges, mainAgentId } = data
  container.innerHTML = ''
  const byId = new Map(nodes.map(n => [n.id, n]))
  const childrenOf = new Map()
  const parentOf = new Map()
  for (const n of nodes) childrenOf.set(n.id, [])
  for (const e of edges) {
    if (childrenOf.has(e.from)) childrenOf.get(e.from).push(e.to)
    parentOf.set(e.to, e.from)
  }
  // Transitive reports of `id` (its whole subtree). Used to reject dropping a
  // manager onto one of its own reports, which would orphan the subtree.
  const descendantsOf = (id) => {
    const out = new Set()
    const walk = (x) => {
      for (const c of (childrenOf.get(x) || [])) {
        if (!out.has(c)) { out.add(c); walk(c) }
      }
    }
    walk(id)
    return out
  }
  const dropCtx = { byId, parentOf, descendantsOf, mainAgentId }
  // A single dragged id shared across all nodes' dragover handlers so they can
  // validate the target (dataTransfer payload is unreadable during dragover).
  let draggingId = null
  const renderNode = (node) => {
    const div = document.createElement('div')
    div.className = 'team-node'
    if (node.role === 'main') div.classList.add('main')
    else if (node.role === 'leader') div.classList.add('leader')
    const roleLabel = node.role === 'main' ? t('team.role.main') : (node.role === 'leader' ? t('team.role.leader') : t('team.role.member'))
    const running = node.running ? t('team.running') : t('team.stopped')
    const avatarUrl = node.id === mainAgentId
      ? `/api/marveen/avatar${avatarBust()}`
      : `/api/agents/${encodeURIComponent(node.id)}/avatar${avatarBust()}`
    div.innerHTML = `
      <div class="team-node-avatar"><img src="${avatarUrl}" alt="${escapeHtml(node.label || node.id)}" onerror="this.style.display='none'"></div>
      <div class="team-node-name">${escapeHtml(node.label || node.id)}</div>
      <div class="team-node-meta">${escapeHtml(roleLabel)}</div>
      <div class="team-node-meta">${running}</div>
    `
    if (node.id !== mainAgentId) {
      div.addEventListener('click', () => openAgentDetail(node.id))
    }
    // Drag-and-drop reporting edit (Team page only). Any agent except the main
    // one can be dragged; any node can be a drop target (dropping onto the main
    // agent makes the report a direct report of it).
    if (editable) {
      if (node.id !== mainAgentId) {
        div.draggable = true
        div.classList.add('team-draggable')
        div.addEventListener('dragstart', (e) => {
          draggingId = node.id
          e.dataTransfer.setData('text/plain', node.id)
          e.dataTransfer.effectAllowed = 'move'
          div.classList.add('team-dragging')
        })
        div.addEventListener('dragend', () => {
          draggingId = null
          div.classList.remove('team-dragging')
        })
      }
      const isValidTarget = () =>
        draggingId && draggingId !== node.id &&
        parentOf.get(draggingId) !== node.id &&
        !descendantsOf(draggingId).has(node.id)
      div.addEventListener('dragover', (e) => {
        if (!isValidTarget()) return  // no preventDefault -> shows "no drop"
        e.preventDefault()
        e.dataTransfer.dropEffect = 'move'
        div.classList.add('team-drop-target')
      })
      div.addEventListener('dragleave', () => div.classList.remove('team-drop-target'))
      div.addEventListener('drop', (e) => {
        e.preventDefault()
        div.classList.remove('team-drop-target')
        const childId = e.dataTransfer.getData('text/plain') || draggingId
        saveTeamReportsTo(childId, node.id, dropCtx)
      })
    }
    return div
  }
  // Render as a nested tree so each report sits directly under its own
  // manager. A flat BFS-by-row layout made a leader's reports look like they
  // belonged to whichever node happened to be above them in the row.
  const seen = new Set([mainAgentId])
  const renderSubtree = (id) => {
    const node = byId.get(id)
    if (!node) return null
    const col = document.createElement('div')
    col.className = 'team-subtree'
    col.appendChild(renderNode(node))
    const kids = (childrenOf.get(id) || []).filter(c => !seen.has(c) && byId.has(c))
    for (const c of kids) seen.add(c)
    if (kids.length) {
      const conn = document.createElement('div')
      conn.className = 'team-connector'
      col.appendChild(conn)
      const row = document.createElement('div')
      row.className = 'team-children'
      for (const c of kids) {
        const sub = renderSubtree(c)
        if (sub) row.appendChild(sub)
      }
      col.appendChild(row)
    }
    return col
  }
  // Main on top, then a row of its direct reports (each carrying its own
  // subtree beneath it).
  const mainNode = byId.get(mainAgentId)
  if (mainNode) {
    const mainRow = document.createElement('div')
    mainRow.className = 'team-level'
    mainRow.appendChild(renderNode(mainNode))
    container.appendChild(mainRow)
  }
  const directs = (childrenOf.get(mainAgentId) || []).filter(c => !seen.has(c) && byId.has(c))
  for (const c of directs) seen.add(c)
  if (directs.length) {
    const conn = document.createElement('div')
    conn.className = 'team-connector'
    container.appendChild(conn)
    const row = document.createElement('div')
    row.className = 'team-children team-roots'
    for (const c of directs) {
      const sub = renderSubtree(c)
      if (sub) row.appendChild(sub)
    }
    container.appendChild(row)
  }
  // Orphans (nodes not reachable from main, shouldn't happen with the auto
  // fallback on the backend but guard just in case) go to a trailing row.
  const orphans = nodes.filter(n => !seen.has(n.id))
  if (orphans.length) {
    const row = document.createElement('div')
    row.className = 'team-level'
    for (const n of orphans) row.appendChild(renderNode(n))
    container.appendChild(row)
  }
  if (nodes.length === 1) {
    const empty = document.createElement('div')
    empty.className = 'team-empty'
    empty.textContent = t('team.empty')
    container.appendChild(empty)
  }
}

// === Agents page: grid / org-chart view toggle ===
export function setAgentsView(view) {
  _agentsActiveView = view
  const gridView = document.getElementById('agentsGridView')
  const treeView = document.getElementById('agentsTreeView')
  const gridBtn  = document.getElementById('agentsViewGrid')
  const treeBtn  = document.getElementById('agentsViewTree')
  if (!gridView || !treeView) return
  const showGrid = view === 'grid'
  gridView.hidden = !showGrid
  treeView.hidden = showGrid
  if (gridBtn) gridBtn.classList.toggle('active', showGrid)
  if (treeBtn) treeBtn.classList.toggle('active', !showGrid)
  if (!showGrid) loadTeamGraph()
}

const _agentsViewGridBtn = document.getElementById('agentsViewGrid')
const _agentsViewTreeBtn = document.getElementById('agentsViewTree')
if (_agentsViewGridBtn) _agentsViewGridBtn.addEventListener('click', () => setAgentsView('grid'))
if (_agentsViewTreeBtn) _agentsViewTreeBtn.addEventListener('click', () => setAgentsView('tree'))

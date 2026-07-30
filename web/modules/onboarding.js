import { escapeHtml, mainAgentId } from './util.js'
import { t } from './i18n.js'
import { showToast } from './toast.js'
import { agentApiName } from './agents.js'



// ============================================================
// === First-run onboarding wizard ===
// Full-screen overlay shown when /api/onboarding/status reports the install
// still needs setup. Steps 2-3 reuse the existing channel-setup backend endpoints.
// ============================================================

const ONBOARDING_DISMISS_KEY = 'mvOnboardingDismissed'

async function fetchOnboardingStatus() {
  try { return await (await fetch('/api/onboarding/status')).json() } catch { return null }
}

function onboardingCurrentStep(s) {
  if (!s.identityConfirmed) return 1
  if (!s.claudeAuthPresent || !s.agentsRunning) return 2
  if (!s.channelConfigured) return 3
  if (!s.paired) return 4
  return 0
}

function onboardingDismissed() {
  try { return localStorage.getItem(ONBOARDING_DISMISS_KEY) === '1' } catch { return false }
}

export function dismissOnboarding() {
  try { localStorage.setItem(ONBOARDING_DISMISS_KEY, '1') } catch { /* private mode */ }
  const overlay = document.getElementById('onboardingOverlay')
  if (overlay) { overlay.classList.remove('active'); overlay.hidden = true }
  document.body.style.overflow = ''
}

async function refreshOnboarding() {
  const s = await fetchOnboardingStatus()
  if (s) renderOnboarding(s)
}

function renderOnboarding(s) {
  if (onboardingDismissed()) return
  const overlay = document.getElementById('onboardingOverlay')
  if (!overlay) return
  const step = onboardingCurrentStep(s)
  if (step === 0) { overlay.classList.remove('active'); overlay.hidden = true; document.body.style.overflow = ''; return }
  overlay.hidden = false
  overlay.classList.add('active')
  document.body.style.overflow = 'hidden'
  document.querySelectorAll('#onboardingSteps .onboarding-step').forEach((el) => {
    const n = Number(el.dataset.ostep)
    el.classList.toggle('active', n === step)
    el.classList.toggle('done', n < step)
  })
  const body = document.getElementById('onboardingBody')
  if (step === 1) body.innerHTML = onbIdentityHtml(s)
  else if (step === 2) body.innerHTML = onbStep1Html(s)
  else if (step === 3) body.innerHTML = onbStep2Html()
  else body.innerHTML = onbStep3Html()
  // The steps build on each other and the system only comes alive at the end
  // of step 4 -- say so, or a fresh installer reads step 2's "saved" as "done"
  // and every later "bot token not found" as a failure (BK bootcamp, 07-28).
  const flowNote = document.getElementById('onbFlowNote')
  if (flowNote) flowNote.textContent = step === 4 ? t('onboarding.flow_note_last') : t('onboarding.flow_note')
  wireOnboarding(step)
}

function onbMsg(text, isErr) {
  const el = document.getElementById('onbMsg')
  if (el) { el.textContent = text; el.className = 'onb-msg' + (isErr ? ' err' : ' ok') }
}

function onbIdentityHtml(s) {
  return `<p>${escapeHtml(t('onboarding.identity.desc'))}</p>`
    + `<label class="form-label-sm">${escapeHtml(t('onboarding.identity.agent_label'))}</label>`
    + `<input id="onbAgentName" type="text" class="onb-input" maxlength="40" value="${escapeHtml(s.currentAgentName || '')}" autocomplete="off">`
    + `<label class="form-label-sm">${escapeHtml(t('onboarding.identity.owner_label'))}</label>`
    + `<input id="onbOwnerName" type="text" class="onb-input" maxlength="60" value="${escapeHtml(s.currentOwnerName || '')}" autocomplete="off">`
    + `<div class="onb-hint">${escapeHtml(t('onboarding.identity.hint'))}</div>`
    + `<button class="btn-primary btn-compact" id="onbIdentityBtn">${escapeHtml(t('onboarding.identity.save_btn'))}</button>`
    + `<div id="onbMsg" class="onb-msg"></div>`
}

function onbStep1Html(s) {
  return `<p>${escapeHtml(t('onboarding.step1.desc'))}</p>`
    + (s.claudeAuthPresent
      ? `<p class="onb-ok-line">${escapeHtml(t('onboarding.step1.auth_done'))}</p>`
      : `<label class="form-label-sm">${escapeHtml(t('onboarding.step1.token_label'))}</label>`
        + `<input id="onbToken" type="password" class="onb-input" placeholder="sk-ant-oat01-..." autocomplete="off">`
        + `<div class="onb-hint">${escapeHtml(t('onboarding.step1.token_hint'))}</div>`
        + `<button class="btn-primary btn-compact" id="onbAuthBtn">${escapeHtml(t('onboarding.step1.save_btn'))}</button>`)
    + (s.claudeAuthPresent && !s.agentsRunning
      ? `<button class="btn-primary btn-compact" id="onbLaunchBtn">${escapeHtml(t('onboarding.step1.launch_btn'))}</button>`
      : '')
    + `<div id="onbMsg" class="onb-msg"></div>`
}

function onbStep2Html() {
  return `<p>${escapeHtml(t('onboarding.step2.desc'))}</p>`
    + `<label class="form-label-sm">${escapeHtml(t('onboarding.step2.token_label'))}</label>`
    + `<input id="onbBotToken" type="password" class="onb-input" placeholder="123456:ABC..." autocomplete="off">`
    + `<div class="onb-hint">${escapeHtml(t('onboarding.step2.token_hint'))}</div>`
    + `<button class="btn-primary btn-compact" id="onbBotBtn">${escapeHtml(t('onboarding.step2.save_btn'))}</button>`
    + `<div id="onbMsg" class="onb-msg"></div>`
}

function onbStep3Html() {
  return `<p>${escapeHtml(t('onboarding.step3.desc'))}</p>`
    + `<ol class="onb-list"><li>${escapeHtml(t('onboarding.step3.li1'))}</li><li>${escapeHtml(t('onboarding.step3.li2'))}</li></ol>`
    + `<div id="onbPending" class="onb-pending"></div>`
    + `<button class="btn-secondary btn-compact" id="onbRefreshBtn">${escapeHtml(t('onboarding.step3.refresh_btn'))}</button>`
    + `<div id="onbMsg" class="onb-msg"></div>`
}

function wireOnboarding(step) {
  if (step === 1) {
    const idBtn = document.getElementById('onbIdentityBtn')
    if (idBtn) idBtn.addEventListener('click', async () => {
      const agentName = (document.getElementById('onbAgentName').value || '').trim()
      const ownerName = (document.getElementById('onbOwnerName').value || '').trim()
      if (!agentName || !ownerName) { onbMsg(t('onboarding.identity.empty'), true); return }
      idBtn.disabled = true; onbMsg(t('onboarding.saving'))
      try {
        const res = await fetch('/api/onboarding/identity', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agentName, ownerName }) })
        const d = await res.json().catch(() => ({}))
        if (!res.ok) { idBtn.disabled = false; onbMsg(d.error || t('onboarding.error'), true); return }
        onbMsg(t('onboarding.identity.saved'))
        await refreshOnboarding()
      } catch (e) { idBtn.disabled = false; onbMsg((e && e.message) || t('onboarding.error'), true) }
    })
    return
  }
  if (step === 2) {
    const authBtn = document.getElementById('onbAuthBtn')
    if (authBtn) authBtn.addEventListener('click', async () => {
      const token = (document.getElementById('onbToken').value || '').trim()
      if (!token) { onbMsg(t('onboarding.step1.token_empty'), true); return }
      authBtn.disabled = true; onbMsg(t('onboarding.saving'))
      try {
        const res = await fetch('/api/onboarding/claude-auth', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) })
        const d = await res.json().catch(() => ({}))
        if (!res.ok) { authBtn.disabled = false; onbMsg(d.error || t('onboarding.error'), true); return }
        // Fresh-install path: the server restarts the (previously
        // unauthenticated) channels session right after the first auth save --
        // surface that, and on failure show the manual restart step instead of
        // silently advancing.
        if (d.restartError) { authBtn.disabled = false; onbMsg(t('onboarding.step1.saved_restart_failed'), true); setTimeout(refreshOnboarding, 6000); return }
        if (d.restarted) { onbMsg(t('onboarding.step1.saved_restarted')); setTimeout(refreshOnboarding, 2500); return }
        onbMsg(d.verified ? t('onboarding.step1.saved_verified') : t('onboarding.step1.saved_unverified'))
        await refreshOnboarding()
      } catch (e) { authBtn.disabled = false; onbMsg((e && e.message) || t('onboarding.error'), true) }
    })
    const launchBtn = document.getElementById('onbLaunchBtn')
    if (launchBtn) launchBtn.addEventListener('click', async () => {
      launchBtn.disabled = true; onbMsg(t('onboarding.step1.launching'))
      try {
        const res = await fetch('/api/onboarding/launch', { method: 'POST' })
        const d = await res.json().catch(() => ({}))
        if (!res.ok) { launchBtn.disabled = false; onbMsg(d.error || t('onboarding.error'), true); return }
        onbMsg(t('onboarding.step1.launched'))
        setTimeout(refreshOnboarding, 2500)
      } catch (e) { launchBtn.disabled = false; onbMsg((e && e.message) || t('onboarding.error'), true) }
    })
  } else if (step === 3) {
    const botBtn = document.getElementById('onbBotBtn')
    if (botBtn) botBtn.addEventListener('click', async () => {
      const botToken = (document.getElementById('onbBotToken').value || '').trim()
      if (!botToken) { onbMsg(t('onboarding.step2.token_empty'), true); return }
      botBtn.disabled = true; onbMsg(t('onboarding.saving'))
      try {
        const res = await fetch(`/api/agents/${encodeURIComponent(mainAgentId())}/channels/telegram`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ botToken }) })
        const d = await res.json().catch(() => ({}))
        if (!res.ok) { botBtn.disabled = false; onbMsg(d.error || t('onboarding.error'), true); return }
        onbMsg(t('onboarding.step2.saved'))
        setTimeout(refreshOnboarding, 2000)
      } catch (e) { botBtn.disabled = false; onbMsg((e && e.message) || t('onboarding.error'), true) }
    })
  } else if (step === 4) {
    const refreshBtn = document.getElementById('onbRefreshBtn')
    const loadPending = async () => {
      try {
        const p = await (await fetch(`/api/agents/${encodeURIComponent(mainAgentId())}/channels/telegram/pending`)).json()
        const now = Date.now()
        const list = (Array.isArray(p) ? p : (p.pending || [])).filter((x) => x && x.code && (!x.expiresAt || x.expiresAt > now))
        const box = document.getElementById('onbPending')
        if (!box) return
        if (!list.length) { box.innerHTML = `<span class="onb-hint">${escapeHtml(t('onboarding.step3.no_pending'))}</span>`; return }
        box.innerHTML = list.map((x) => {
          const code = escapeHtml(String(x.code))
          const label = escapeHtml(String(x.senderId || x.chatId || '?')) + ' · ' + code
          return `<div class="onb-pending-row"><span>${label}</span><button class="btn-primary btn-compact onb-approve" data-code="${code}">${escapeHtml(t('onboarding.step3.approve_btn'))}</button></div>`
        }).join('')
        box.querySelectorAll('.onb-approve').forEach((b) => b.addEventListener('click', async () => {
          b.disabled = true
          try {
            const res = await fetch(`/api/agents/${encodeURIComponent(mainAgentId())}/channels/telegram/approve`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: b.dataset.code }) })
            const d = await res.json().catch(() => ({}))
            if (!res.ok) { b.disabled = false; onbMsg(d.error || t('onboarding.error'), true); return }
            onbMsg(t('onboarding.step3.approved'))
            setTimeout(refreshOnboarding, 1500)
          } catch (e) { b.disabled = false; onbMsg((e && e.message) || t('onboarding.error'), true) }
        }))
      } catch { /* ignore */ }
    }
    if (refreshBtn) refreshBtn.addEventListener('click', () => { refreshOnboarding() })
    loadPending()
  }
}

export async function initOnboarding() {
  if (onboardingDismissed()) return
  const s = await fetchOnboardingStatus()
  if (!s || !s.needsOnboarding) return
  renderOnboarding(s)
}

// ============================================================
// === Sudo modal for managed-settings.json (Slack setup pre-flight) ===
// Exported so agents.js can call it via DI injection from app.js.
// ============================================================

export function showSudoModal(sudoCommand) {
  let overlay = document.getElementById('sudoModalOverlay')
  if (overlay) overlay.remove()
  overlay = document.createElement('div')
  overlay.id = 'sudoModalOverlay'
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:9999;display:flex;align-items:center;justify-content:center'
  const card = document.createElement('div')
  card.style.cssText = 'background:var(--bg-card);border:1px solid var(--border);border-radius:12px;padding:24px;max-width:560px;width:90%'
  card.innerHTML = `
    <h3 style="margin:0 0 12px">${t('channel.sudo_modal.title')}</h3>
    <p style="font-size:13px;color:var(--text-muted);margin:0 0 16px">${t('channel.sudo_modal.desc')}</p>
    <div style="position:relative">
      <pre id="sudoCmdPre" style="background:var(--bg-main);border:1px solid var(--border);border-radius:8px;padding:12px;font-size:12px;overflow-x:auto;white-space:pre-wrap;word-break:break-all">${escapeHtml(sudoCommand)}</pre>
      <button id="sudoCopyBtn" style="position:absolute;top:6px;right:6px;padding:4px 10px;font-size:11px;border-radius:6px;border:1px solid var(--border);background:var(--bg-card);cursor:pointer">${t('common.copy')}</button>
    </div>
    <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:16px">
      <button id="sudoCancelBtn" class="btn btn-secondary" style="padding:6px 16px;font-size:13px">${t('channel.sudo_modal.cancel')}</button>
      <button id="sudoDoneBtn" class="btn btn-primary" style="padding:6px 16px;font-size:13px">${t('channel.sudo_modal.retry')}</button>
    </div>
  `
  overlay.appendChild(card)
  document.body.appendChild(overlay)

  document.getElementById('sudoCopyBtn').addEventListener('click', () => {
    navigator.clipboard.writeText(sudoCommand).then(() => {
      document.getElementById('sudoCopyBtn').textContent = t('common.copied')
      setTimeout(() => { document.getElementById('sudoCopyBtn').textContent = t('common.copy') }, 1500)
    })
  })
  document.getElementById('sudoCancelBtn').addEventListener('click', () => overlay.remove())
  document.getElementById('sudoDoneBtn').addEventListener('click', () => {
    overlay.remove()
    document.getElementById('chConnectBtn').click()
  })
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove() })
}

// ============================================================
// === Clipboard fallback (non-secure context / legacy browser) ===
// ============================================================

function fallbackCopyToClipboard(text, btn) {
  const ta = document.createElement('textarea')
  ta.value = text
  ta.style.cssText = 'position:fixed;left:-9999px'
  document.body.appendChild(ta)
  ta.select()
  try {
    const ok = document.execCommand('copy')
    if (ok) {
      btn.textContent = t('common.copied')
      setTimeout(() => { btn.textContent = t('common.copy') }, 1500)
    } else {
      showToast(t('common.toast.copy_failed'))
    }
  } catch {
    showToast(t('common.toast.copy_failed'))
  }
  document.body.removeChild(ta)
}

// ============================================================
// === Slack App manifest modal ===
// ============================================================

function showSlackManifestModal(manifest, instructions) {
  let overlay = document.getElementById('slackManifestOverlay')
  if (overlay) overlay.remove()
  overlay = document.createElement('div')
  overlay.id = 'slackManifestOverlay'
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:9999;display:flex;align-items:center;justify-content:center'
  const card = document.createElement('div')
  card.style.cssText = 'background:var(--bg-card);border:1px solid var(--border);border-radius:12px;padding:24px;max-width:640px;width:95%;max-height:85vh;overflow-y:auto'

  const stepsHtml = instructions.map((s) => `<li style="margin-bottom:6px">${escapeHtml(s)}</li>`).join('')

  card.innerHTML = `
    <h3 style="margin:0 0 16px">${t('channel.slack_manifest.title')}</h3>
    <p style="font-size:13px;color:var(--text-muted);margin:0 0 12px">${t('channel.slack_manifest.desc')}</p>
    <div style="position:relative;margin-bottom:16px">
      <pre id="slackManifestPre" style="background:var(--bg-main);border:1px solid var(--border);border-radius:8px;padding:12px;font-size:12px;overflow-x:auto;white-space:pre-wrap;word-break:break-all;max-height:240px;overflow-y:auto">${escapeHtml(manifest)}</pre>
      <button id="slackManifestCopyBtn" style="position:absolute;top:6px;right:6px;padding:4px 10px;font-size:11px;border-radius:6px;border:1px solid var(--border);background:var(--bg-card);cursor:pointer">${t('common.copy')}</button>
    </div>
    <h4 style="margin:0 0 8px;font-size:14px">${t('channel.slack_manifest.steps_title')}</h4>
    <ol style="font-size:13px;padding-left:20px;margin:0 0 16px">${stepsHtml}</ol>
    <div style="display:flex;gap:8px;justify-content:flex-end">
      <button id="slackManifestCloseBtn" class="btn btn-secondary" style="padding:6px 16px;font-size:13px">${t('common.btn.close')}</button>
      <a href="https://api.slack.com/apps" target="_blank" rel="noopener" class="btn btn-primary" style="padding:6px 16px;font-size:13px;text-decoration:none;display:inline-flex;align-items:center;gap:4px">
        ${t('channel.slack_manifest.open_btn')}
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
      </a>
    </div>
  `
  overlay.appendChild(card)
  document.body.appendChild(overlay)

  document.getElementById('slackManifestCopyBtn').addEventListener('click', () => {
    const copyBtn = document.getElementById('slackManifestCopyBtn')
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(manifest).then(() => {
        copyBtn.textContent = t('common.copied')
        setTimeout(() => { copyBtn.textContent = t('common.copy') }, 1500)
      }).catch(() => {
        fallbackCopyToClipboard(manifest, copyBtn)
      })
    } else {
      fallbackCopyToClipboard(manifest, copyBtn)
    }
  })
  document.getElementById('slackManifestCloseBtn').addEventListener('click', () => overlay.remove())
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove() })
}

// Wires the Slack manifest button in the agent channel panel.
// Uses agentApiName() to avoid coupling to the private currentAgent in agents.js.
export function initChannelSetup() {
  document.getElementById('chSlackManifestBtn')?.addEventListener('click', async () => {
    const name = agentApiName()
    if (!name) return
    const btn = document.getElementById('chSlackManifestBtn')
    btn.disabled = true
    try {
      const res = await fetch(`/api/agents/${encodeURIComponent(name)}/channels/slack/manifest`)
      if (!res.ok) throw new Error()
      const data = await res.json()
      showSlackManifestModal(data.manifest, data.instructions)
    } catch {
      showToast(t('channel.toast.manifest_failed'))
    } finally {
      btn.disabled = false
    }
  })
}

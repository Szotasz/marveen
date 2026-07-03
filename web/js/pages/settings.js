import { t } from '/js/core/i18n.js'
import { showToast } from '/js/core/ui.js'

// ============================================================
// === Settings (central config registry) ===
// ============================================================

document.getElementById('refreshSettingsBtn').addEventListener('click', loadSettings)
window.addEventListener('beforeunload', (e) => {
  if (settingsDirty.size > 0) { e.preventDefault(); e.returnValue = '' }
})

// Human label for a registry "module" -- falls back to a capitalised key for
// any future module the UI doesn't know about yet, so adding a registry
// entry never requires a frontend change just to render a sane heading.
function settingsModuleLabel(mod) {
  const key = `settings.module.${mod}`
  const known = { kanban: true, system: true, heartbeat: true, audit: true, ideabox: true }
  return known[mod] ? t(key) : (mod.charAt(0).toUpperCase() + mod.slice(1))
}

// Track dirty state: key -> { input, originalValue, type, errorEl }
const settingsDirty = new Map()

function updateSettingsSaveBar() {
  const bar = document.getElementById('settingsSaveBar')
  const countEl = document.getElementById('settingsDirtyCount')
  if (!bar) return
  const n = settingsDirty.size
  bar.style.display = n > 0 ? 'flex' : 'none'
  if (countEl) countEl.textContent = t('settings.dirty_count', {n})
}

function markSettingDirty(key, input, originalValue, type, errorEl) {
  const currentVal = type === 'color' ? input.value : input.value
  if (currentVal === String(originalValue)) {
    settingsDirty.delete(key)
  } else {
    settingsDirty.set(key, { input, originalValue, type, errorEl })
  }
  updateSettingsSaveBar()
}

async function loadSettings() {
  const container = document.getElementById('settingsGroups')
  container.innerHTML = `<p style="color:var(--text-muted);font-size:13px">${t('settings.loading')}</p>`
  settingsDirty.clear()
  updateSettingsSaveBar()

  try {
    const res = await fetch('/api/settings')
    if (!res.ok) throw new Error('fetch failed')
    const { settings } = await res.json()

    const byModule = new Map()
    for (const s of settings) {
      if (!byModule.has(s.module)) byModule.set(s.module, [])
      byModule.get(s.module).push(s)
    }

    container.innerHTML = ''
    if (byModule.size === 0) {
      container.innerHTML = `<p style="color:var(--text-muted);font-size:13px">${t('settings.empty')}</p>`
      return
    }

    for (const [mod, defs] of byModule) {
      const group = document.createElement('div')
      group.className = 'settings-group'

      const heading = document.createElement('h3')
      heading.className = 'settings-group-title'
      heading.textContent = settingsModuleLabel(mod)
      group.appendChild(heading)

      for (const def of defs) {
        group.appendChild(buildSettingRow(def))
      }
      container.appendChild(group)
    }
  } catch (err) {
    container.innerHTML = `<p style="color:var(--danger)">${t('settings.error')}</p>`
  }
}

function buildSettingRow(def) {
  const row = document.createElement('div')
  row.className = 'settings-row'

  const info = document.createElement('div')
  info.className = 'settings-row-info'

  const title = document.createElement('div')
  title.className = 'settings-row-key'
  title.textContent = def.key
  if (def.requiresRestart) {
    const badge = document.createElement('span')
    badge.className = 'settings-restart-badge'
    badge.textContent = t('settings.restart_badge')
    title.appendChild(badge)
  }
  info.appendChild(title)

  const desc = document.createElement('div')
  desc.className = 'settings-row-desc'
  desc.textContent = t('settings.desc.' + def.key) || def.description
  info.appendChild(desc)

  const meta = document.createElement('div')
  meta.className = 'settings-row-meta'
  const metaParts = []
  if (Array.isArray(def.valueSet) && def.valueSet.length) metaParts.push(t('settings.meta.values') + ': ' + def.valueSet.join(', '))
  if (def.type === 'int' && (def.min !== undefined || def.max !== undefined)) {
    metaParts.push(t('settings.meta.range') + ': ' + (def.min ?? '–') + '–' + (def.max ?? '–'))
  }
  if (def.type === 'color') metaParts.push(t('settings.meta.format') + ': #rrggbb')
  metaParts.push(t('settings.meta.default') + ': ' + def.default)
  meta.textContent = metaParts.join(' · ')
  info.appendChild(meta)

  row.appendChild(info)

  const editor = document.createElement('div')
  editor.className = 'settings-row-editor'

  const originalValue = String(def.value)
  let valueInput
  if (Array.isArray(def.valueSet) && def.valueSet.length) {
    valueInput = document.createElement('select')
    valueInput.className = 'input'
    for (const opt of def.valueSet) {
      const o = document.createElement('option')
      o.value = opt
      o.textContent = opt
      valueInput.appendChild(o)
    }
    valueInput.value = originalValue
  } else if (def.type === 'color') {
    valueInput = document.createElement('input')
    valueInput.type = 'color'
    valueInput.className = 'settings-color-input'
    valueInput.value = def.value
  } else if (def.type === 'int') {
    valueInput = document.createElement('input')
    valueInput.type = 'number'
    valueInput.className = 'input'
    if (def.min !== undefined) valueInput.min = def.min
    if (def.max !== undefined) valueInput.max = def.max
    valueInput.value = def.value
  } else {
    valueInput = document.createElement('input')
    valueInput.type = 'text'
    valueInput.className = 'input'
    valueInput.value = def.value
  }
  valueInput.dataset.settingKey = def.key
  valueInput.dataset.settingType = def.type
  valueInput.dataset.originalValue = originalValue
  editor.appendChild(valueInput)

  const errorEl = document.createElement('div')
  errorEl.className = 'settings-row-error'
  editor.appendChild(errorEl)

  valueInput.addEventListener('input', () => markSettingDirty(def.key, valueInput, originalValue, def.type, errorEl))
  valueInput.addEventListener('change', () => markSettingDirty(def.key, valueInput, originalValue, def.type, errorEl))

  row.appendChild(editor)
  return row
}

async function saveAllSettings() {
  if (settingsDirty.size === 0) return
  const btn = document.getElementById('settingsSaveAllBtn')
  if (btn) { btn.disabled = true; btn.textContent = t('settings.save_btn.saving') }

  const errors = []
  let needsRestart = false

  for (const [key, { input, type, errorEl }] of settingsDirty) {
    errorEl.textContent = ''
    const raw = type === 'int' ? Number(input.value) : input.value
    try {
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key, value: raw }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        errorEl.textContent = data.error || 'Hiba'
        errors.push(`${key}: ${data.error || 'hiba'}`)
      } else {
        input.dataset.originalValue = String(raw)
        if (data.requiresRestart) needsRestart = true
      }
    } catch {
      errorEl.textContent = 'Kapcsolati hiba'
      errors.push(`${key}: kapcsolati hiba`)
    }
  }

  // Remove successfully saved keys from dirty map
  for (const [key, { input }] of settingsDirty) {
    if (String(input.value) === input.dataset.originalValue) settingsDirty.delete(key)
  }
  updateSettingsSaveBar()

  if (btn) { btn.disabled = false; btn.textContent = t('settings.btn.save') }
  if (errors.length) {
    showToast(t('settings.toast.partial_error'), 'error')
  } else {
    showToast(needsRestart ? t('settings.toast.saved_restart') : t('settings.toast.saved'))
  }
}

function resetAllSettings() {
  for (const [key, { input, originalValue }] of settingsDirty) {
    input.value = originalValue
    const errorEl = document.querySelector(`[data-setting-key="${key}"]`)?.closest('.settings-row')?.querySelector('.settings-row-error')
    if (errorEl) errorEl.textContent = ''
  }
  settingsDirty.clear()
  updateSettingsSaveBar()
}

document.getElementById('settingsSaveAllBtn')?.addEventListener('click', saveAllSettings)
document.getElementById('settingsResetBtn')?.addEventListener('click', resetAllSettings)

export { loadSettings, settingsDirty }

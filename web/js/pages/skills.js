import { t } from '/js/core/i18n.js'
import { escapeHtml } from '/js/core/dom.js'
import { openModal, closeModal, setSkillModalScope } from '/js/core/ui.js'

// ============================================================
// === Skills Page ===
// ============================================================

const skillsGrid = document.getElementById('skillsGrid')
const skillsStats = document.getElementById('skillsStats')
const skillsEmpty = document.getElementById('skillsEmpty')
const skillDetailOverlay = document.getElementById('skillDetailOverlay')

let globalSkills = []

document.getElementById('skillDetailClose').addEventListener('click', () => closeModal(skillDetailOverlay))
skillDetailOverlay.addEventListener('click', (e) => { if (e.target === skillDetailOverlay) closeModal(skillDetailOverlay) })

// Scope for the next skill create/import action. 'global' means the
// Skills page opened the modal (write to ~/.claude/skills/); any other
// value (or null) falls back to the legacy per-agent flow keyed off
// `currentAgent`. Reset on modal close so a subsequent per-agent open
// cannot inherit the global scope.
// skillModalScope -> imported from /js/core/ui.js

// Wire the Skills-page "Új skill" button to reuse the same skillModalOverlay
// the per-agent Skill list uses. The save/import handlers branch on
// skillModalScope so we don't have to duplicate the modal markup.
const skillsPageNewBtn = document.getElementById('skillsPageNewBtn')
if (skillsPageNewBtn) {
  skillsPageNewBtn.addEventListener('click', () => {
    setSkillModalScope('global')
    document.getElementById('skillName').value = ''
    document.getElementById('skillDescription').value = ''
    skillFile = null
    document.getElementById('skillFileName').textContent = ''
    document.querySelectorAll('.skill-tab-btn').forEach(b => b.classList.toggle('active', b.dataset.skillTab === 'create'))
    document.getElementById('skillTabCreate').hidden = false
    document.getElementById('skillTabImport').hidden = true
    openModal(skillModalOverlay)
    setTimeout(() => document.getElementById('skillName').focus(), 200)
  })
}

async function loadGlobalSkills() {
  skillsGrid.innerHTML = `<div class="connector-loading"><span class="spinner"></span> ${t('skills.loading')}</div>`
  skillsStats.innerHTML = ''
  try {
    const res = await fetch('/api/skills')
    globalSkills = await res.json()
    renderGlobalSkills()
  } catch (err) {
    console.error('Skills betoltes hiba:', err)
    skillsGrid.innerHTML = `<div class="connector-loading">${t('skills.error')}</div>`
  }
}

function getSkillIcon(name) {
  if (name.includes('factory') || name.includes('creator')) return '\u{1F3ED}'
  if (name.includes('blog') || name.includes('post')) return '\u{1F4DD}'
  if (name.includes('image') || name.includes('thumbnail') || name.includes('fal')) return '\u{1F3A8}'
  if (name.includes('frontend') || name.includes('design')) return '\u{1F58C}\uFE0F'
  if (name.includes('youtube') || name.includes('video') || name.includes('seo')) return '\u{1F3AC}'
  if (name.includes('docx') || name.includes('doc')) return '\u{1F4C4}'
  if (name.includes('skool')) return '\u{1F393}'
  if (name.includes('skill')) return '\u{1F9E9}'
  return '\u2699\uFE0F'
}

function renderGlobalSkills() {
  skillsGrid.innerHTML = ''

  const withSkillMd = globalSkills.filter(s => s.description)
  const userCount = globalSkills.filter(s => s.source === 'user').length
  const pluginCount = globalSkills.filter(s => s.source === 'plugin').length

  skillsStats.innerHTML = `
    <div class="stat-card"><div class="stat-value">${globalSkills.length}</div><div class="stat-label">${t('skills.stat.total')}</div></div>
    <div class="stat-card"><div class="stat-value" style="color:var(--info)">${userCount}</div><div class="stat-label">${t('skills.stat.user')}</div></div>
    ${pluginCount ? `<div class="stat-card"><div class="stat-value" style="color:var(--accent)">${pluginCount}</div><div class="stat-label">${t('skills.stat.plugin')}</div></div>` : ''}
    <div class="stat-card"><div class="stat-value" style="color:var(--success)">${withSkillMd.length}</div><div class="stat-label">${t('skills.stat.documented')}</div></div>
  `

  if (globalSkills.length === 0) {
    skillsEmpty.hidden = false
    return
  }
  skillsEmpty.hidden = true

  const sourceLabels = { user: 'user', plugin: 'plugin' }

  for (const skill of globalSkills) {
    const card = document.createElement('div')
    card.className = 'skills-card'
    const icon = getSkillIcon(skill.name)
    const sourceBadge = skill.source
      ? `<span class="connector-source-badge">${escapeHtml(sourceLabels[skill.source] || skill.source)}</span>`
      : ''

    const displayName = skill.label || skill.name
    card.innerHTML = `
      <div class="skills-card-header">
        <div class="skills-card-icon">${icon}</div>
        <div class="skills-card-info">
          <div class="skills-card-name">${escapeHtml(displayName)} ${sourceBadge}</div>
          <div class="skills-card-desc">${escapeHtml(skill.description || t('skills.no_description'))}</div>
        </div>
      </div>
    `
    card.addEventListener('click', () => openSkillDetail(skill.name, skill.label))
    skillsGrid.appendChild(card)
  }
}

async function openSkillDetail(skillName, displayLabel) {
  document.getElementById('skillDetailTitle').textContent = displayLabel || skillName

  try {
    const res = await fetch(`/api/skills/${encodeURIComponent(skillName)}`)
    if (!res.ok) throw new Error('Failed to fetch skill detail')
    const detail = await res.json()

    // Description
    const descEl = document.getElementById('skillDetailDesc')
    descEl.textContent = detail.description || t('skills.no_description')

    // Meta line: source + path. Replaces the old per-agent assignment
    // UI -- sub-agents share the caller's HOME, so the skill is already
    // available to every agent without any copy-to-agent action.
    const metaEl = document.getElementById('skillDetailMeta')
    if (metaEl) {
      const sourceLabel = detail.source === 'plugin'
        ? `plugin${detail.pluginPackage ? ' (' + escapeHtml(detail.pluginPackage) + ')' : ''}`
        : detail.source === 'user'
        ? t('skills.source.user')
        : t('skills.source.unknown')
      metaEl.innerHTML = `
        <div class="skill-detail-source">${t('skills.detail.source_label')} <strong>${sourceLabel}</strong></div>
        <div class="skill-detail-note">${t('skills.detail.auto_available')}</div>
      `
    }

    // Content
    const contentEl = document.getElementById('skillDetailContent')
    contentEl.textContent = detail.content || t('skills.content_not_found')

  } catch (err) {
    console.error('Skill detail hiba:', err)
    document.getElementById('skillDetailDesc').textContent = t('connectors.error_list')
    document.getElementById('skillDetailContent').textContent = ''
    const metaEl = document.getElementById('skillDetailMeta')
    if (metaEl) metaEl.innerHTML = ''
  }

  openModal(skillDetailOverlay)
}

export { loadGlobalSkills }

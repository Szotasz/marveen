import { t } from './i18n.js'
import { showToast } from './toast.js'

function escapeHtml(str) {
  const d = document.createElement('div')
  d.textContent = str
  return d.innerHTML.replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

function escapeAttr(s) {
  return escapeHtml(String(s)).replace(/"/g, '&quot;')
}

// Minimal, dependency-free Markdown -> HTML renderer. Inputs come from the
// repo's own docs/ folder (trusted), but we HTML-escape everything anyway and
// only emit a fixed set of tags. Covers the constructs our docs use: fenced
// code, headings, hr, tables, ordered/unordered lists, blockquotes, paragraphs,
// and inline code/bold/italic/links.
function mdInline(text) {
  let s = escapeHtml(text)
  s = s.replace(/`([^`]+)`/g, (m, c) => '<code>' + c + '</code>')
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  s = s.replace(/\*([^*]+)\*/g, '<em>$1</em>')
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, txt, url) =>
    '<a href="' + escapeAttr(url) + '" target="_blank" rel="noopener noreferrer">' + txt + '</a>')
  return s
}

function renderMarkdown(md) {
  const lines = String(md).replace(/\r\n/g, '\n').split('\n')
  const out = []
  let i = 0
  const isBlockStart = (l) =>
    /^```/.test(l) || /^(#{1,6})\s/.test(l) || /^\s*[-*]\s+/.test(l) ||
    /^\s*\d+\.\s+/.test(l) || /^\s*\|.*\|\s*$/.test(l) || /^\s*>\s?/.test(l) ||
    /^\s*([-*_])\1{2,}\s*$/.test(l) || /^\s*$/.test(l)
  while (i < lines.length) {
    const line = lines[i]
    const fence = line.match(/^```(\w*)\s*$/)
    if (fence) {
      const code = []
      i++
      while (i < lines.length && !/^```\s*$/.test(lines[i])) { code.push(lines[i]); i++ }
      i++
      out.push('<pre><code' + (fence[1] ? ' class="language-' + escapeHtml(fence[1]) + '"' : '') + '>' + escapeHtml(code.join('\n')) + '</code></pre>')
      continue
    }
    const h = line.match(/^(#{1,6})\s+(.*)$/)
    if (h) { const lvl = h[1].length; out.push('<h' + lvl + '>' + mdInline(h[2].trim()) + '</h' + lvl + '>'); i++; continue }
    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) { out.push('<hr>'); i++; continue }
    if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length &&
        /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i + 1]) && lines[i + 1].includes('-')) {
      const parseRow = (r) => r.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim())
      const headers = parseRow(line)
      i += 2
      const rows = []
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) { rows.push(parseRow(lines[i])); i++ }
      let tbl = '<table><thead><tr>' + headers.map(c => '<th>' + mdInline(c) + '</th>').join('') + '</tr></thead><tbody>'
      for (const r of rows) tbl += '<tr>' + r.map(c => '<td>' + mdInline(c) + '</td>').join('') + '</tr>'
      tbl += '</tbody></table>'
      out.push(tbl)
      continue
    }
    if (/^\s*[-*]\s+/.test(line)) {
      const items = []
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) { items.push(lines[i].replace(/^\s*[-*]\s+/, '')); i++ }
      out.push('<ul>' + items.map(it => '<li>' + mdInline(it) + '</li>').join('') + '</ul>')
      continue
    }
    if (/^\s*\d+\.\s+/.test(line)) {
      const items = []
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) { items.push(lines[i].replace(/^\s*\d+\.\s+/, '')); i++ }
      out.push('<ol>' + items.map(it => '<li>' + mdInline(it) + '</li>').join('') + '</ol>')
      continue
    }
    if (/^\s*>\s?/.test(line)) {
      const q = []
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) { q.push(lines[i].replace(/^\s*>\s?/, '')); i++ }
      out.push('<blockquote>' + q.map(mdInline).join('<br>') + '</blockquote>')
      continue
    }
    if (/^\s*$/.test(line)) { i++; continue }
    const para = []
    while (i < lines.length && !isBlockStart(lines[i])) { para.push(lines[i]); i++ }
    if (para.length) out.push('<p>' + para.map(mdInline).join('<br>') + '</p>')
  }
  return out.join('\n')
}

// Shared with the Skills modal (skills.js) so both render markdown identically.
// Exported as a separate statement to keep the `function renderMarkdown`
// definition line intact (guarded by md-rendering-unify.test.ts).
export { renderMarkdown }

// Download a doc's raw markdown as a .md file (client-side Blob, no server).
function downloadMarkdown(name, content) {
  try {
    const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = /\.md$/.test(name) ? name : (name + '.md')
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  } catch (e) {
    showToast(t('common.toast.download_failed', { msg: String(e && e.message || e) }))
  }
}

// ============================================================
// === Docs (read-only viewer for the project's docs/ folder) ===
// ============================================================

export async function loadDocs() {
  const listEl = document.getElementById('docsList')
  const contentEl = document.getElementById('docsContent')
  if (!listEl) return
  listEl.innerHTML = '<p class="muted">' + t('docs.loading') + '</p>'
  let docs = []
  try {
    const res = await fetch('/api/docs')
    docs = await res.json()
    if (!Array.isArray(docs)) docs = []
  } catch (e) {
    listEl.innerHTML = '<p class="muted">' + t('docs.list_load_error') + ': ' + escapeHtml(String(e.message || e)) + '</p>'
    return
  }
  if (!docs.length) {
    listEl.innerHTML = '<p class="muted">' + t('docs.empty_list') + '</p>'
    if (contentEl) contentEl.innerHTML = '<p class="muted">' + t('docs.empty_content') + '</p>'
    return
  }
  listEl.innerHTML = docs.map(d =>
    '<a href="#" class="docs-list-item" data-doc="' + escapeAttr(d.name) + '">' +
      '<span class="docs-list-title">' + escapeHtml(d.title || d.name) + '</span>' +
      (d.created ? '<span class="docs-list-date">' + escapeHtml(d.created) + '</span>' : '') +
    '</a>'
  ).join('')
  listEl.querySelectorAll('.docs-list-item').forEach(a => {
    a.addEventListener('click', (e) => {
      e.preventDefault()
      listEl.querySelectorAll('.docs-list-item').forEach(x => x.classList.remove('active'))
      a.classList.add('active')
      openDoc(a.dataset.doc)
    })
  })
  const first = listEl.querySelector('.docs-list-item')
  if (first) { first.classList.add('active'); openDoc(first.dataset.doc) }
}

async function openDoc(name) {
  const contentEl = document.getElementById('docsContent')
  if (!contentEl) return
  contentEl.innerHTML = '<p class="muted">' + t('docs.loading') + '</p>'
  try {
    const res = await fetch('/api/docs/' + encodeURIComponent(name))
    if (!res.ok) throw new Error('HTTP ' + res.status)
    const doc = await res.json()
    const content = doc.content || ''
    contentEl.innerHTML =
      '<div class="docs-content-toolbar">' +
        '<button class="btn-secondary btn-compact" id="docsDownloadBtn">' + t('docs.download_btn') + '</button>' +
      '</div>' +
      '<div class="docs-rendered markdown-body md-rendered">' + renderMarkdown(content) + '</div>'
    const dl = document.getElementById('docsDownloadBtn')
    if (dl) dl.addEventListener('click', () => downloadMarkdown(name, content))
  } catch (e) {
    contentEl.innerHTML = '<p class="muted">' + t('docs.open_error') + ': ' + escapeHtml(String(e.message || e)) + '</p>'
  }
}

// ============================================================
// === Research (read-only viewer for each agent's research/ folder) ===
// Mirrors the Docs tab above, but the API groups docs by agent
// ([{agent, docs:[{name,title,updated}]}]), so the list needs a per-agent
// header and each item's dataset carries both agent+name for the detail
// fetch. Reuses escapeHtml/escapeAttr/renderMarkdown/downloadMarkdown as-is.
// ============================================================

export async function loadResearch() {
  const listEl = document.getElementById('researchList')
  const contentEl = document.getElementById('researchContent')
  if (!listEl) return
  listEl.innerHTML = '<p class="muted">' + t('research.loading') + '</p>'
  let groups = []
  try {
    const res = await fetch('/api/research')
    groups = await res.json()
    if (!Array.isArray(groups)) groups = []
  } catch (e) {
    listEl.innerHTML = '<p class="muted">' + t('research.list_load_error') + ': ' + escapeHtml(String(e.message || e)) + '</p>'
    return
  }
  if (!groups.length) {
    listEl.innerHTML = '<p class="muted">' + t('research.empty_list') + '</p>'
    if (contentEl) contentEl.innerHTML = '<p class="muted">' + t('research.empty_content') + '</p>'
    return
  }
  listEl.innerHTML = groups.map(g =>
    '<div class="docs-list-group-label">' + escapeHtml(g.agent) + '</div>' +
    g.docs.map(d =>
      '<a href="#" class="docs-list-item" data-agent="' + escapeAttr(g.agent) + '" data-doc="' + escapeAttr(d.name) + '">' +
        '<span class="docs-list-title">' + escapeHtml(d.title || d.name) + '</span>' +
        (d.updated ? '<span class="docs-list-date">' + escapeHtml(d.updated) + '</span>' : '') +
      '</a>'
    ).join('')
  ).join('')
  listEl.querySelectorAll('.docs-list-item').forEach(a => {
    a.addEventListener('click', (e) => {
      e.preventDefault()
      listEl.querySelectorAll('.docs-list-item').forEach(x => x.classList.remove('active'))
      a.classList.add('active')
      openResearchDoc(a.dataset.agent, a.dataset.doc)
    })
  })
  const first = listEl.querySelector('.docs-list-item')
  if (first) { first.classList.add('active'); openResearchDoc(first.dataset.agent, first.dataset.doc) }
}

async function openResearchDoc(agent, name) {
  const contentEl = document.getElementById('researchContent')
  if (!contentEl) return
  contentEl.innerHTML = '<p class="muted">' + t('research.loading') + '</p>'
  try {
    const res = await fetch('/api/research/' + encodeURIComponent(agent) + '/' + encodeURIComponent(name))
    if (!res.ok) throw new Error('HTTP ' + res.status)
    const doc = await res.json()
    const content = doc.content || ''
    contentEl.innerHTML =
      '<div class="docs-content-toolbar">' +
        '<button class="btn-secondary btn-compact" id="researchDownloadBtn">' + t('docs.download_btn') + '</button>' +
      '</div>' +
      '<div class="docs-rendered markdown-body">' + renderMarkdown(content) + '</div>'
    const dl = document.getElementById('researchDownloadBtn')
    if (dl) dl.addEventListener('click', () => downloadMarkdown(name, content))
  } catch (e) {
    contentEl.innerHTML = '<p class="muted">' + t('research.open_error') + ': ' + escapeHtml(String(e.message || e)) + '</p>'
  }
}

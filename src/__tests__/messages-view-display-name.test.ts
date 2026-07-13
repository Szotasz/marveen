import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

// Regression guard for #519/#520: the inter-agent Messages view must render the
// main agent's BOT_NAME display name, never its internal routing id (mainAgentId(),
// e.g. "marveen"). The original fix (PR #520) was later silently reverted by a
// refactor, so the raw slug leaked back into four display points -- the thread
// sidebar item, the thread header, the compose placeholder and the message-bubble
// sender label. This test pins both the behaviour of the display-name helpers and
// their wiring at the four render sites, so any future refactor that strips them
// fails CI instead of shipping the regression again.
const __dirname = dirname(fileURLToPath(import.meta.url))
const appJsPath = join(__dirname, '..', '..', 'web', 'app.js')
const src = readFileSync(appJsPath, 'utf8')

// Pull a top-level `function name(...) { ... }` body out of the source by brace
// matching, so we can evaluate the real shipped helper (not a copy) in isolation.
function extractFn(name: string): string | null {
  const re = new RegExp(`function ${name}\\s*\\([^)]*\\)\\s*\\{`)
  const m = re.exec(src)
  if (!m) return null
  let depth = 0
  for (let j = src.indexOf('{', m.index); j < src.length; j++) {
    if (src[j] === '{') depth++
    else if (src[j] === '}' && --depth === 0) return src.slice(m.index, j + 1)
  }
  return null
}

// Instantiate the real mainAgentDisplayName()/chatDisplayName() from source
// against a mock window + a stubbed mainAgentId(), so the assertions exercise the
// actual fallback chain the browser runs.
function loadHelpers(win: Record<string, unknown>, mainId: string) {
  const displayFn = extractFn('mainAgentDisplayName')
  const chatFn = extractFn('chatDisplayName')
  if (!displayFn || !chatFn) {
    throw new Error('mainAgentDisplayName/chatDisplayName missing from web/app.js -- #520 fix reverted')
  }
  const body = `
    function mainAgentId() { return MAIN_ID }
    ${displayFn}
    ${chatFn}
    return { mainAgentDisplayName, chatDisplayName }
  `
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  return new Function('window', 'MAIN_ID', body)(win, mainId) as {
    mainAgentDisplayName: () => string
    chatDisplayName: (name: string) => string
  }
}

describe('Messages view maps the main agent id to BOT_NAME (regression #519/#520)', () => {
  it('shows the BOT_NAME from /api/marveen for the main agent, not the routing id', () => {
    const { chatDisplayName } = loadHelpers({ _marveen: { name: 'Nova' } }, 'nova')
    expect(chatDisplayName('nova')).toBe('Nova')
  })

  it('passes every other agent id through unchanged (they already carry a human name)', () => {
    const { chatDisplayName } = loadHelpers({ _marveen: { name: 'Nova' } }, 'nova')
    expect(chatDisplayName('ysahyarik')).toBe('ysahyarik')
  })

  it('falls back to _brandTokens.bot when _marveen has not resolved yet', () => {
    const { chatDisplayName } = loadHelpers({ _brandTokens: { bot: 'Nova' } }, 'nova')
    expect(chatDisplayName('nova')).toBe('Nova')
  })

  it('falls back to the routing id when no brand info is available (no crash, no empty label)', () => {
    const { chatDisplayName } = loadHelpers({}, 'nova')
    expect(chatDisplayName('nova')).toBe('nova')
  })

  it('leaves a stock (unrenamed) install reading "Marveen", never the "marveen" slug', () => {
    const { chatDisplayName } = loadHelpers({ _marveen: { name: 'Marveen' } }, 'marveen')
    expect(chatDisplayName('marveen')).toBe('Marveen')
  })
})

describe('Messages view wiring: all four display points route through chatDisplayName', () => {
  it('the thread-sidebar item label uses chatDisplayName(name)', () => {
    expect(src).toMatch(/const displayName = owner && name === owner \? owner \+ ' \(te\)' : chatDisplayName\(name\)/)
  })

  it('the thread header label uses chatDisplayName(agentName)', () => {
    expect(src).toMatch(/const threadDisplayName = owner && agentName === owner \? owner \+ ' \(te\)' : chatDisplayName\(agentName\)/)
  })

  it('the compose placeholder uses chatDisplayName(agentName)', () => {
    expect(src).toMatch(/messages\.placeholder',\s*\{\s*agent:\s*escapeHtml\(chatDisplayName\(agentName\)\)/)
  })

  it('the message-bubble sender label renders senderLabel derived from chatDisplayName, not the raw id', () => {
    expect(src).toMatch(/const senderLabel = chatDisplayName\(senderName\)/)
    // The visible sender span must use the mapped label, never senderName/from_agent directly.
    expect(src).toMatch(/<span class="bubble-sender">\$\{escapeHtml\(senderLabel\)\}<\/span>/)
    expect(src).not.toMatch(/<span class="bubble-sender">\$\{escapeHtml\(senderName\)\}<\/span>/)
  })
})

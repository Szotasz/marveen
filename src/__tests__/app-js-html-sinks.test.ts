import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { CONTEXTS, RULES, allowKey, contextAt, scanAppJs, type Interp } from './helpers/app-js-sink-scan.js'
import { CSS_NAMED_COLORS, MAX_CSS_COLOR_LENGTH, normalizeCssColor, normalizeLabelColor } from '../css-color.js'
import { DEADLINE_MS, adversarialColourInputs, longWhitespaceRuns } from './helpers/css-color-adversarial.js'
import { parseFragment } from 'parse5'

// Stored-XSS guard for web/app.js.
// The connector detail modal rendered the env KEYS of an agent's, a project's
// or an external .mcp.json (routes/connectors.ts) raw into innerHTML, and a
// sweep of every HTML template found the same class elsewhere: server/file
// strings unescaped in text and attributes, esc() not quote-safe inside
// attributes, inline onclick handlers carrying an id in a quoted JS string,
// and markdown links with a javascript: scheme. The tests below run the REAL
// shipped functions (extracted by brace matching, as messages-view-display-name
// does) and pin the fixed render sites, so a refactor that drops an escape
// fails here instead of shipping.
const __dirname = dirname(fileURLToPath(import.meta.url))
const src = readFileSync(join(__dirname, '..', '..', 'web', 'app.js'), 'utf8')

function extractFn(name: string): string {
  const re = new RegExp(`(?:async\\s+)?function ${name}\\s*\\([^)]*\\)\\s*\\{`)
  const m = re.exec(src)
  if (!m) throw new Error(`${name} missing from web/app.js`)
  let depth = 0
  // count from the body's opening brace (a destructured default parameter
  // such as `{ relative = false } = {}` has braces of its own)
  for (let j = m.index + m[0].length - 1; j < src.length; j++) {
    if (src[j] === '{') depth++
    else if (src[j] === '}' && --depth === 0) return src.slice(m.index, j + 1)
  }
  throw new Error(`${name}: unbalanced braces`)
}

// The browser's textContent -> innerHTML serialization escapes & < > (not quotes),
// which is exactly what escapeHtml() builds on.
const fakeDocument = {
  createElement() {
    let text = ''
    return {
      set textContent(v: unknown) { text = v == null ? '' : String(v) },
      get innerHTML() { return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') },
    }
  },
}

function decodeEntities(s: string): string {
  return s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
}

const HELPERS = ['escapeHtml', 'esc', 'jsArg', 'escapeAttr', 'safeHref', 'safeCssColor', 'tHtml', 'escSnippet', 'mdInline']
// safeCssColor rests on the module-level colour block (CSS_NAMED_COLORS, the
// CSS_* regexes, normalizeCssColor): cut it out as one piece
const colorBlockStart = src.indexOf('const CSS_NAMED_COLORS = {')
const colorBlockEnd = src.indexOf('\n}\n', src.indexOf('function safeCssColor(')) + 3
if (colorBlockStart < 0 || colorBlockEnd < 3) throw new Error('colour block missing from web/app.js')
const colorBlock = src.slice(colorBlockStart, colorBlockEnd)
const helperSrc = HELPERS.filter(n => n !== 'safeCssColor').map(extractFn).join('\n') + '\n' + colorBlock

// The real i18n t() (defined inside app.js's first IIFE as window.t) with the
// real en/hu dictionaries, so translation interpolation is exercised as shipped.
function makeWindow(brand: Record<string, string>) {
  const win: Record<string, unknown> = { _lang: 'en', _brandTokens: brand }
  for (const l of ['en', 'hu']) new Function('window', langSrc[l])(win)
  // t() has a `{${k}}` template inside, which the brace matcher cannot count,
  // so it is cut at the end of its (two-space indented) body instead.
  const tStart = src.indexOf('window.t = function t(')
  const tEnd = src.indexOf('\n  }\n', tStart)
  if (tStart < 0 || tEnd < 0) throw new Error('window.t missing from web/app.js')
  const tSrc = src.slice(tStart + 'window.t = '.length, tEnd + 4)
  const t = new Function('window', 'localStorage', `return ${tSrc}`)(win, { getItem: () => null })
  win.t = t
  return win
}
const langSrc: Record<string, string> = Object.fromEntries(
  ['en', 'hu'].map(l => [l, readFileSync(join(__dirname, '..', '..', 'web', 'lang', `${l}.js`), 'utf8')]),
)

function loadHelpers(win: Record<string, unknown> = makeWindow({ brand: 'Marveen', bot: 'Marveen', agentId: 'marveen' })) {
  return new Function('document', 'window', 't', `${helperSrc}\nreturn { ${HELPERS.join(', ')} }`)(fakeDocument, win, win.t) as {
    escapeHtml: (s: unknown) => string
    esc: (s: unknown) => string
    jsArg: (s: unknown) => string
    escapeAttr: (s: unknown) => string
    safeHref: (s: unknown, o?: { relative?: boolean }) => string
    safeCssColor: (s: unknown, fallback?: string) => string
    tHtml: (key: string, params?: Record<string, unknown>) => string
    mdInline: (s: string) => string
    escSnippet: (s: unknown, max: number) => string
  }
}
const helpers = loadHelpers()

const PAYLOAD = `"><img src=x onerror=alert(1)>'`

describe('web/app.js escaping helpers', () => {
  it('esc() is quote-safe, so its output can sit inside an attribute', () => {
    const out = helpers.esc(PAYLOAD)
    expect(out).not.toMatch(/["'<>]/)
    expect(decodeEntities(out)).toBe(PAYLOAD)
  })

  it('esc() keeps its falsy contract', () => {
    expect(helpers.esc('')).toBe('')
    expect(helpers.esc(null)).toBe('')
    expect(helpers.esc(undefined)).toBe('')
  })

  it('jsArg() survives the attribute decode as ONE JS string literal', () => {
    for (const v of [PAYLOAD, `a');alert(1);('`, 'x\\"y', '</script>', 42]) {
      const attr = helpers.jsArg(v)
      expect(attr).not.toMatch(/["'<>]/)
      // what the browser hands to the JS parser after decoding the attribute
      const js = decodeEntities(attr)
      expect(new Function(`return ${js}`)()).toBe(String(v))
    }
  })

  it('mdInline() renders only http(s), mailto, site-relative and fragment links as anchors', () => {
    for (const url of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'data:text/html,x', 'vbscript:x', '//evil.example/x', '/\\evil.example/x', '\\\\evil.example', '\x01javascript:alert(1)', '\x1fjavascript:alert(1)', 'java\x0bscript:alert(1)']) {
      expect(helpers.mdInline(`[click](${url})`)).not.toContain('<a ')
    }
    for (const url of ['https://example.com/a?b=1&c=2', 'http://x.y', 'mailto:a@b.c', '/docs/x', '#top', 'heartbeat-autonomy.md', 'docs/x.md', './x', '../y']) {
      expect(helpers.mdInline(`[ok](${url})`)).toContain('<a href="')
    }
    // the href keeps the URL: & is encoded once, never twice
    expect(helpers.mdInline('[q](https://example.com/a?b=1&c=2)')).toContain('href="https://example.com/a?b=1&amp;c=2"')
    // a quote in the URL still cannot leave the attribute
    expect(helpers.mdInline('[q](https://x.y/a"onmouseover=alert(1))')).not.toMatch(/href="[^"]*"onmouseover/)
  })

  it('escapeAttr() stays usable for attributes (still referenced by renderers)', () => {
    expect(helpers.escapeAttr('a"b')).not.toContain('"')
  })
})

// URL-parser view of an href: the browser drops C0 controls and spaces, then
// reads the scheme. Used to check what an emitted href would really run as.
function schemeOf(href: string): string {
  const u = decodeEntities(href).replace(/[\x00-\x20\x7f]/g, '')
  const m = /^[a-z][a-z0-9+.-]*:/i.exec(u)
  return m ? m[0].toLowerCase() : (/^[\\/][\\/]/.test(u) ? 'protocol-relative' : 'relative')
}

describe('safeHref(): the one gate for data URLs', () => {
  const HOSTILE = ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', ' javascript:alert(1)', '\x01javascript:alert(1)',
    'java\tscript:alert(1)', 'java\nscript:alert(1)', 'data:text/html,<b>x', 'vbscript:x', 'blob:https://x/y', '//evil.example/x',
    '/\\evil.example', '\\\\evil.example', 'file:///etc/passwd', '']
  it('refuses every non-http(s)/mailto scheme and protocol-relative URLs', () => {
    for (const u of HOSTILE) {
      expect(helpers.safeHref(u)).toBe('')
      expect(helpers.safeHref(u, { relative: true })).toBe('')
    }
  })
  it('passes http(s) and mailto unchanged; relative only when asked', () => {
    for (const u of ['https://example.com/docs?a=1&b=2', 'http://x.y', 'mailto:a@b.c', 'HTTPS://X.Y']) expect(helpers.safeHref(u)).toBe(u)
    for (const u of ['/docs/x', 'docs/x.md', './x', '../y', '#top']) {
      expect(helpers.safeHref(u)).toBe('')
      expect(helpers.safeHref(u, { relative: true })).toBe(u)
    }
  })
  it('what passes, encoded for markup, parses as http(s)/mailto/relative', () => {
    for (const u of [...HOSTILE, 'https://a.b/"onmouseover=x', 'mailto:x@y.z']) {
      const out = helpers.escapeHtml(helpers.safeHref(u, { relative: true }))
      if (out) expect(['https:', 'http:', 'mailto:', 'relative']).toContain(schemeOf(out))
      expect(out).not.toMatch(/["<>]/)
    }
  })
})

describe('safeCssColor(): colours from data', () => {
  it('passes #hex and var(--token) as is; a colour name or numeric rgb()/hsl() comes back as hex', () => {
    for (const c of ['#fff', '#F59E0B', '#11223344', 'var(--accent)']) expect(helpers.safeCssColor(c)).toBe(c)
    expect(helpers.safeCssColor('red')).toBe('#ff0000')
    expect(helpers.safeCssColor('rebeccapurple')).toBe('#663399')
    expect(helpers.safeCssColor('rgb(1,2,3)')).toBe('#010203')
    expect(helpers.safeCssColor('hsl(180 50% 50%)')).toBe('#40bfbf')
  })

  it('the dashboard mirror of normalizeCssColor gives the server results on the shared vectors', () => {
    const mirror = new Function(`${colorBlock}\nreturn { normalizeCssColor, CSS_NAMED_COLORS }`)() as {
      normalizeCssColor: (v: unknown) => string | null
      CSS_NAMED_COLORS: Record<string, string>
    }
    const { vectors } = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'css-color-vectors.json'), 'utf8')) as { vectors: [unknown, string | null][] }
    for (const [input, expected] of vectors) {
      expect(mirror.normalizeCssColor(input), JSON.stringify(input)).toBe(expected)
      expect(mirror.normalizeCssColor(input), JSON.stringify(input)).toBe(normalizeCssColor(input))
    }
    // the same table, entry by entry
    expect(mirror.CSS_NAMED_COLORS).toEqual({ ...CSS_NAMED_COLORS })
  })

  it('the mirror does bounded work too: the length budget, linear trim / split', () => {
    const mirror = new Function(`${colorBlock}\nreturn { normalizeCssColor, safeCssColor, cssTrim, cssSplitWs, MAX_CSS_COLOR_LENGTH }`)() as {
      normalizeCssColor: (v: unknown) => string | null
      safeCssColor: (v: unknown, fallback?: string) => string
      cssTrim: (s: string) => string
      cssSplitWs: (s: string) => string[]
      MAX_CSS_COLOR_LENGTH: number
    }
    expect(mirror.MAX_CSS_COLOR_LENGTH).toBe(MAX_CSS_COLOR_LENGTH)
    for (const [name, input] of adversarialColourInputs()) {
      const t0 = performance.now()
      expect(mirror.normalizeCssColor(input), name).toBeNull()
      expect(mirror.safeCssColor(input, '#64748b'), name).toBe('#64748b')
      expect(performance.now() - t0, name).toBeLessThan(DEADLINE_MS)
    }
    for (const s of longWhitespaceRuns()) {
      const t0 = performance.now()
      expect(mirror.cssSplitWs(mirror.cssTrim(s))).toEqual(['a', 'b'])
      expect(performance.now() - t0).toBeLessThan(DEADLINE_MS)
    }
    expect(colorBlock).not.toMatch(/\.replace\(\/\^\[ \\t/)
    expect(colorBlock).not.toMatch(/\.split\(\/\[ \\t/)
    expect(colorBlock).not.toContain('(.*?)')
  })

  it('label colours that are not a colour get the default slate, never an empty chip', () => {
    expect(src).toContain("chip.style.setProperty('--chip-color', safeCssColor(label.color, '#64748b'))")
    expect(src).toContain("pill.style.setProperty('--label-color', safeCssColor(label.color, '#64748b'))")
    expect(helpers.safeCssColor('url(https://example.invalid/x)', '#64748b')).toBe('#64748b')
  })
  it('turns declarations, url() and quotes into the fallback', () => {
    for (const c of ['red;position:fixed;inset:0', 'red;background-image:url(https://example.invalid/x)', 'url(x)', '#fff"onmouseover=x',
      'expression(alert(1))', 'red !important', '#12', '#12345', '#1234567', 'var(--a);x:y', '', null, undefined]) {
      expect(helpers.safeCssColor(c, '#6b7280')).toBe('#6b7280')
    }
  })
  // a hex value followed (or preceded) by a line terminator: a multiline hex
  // regex would accept the first line and pass the payload through
  const hostileHex = ['#fff\n"><img src=x onerror=alert(1)>', '#fff\r"><img src=x onerror=alert(1)>',
    '#fff\u2028"><img src=x onerror=alert(1)>', '#fff\u2029"><img src=x onerror=alert(1)>',
    '#3b82f6\r\nred', '"><b>\n#fff', '#fff red']
  it('keeps a hex colour only as the whole value', () => {
    for (const c of hostileHex) {
      expect(helpers.safeCssColor(c, '#6b7280'), JSON.stringify(c)).toBe('#6b7280')
      expect(normalizeCssColor(c), JSON.stringify(c)).toBeNull()
      expect(normalizeLabelColor(c), JSON.stringify(c)).toBeNull()
    }
  })
  // var(--token) only as the whole value: a declaration before or after it,
  // a fallback argument or a second value is not a colour
  const hostileVars = ['x;background:url(//e) var(--a)', 'var(--a);background:url(//e);color:var(--b)', 'var(--a, url(x))', 'var(--a) red',
    'red;background-image:url(//e/x) var(--a)', 'var(--a)var(--b)', 'var(-a)', 'var(--a b)', 'var(--a\\;x)', 'var(--)',
    // a line terminator before the payload (a multiline regex would accept it)
    'var(--a)\n"><img src=x onerror=alert(1)>', 'var(--a)\r"><img src=x onerror=alert(1)>',
    'var(--a)\u2028"><img src=x onerror=alert(1)>', 'var(--a)\u2029"><img src=x onerror=alert(1)>',
    '"><img src=x onerror=alert(1)>\nvar(--a)', 'var(--a)\r\nred',
    // fallback-argument forms: a var() with a fallback is not a bare token
    'var(--a, red)', 'var(--a,red)', 'var(--a,"x)', "var(--a,'x)", 'var(--a,)', 'var(--a, #fff)', 'var(--a,"><img src=x onerror=alert(1)>)']
  it('keeps var(--token) only as the whole value', () => {
    for (const c of ['var(--accent)', ' var(--Kanban-ok) ', 'VAR(--a-1)']) expect(helpers.safeCssColor(c, '#6b7280')).toBe(c.trim())
    for (const c of hostileVars) expect(helpers.safeCssColor(c, '#6b7280')).toBe('#6b7280')
  })
  it('the server label colour policy agrees with the dashboard on var()', () => {
    for (const c of ['var(--accent)', ' var(--Kanban-ok) ', ...hostileVars]) {
      expect(normalizeLabelColor(c) ?? '#6b7280').toBe(helpers.safeCssColor(c, '#6b7280'))
    }
  })

  it('the label-colour sinks go through it', () => {
    expect(src).toContain("chip.style.setProperty('--chip-color', safeCssColor(label.color, '#64748b'))")
    expect(src).toContain('sw.style.backgroundColor = safeCssColor(color)')
  })
})

describe('escSnippet(): cut the raw text, then escape', () => {
  it('never splits an entity at the cut', () => {
    expect(helpers.escSnippet('a'.repeat(198) + '"', 200)).toBe('a'.repeat(198) + '&quot;')
    expect(helpers.escSnippet('a'.repeat(78) + '&', 80)).toBe('a'.repeat(78) + '&amp;')
    expect(helpers.escSnippet('a'.repeat(79) + '<b>', 80)).toBe('a'.repeat(79) + '&lt;…')
  })
  it('adds the ellipsis by the RAW length only', () => {
    expect(helpers.escSnippet('"'.repeat(200), 200)).toBe('&quot;'.repeat(200))
    expect(helpers.escSnippet('x'.repeat(201), 200)).toBe('x'.repeat(200) + '…')
    expect(helpers.escSnippet(null, 10)).toBe('')
  })
  it('the diary snippet and the child-card description use it', () => {
    expect(src).toContain("const contentSnippet = escSnippet((e.content || '').replace(/\\n/g, ' '), 200)")
    expect(src).toContain("' -- ' + escSnippet(ch.description, 80)")
  })
})

describe('catalogue documentation link', () => {
  it('a relative infoUrl stays a link, an executable one does not', () => {
    for (const u of ['/#docs', '#docs', '?page=docs', 'docs/x.md']) expect(helpers.safeHref(u, { relative: true })).toBe(u)
    expect(helpers.safeHref('javascript:alert(1)', { relative: true })).toBe('')
    expect(src).toContain('${safeHref(item.infoUrl, { relative: true }) ? `<a href="${escapeHtml(safeHref(item.infoUrl, { relative: true }))}"')
  })
})

describe('tHtml(): HTML translations with brand tokens', () => {
  const BRAND = '<img src=x onerror=alert(1)>'
  for (const key of ['connectors.builtin.computer_use_html', 'connectors.builtin.chrome_html']) {
    it(`${key}: a hostile BRAND_NAME / BOT_NAME stays text`, () => {
      for (const lang of ['en', 'hu']) {
        const win = makeWindow({ brand: BRAND, bot: BRAND, agentId: 'x' })
        win._lang = lang
        const h = loadHelpers(win)
        const html = h.tHtml(key)
        expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;')
        expect(html).not.toContain('<img')
        // the translation's own markup is kept
        expect(html).toMatch(/<p>|<code>/)
        // plain t() would have carried the markup -- the reason tHtml exists
        expect((win.t as (k: string) => string)(key)).toContain('<img')
      }
    })
  }
  it('escapes caller params too', () => {
    expect(helpers.tHtml('connectors.stale_banner', { msg: BRAND })).not.toContain('<img')
  })
})

// the text a browser shows for a piece of markup (character references decoded once)
function visibleText(markup: string): string {
  const walk = (n: { nodeName: string; value?: string; childNodes?: unknown[] }): string =>
    n.nodeName === '#text' ? n.value ?? '' : (n.childNodes ?? []).map(c => walk(c as typeof n)).join('')
  return walk(parseFragment(markup) as unknown as { nodeName: string; childNodes: unknown[] })
}

describe('connector stale banner', () => {
  // the shipped expression, evaluated with the real tHtml and lang strings
  const m = /banner\.innerHTML = (tHtml\('connectors\.stale_banner'[^\n]*)\n/.exec(extractFn('renderConnectors'))
  it('the banner shows the cache error text exactly once escaped', () => {
    expect(m).not.toBeNull()
    for (const lang of ['en', 'hu']) {
      const win = makeWindow({ brand: 'Marveen', bot: 'Marveen', agentId: 'marveen' })
      win._lang = lang
      const h = loadHelpers(win)
      const err = `Can't reach "a" & <b>x</b>`
      const html = new Function('tHtml', 'escapeHtml', 'connectorCacheError', `return ${m![1]}`)(h.tHtml, h.escapeHtml, err) as string
      expect(html).not.toContain('<b>')
      expect(visibleText(html)).toContain(err)
    }
  })
})

describe('label pills fall back to slate, never an empty colour', () => {
  // the .map callback of each pill site, run with the real helpers
  const sites: [string, RegExp][] = [
    ['createCardEl', /shown\.map\(\(l\) =>\s*(`[^`]*`)/],
    ['renderArchivedCard', /\.map\(l => (`[^`]*`)\)/],
    ['showArchivedDetail', /\.map\(l => (`[^`]*`)\)/],
  ]
  const win = makeWindow({ brand: 'Marveen', bot: 'Marveen', agentId: 'marveen' })
  it.each(sites)('%s', (fn, re) => {
    const m = re.exec(extractFn(fn))
    expect(m).not.toBeNull()
    const pill = (l: Record<string, unknown>) =>
      new Function('l', 'document', 'window', 't', `${helperSrc}\nreturn ${m![1]}`)(l, fakeDocument, win, win.t) as string
    // a colour syntax the policy does not parse, and a hostile value
    for (const color of ['oklch(70% 0.1 200)', 'red;background:url(//e)', '']) {
      expect(pill({ id: 'l1', name: 'n', color })).toContain('--label-color:#64748b"')
    }
    expect(pill({ id: 'l1', name: 'n', color: '#3b82f6' })).toContain('--label-color:#3b82f6"')
  })
})

describe('background task list', () => {
  // the map parameter used to be `t`, shadowing the i18n t(): every field read
  // came from the function instead of the task, so the rows lost their data
  async function renderTasks(tasks: Record<string, unknown>[]) {
    const els: Record<string, { innerHTML: string; checked?: boolean; value?: string }> = {
      bgTasksList: { innerHTML: '' }, bgShowAll: { innerHTML: '', checked: false }, bgAgent: { innerHTML: '', value: '' },
    }
    const doc = { ...fakeDocument, getElementById: (id: string) => els[id] }
    const fetchStub = async () => ({ ok: true, json: async () => tasks })
    const t = (k: string) => `T(${k})`
    const fn = new Function('document', 'fetch', 't', 'window', `${helperSrc}\n${extractFn('loadBgTasks')}\nreturn loadBgTasks`)(doc, fetchStub, t, {}) as () => Promise<void>
    await fn()
    return els.bgTasksList.innerHTML
  }

  it('renders every field of the task, not of the i18n function', async () => {
    const html = await renderTasks([{ id: 'task-7', status: 'done', agent_id: 'agent-x', prompt: 'summarise the inbox', started_label: '10:00',
      finished_label: '10:05', output: 'all good' }])
    for (const part of ['task-7', 'agent-x', 'summarise the inbox', '10:00', '10:05', 'all good', 'T(bgTasks.status.done)', 'T(bgTasks.finished_label)', '#22c55e']) {
      expect(html).toContain(part)
    }
    expect(html).not.toContain('undefined')
    expect(html).not.toContain('T(bgTasks.load_error)')
  })

  it('a running task gets its output / stop buttons; the fields are escaped', async () => {
    const html = await renderTasks([{ id: PAYLOAD, status: 'running', agent_id: PAYLOAD, prompt: PAYLOAD, started_label: PAYLOAD, finished_label: PAYLOAD }])
    expect(html).toContain('T(bgTasks.output_btn)')
    expect(html).toContain('T(bgTasks.stop_btn)')
    expect(html).toContain(`viewBgTask(${helpers.jsArg(PAYLOAD)})`)
    expect(html).not.toContain('<img')
  })
})

describe('vault scan row key', () => {
  it('server name and env key round-trip through the row key, even with "|"', () => {
    const key = JSON.stringify(['demo|part', 'API|TOKEN'])
    const attr = helpers.escapeHtml(key)
    expect(JSON.parse(decodeEntities(attr))).toEqual(['demo|part', 'API|TOKEN'])
    expect(src).toContain('const key = JSON.stringify([f.serverName, f.envVar])')
    expect(src).toContain('[serverName, envVar] = JSON.parse(key)')
    // the default vault id keeps the server|env form of the old row key; the
    // JSON row key is only the checkbox's data-key
    expect(src).toContain('const vaultId = vaultIdInput?.value?.trim() || `${serverName}|${envVar}`')
    expect(src).not.toContain("key.split('|')")
  })
})

describe('connector detail modal', () => {
  async function renderDetail(detail: Record<string, unknown>) {
    const els: Record<string, { innerHTML: string; textContent: string; onclick: unknown; appendChild: () => void }> = {}
    const doc = {
      ...fakeDocument,
      getElementById(id: string) {
        return (els[id] ??= { innerHTML: '', textContent: '', onclick: null, appendChild() {} })
      },
      querySelectorAll() { return [] },
    }
    const fetchStub = async (url: string) => ({
      json: async () => (url.startsWith('/api/connectors/') ? detail : []),
    })
    const fn = new Function(
      'document', 'fetch', 't', 'mainAgentId', 'openModal', 'connectorDetailOverlay',
      `${extractFn('escapeHtml')}\n${extractFn('openConnectorDetail')}\nreturn openConnectorDetail`,
    )(doc, fetchStub, (k: string) => k, () => 'main', () => {}, {}) as (c: { name: string }) => Promise<void>
    await fn({ name: 'demo' })
    return els.connectorDetailInfo.innerHTML
  }

  it('escapes the env KEYS and values from a .mcp.json', async () => {
    const html = await renderDetail({ status: 'unknown', scope: 'project:external/x', env: { [PAYLOAD]: '***' } })
    expect(html).not.toContain('<img')
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;')
  })

  it('escapes an unknown status (the label-map fallback)', async () => {
    const html = await renderDetail({ status: PAYLOAD, scope: 's' })
    expect(html).not.toContain('<img')
  })
})

describe('sink-level completeness of web/app.js', () => {
  const { strict, review } = scanAppJs(src, Object.values(langSrc))
  const allowlist = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'app-js-html-allowlist.json'), 'utf8')) as Record<string, string>
  const fmt = (r: Interp) => `app.js:${r.line} [${r.context}] ${allowKey(r)}`

  it('selectors, hrefs, inline handlers, styles and innerHTML=t( use their dedicated helper', () => {
    // no allowlist here: CSS.escape / escapeHtml(safeHref()) / jsArg / safeCssColor / tHtml
    expect(strict.map(fmt)).toEqual([])
  })

  it('every other interpolation into HTML is safe by construction or reviewed in the allowlist', () => {
    const missing = review.filter(r => !(allowKey(r) in allowlist)).map(fmt)
    expect(missing).toEqual([])
  })

  it('the allowlist has no stale entries and every entry carries a reason', () => {
    const seen = new Set(review.map(allowKey))
    expect(Object.keys(allowlist).filter(k => !seen.has(k))).toEqual([])
    expect(Object.entries(allowlist).filter(([, why]) => !/^SAFE-(NUM|CONST|PRE) \[n=\d+\]: \S/.test(why)).map(([k]) => k)).toEqual([])
    // the reason states its source: no back-reference to a neighbouring entry
    expect(Object.entries(allowlist).filter(([, why]) => { const body = why.replace(/^SAFE-\w+ \[n=\d+\]: /, ''); return body.length < 12 || /^(same|number|see above)\.?$/i.test(body) }).map(([k]) => k)).toEqual([])
  })

  it('an allowlist entry covers exactly the number of sites it was reviewed for', () => {
    // a third raw ${label} in a function where two were reviewed must fail
    const sites = new Map<string, number>()
    for (const r of review) sites.set(allowKey(r), (sites.get(allowKey(r)) || 0) + 1)
    const wrong = Object.entries(allowlist)
      .map(([k, why]) => [k, Number(/\[n=(\d+)\]/.exec(why)?.[1]), sites.get(k) || 0] as const)
      .filter(([, n, have]) => n !== have)
    expect(wrong).toEqual([])
  })

  it('an allowlist entry approves its own function and context only (key fn::context::expr)', () => {
    const code = [
      'function renderA() {', '  el.innerHTML = `<b>${label}</b>`', '}',
      'const renderB = (x) => {', '  el.innerHTML = `<b>${label}</b>`', '}',
    ].join('\n')
    const keys = scanAppJs(code, Object.values(langSrc)).review.map(allowKey)
    expect(keys.sort()).toEqual(['renderA::text::label', 'renderB::text::label'])
    // two functions of the same name, and the same value moved into an attribute
    const twice = 'function render() {\n  el.innerHTML = `<b>${label}</b>`\n}\nfunction render() {\n  el.innerHTML = `<b title="${label}">x</b>`\n}'
    expect(scanAppJs(twice, []).review.map(allowKey)).toEqual(['render::text::label', 'render#2::attr:title::label'])
    // a value printed through an identifier counts once per place it is printed
    const uses = 'function f(r) {\n  const v = r.a\n  el.innerHTML = `<b>${v}</b><i>${v}</i><u title="${v}">x</u>`\n}'
    expect(scanAppJs(uses, []).review.map(allowKey)).toEqual(['f::builder::r.a', 'f::builder::r.a', 'f::attr:title::r.a'])
  })

  it('function scopes: nested helpers, methods, function expressions, callbacks, comments', () => {
    const code = [
      'function outer() {',
      '  function helper() { return 1 }',
      '  el.innerHTML = `<b>${a1}</b>`',               // still outer after the helper closed
      '  // function fake() {',
      '  el.innerHTML = `<b>${a2}</b>`',               // a comment does not re-key
      '}',
      'window.render = function () {',
      '  el.innerHTML = `<b>${a3}</b>`',
      '}',
      'const obj = {',
      '  draw(x) {',
      '    el.innerHTML = `<b>${a4}</b>`',
      '  },',
      '}',
      "btn.addEventListener('click', () => {",
      '  el.innerHTML = `<b>${a5}</b>`',
      '})',
      'el.innerHTML = `<b>${a6}</b>`',
    ].join('\n')
    const keys = scanAppJs(code, Object.values(langSrc)).review.map(allowKey)
    expect(keys).toEqual([
      'outer::text::a1', 'outer::text::a2', 'render::text::a3', 'draw::text::a4',
      "cb:btn.addEventListener('click', () => {::text::a5", '(top)::text::a6',
    ])
  })

  // An identifier is resolved through its declaration: it is safe only if its
  // initializer AND every later assignment are safe. An escape at the
  // assignment site is therefore pinned by the scanner itself: unwrap it and
  // the site is reported at the unescaped value.
  it('an escape at an assignment site is pinned: unwrapping it is reported', () => {
    const scan = (code: string) => scanAppJs(code, Object.values(langSrc))
    const use = (init: string) => `function f(req) {\n  const name = ${init}\n  el.innerHTML = \`<b>#\${name}</b>\`\n}`
    expect(scan(use('escapeHtml(req.channel_name || req.channel_id)')).review).toEqual([])
    expect(scan(use('(req.channel_name || req.channel_id)')).review.map(allowKey)).toEqual(['f::builder::(req.channel_name || req.channel_id)'])
    // a later assignment counts as much as the initializer
    const reassigned = 'function f(req) {\n  let name = escapeHtml(req.a)\n  if (req.x) name = req.b\n  el.innerHTML = `<b>${name}</b>`\n}'
    expect(scan(reassigned).review.map(r => `${r.context} ${r.expr}`)).toEqual(['builder req.b'])
    // ... and so does an element pushed into an array that is joined
    const pushed = 'function f(xs) {\n  const out = []\n  out.push(`<b>${escapeHtml(xs.a)}</b>`)\n  out.push(xs.b)\n  el.innerHTML = out.join("")\n}'
    expect(scan(pushed).review.map(r => `${r.context} ${r.expr}`)).toEqual(['builder xs.b'])
    // a parameter, a destructured or loop binding is data
    for (const decl of ['function f(name) {', 'function f(d) {\n  const { name } = d', 'function f(xs) {\n  for (const name of xs)']) {
      expect(scan(`${decl}\n  el.innerHTML = \`<b>\${name}</b>\`\n}`).review.map(r => r.expr)).toEqual(['name'])
    }
    // the same value in an attribute is judged by the attribute's rule
    expect(scan('function f(d) {\n  const u = escapeHtml(d.url)\n  el.innerHTML = `<a href="${u}">x</a>`\n}').strict.map(r => r.context)).toEqual(['url:href'])
  })

  it('assignment-site escapes in web/app.js are proven by resolution, not by an allowlist reason', () => {
    for (const k of Object.keys(allowlist)) expect(k).not.toMatch(/^(refreshChannelRequests|renderMemories|chatMonogramEl)::[^:]+::(name|tierBadge|letter)$/)
    for (const [fn, decl] of [['refreshChannelRequests', 'const name = escapeHtml('], ['renderMemories', 'const tierBadge = escapeHtml('], ['chatMonogramEl', 'const letter = escapeHtml(']]) {
      expect(extractFn(fn)).toContain(decl)
      // unwrapped, the scanner reports the site
      const body = extractFn(fn)
      const at = body.indexOf(decl) + decl.length - 'escapeHtml('.length
      const mutated = src.replace(body, body.slice(0, at) + '(' + body.slice(at + 'escapeHtml('.length))
      const r = scanAppJs(mutated, Object.values(langSrc))
      expect(r.review.filter(x => !(allowKey(x) in allowlist)).map(x => x.fn)).toContain(fn)
    }
  })

  it('allowlist keys name the function and the expression, never a line number', () => {
    for (const [k, why] of Object.entries(allowlist)) {
      expect(k).toMatch(/^[^\n]+::[^\n]+$/)
      expect(`${k} ${why}`).not.toMatch(/app\.js:\d|\bline \d/)
    }
  })

  // [raw shape, where the scanner must put it, with which context]
  const PROBES: [string, 'strict' | 'review', string][] = [
    ['el.innerHTML = `<b>${server.name}</b>`', 'review', 'text'],
    ['el.innerHTML = `<a href="${escapeHtml(item.url)}">x</a>`', 'strict', 'url:href'],
    ["el.innerHTML = `<a href='${escapeHtml(item.url)}'>x</a>`", 'strict', 'url:href'],
    ['el.innerHTML = `<a href="/${escapeHtml(x)}">x</a>`', 'strict', 'url:href'],
    ['el.innerHTML = `<form action="${escapeHtml(x)}"></form>`', 'strict', 'url:action'],
    ['el.innerHTML = `<iframe srcdoc="${escapeHtml(x)}"></iframe>`', 'strict', 'srcdoc'],
    ['el.innerHTML = `<img src="${escapeHtml(x)}">`', 'review', 'url:src'],
    ["el.innerHTML = `<button onclick=\"go('${escapeHtml(id)}')\">x</button>`", 'strict', 'handler-arg-in-js-string'],
    ['el.innerHTML = `<span style="color:${escapeHtml(c)}">x</span>`', 'strict', 'style-escape-is-not-css-safe'],
    // a CSS value in markup is also HTML-escaped: a bare safeCssColor relies on its regex alone
    ['el.innerHTML = `<span style="color:${safeCssColor(c)}">x</span>`', 'strict', 'style-css-not-html-escaped'],
    ["el.innerHTML = `<span style=\"--x:${safeCssColor(c, '#fff')}\">x</span>`", 'strict', 'style-css-not-html-escaped'],
    ['el.innerHTML = `<span style="color:${a ? safeCssColor(c) : \'red\'}">x</span>`', 'strict', 'style-css-not-html-escaped'],
    ['el.innerHTML = `<svg><rect fill="${safeCssColor(c)}"/></svg>`', 'strict', 'style-css-not-html-escaped'],
    ["el.innerHTML = '<b style=\"color:' + safeCssColor(c) + '\">x</b>'", 'strict', 'style-css-not-html-escaped'],
    ['el.innerHTML = `<span style="color:${escapeHtml(safeCssColor(c) + data.x)}">x</span>`', 'strict', 'style-escape-is-not-css-safe'],
    // escapeHtml / esc must be the outermost call: any other wrapper around
    // safeCssColor is not HTML escaping (CSS.escape keeps '"' as '\"')
    ['el.innerHTML = `<b style="color:${CSS.escape(safeCssColor(c))}">x</b>`', 'strict', 'style-css-not-html-escaped'],
    ['el.innerHTML = `<b style="color:${encodeURIComponent(safeCssColor(c))}">x</b>`', 'strict', 'style-css-not-html-escaped'],
    ['el.innerHTML = `<b style="color:${safeCssColor(safeCssColor(c))}">x</b>`', 'strict', 'style-css-not-html-escaped'],
    ['el.innerHTML = `<b style="color:${unescapeHtml(safeCssColor(c))}">x</b>`', 'strict', 'style-css-not-html-escaped'],
    ['el.innerHTML = `<b style="color:${item.desc(safeCssColor(c))}">x</b>`', 'strict', 'style-css-not-html-escaped'],
    ["el.innerHTML = `<b style=\"color:${updateDesc(safeCssColor(c, '#fff'))}\">x</b>`", 'strict', 'style-css-not-html-escaped'],
    ['document.querySelector(`[data-id="${card.id}"]`)', 'strict', 'selector'],
    ['const sel = `option[value="${task.agent}"]`', 'strict', 'selector'],
    ["el.innerHTML = t('some.key')", 'strict', 'innerHTML=t('],
    ["  get detailHtml() { return t('connectors.builtin.chrome_html') },", 'strict', 'html-key-needs-tHtml'],
    ["el.innerHTML = '<i>' + label + '</i>'", 'review', 'concat'],
    ["el.innerHTML = '<p>' +\n  server.name +\n  '</p>'", 'review', 'concat'],
    ['el.innerHTML = `<b>${server.name + list.length}</b>`', 'review', 'text'],
    ['el.innerHTML = `<b>${server.name || `x`}</b>`', 'review', 'text'],
    ['el.innerHTML = `<b>${t(`k.${s}`, { n: raw })}</b>`', 'review', 'text'],
    ['el.innerHTML = `<b>${(server.name).toLocaleString()}</b>`', 'review', 'text'],
    ['el.innerHTML = `${server.name}`', 'review', 'text'],
    ['el.innerHTML = rawHtmlFromServer', 'review', 'innerHTML='],
    ["el.insertAdjacentHTML('beforeend', raw)", 'review', 'insertAdjacentHTML'],
    ['const fooHtml = serverText', 'review', '*Html='],
    ['a.href = data.url', 'review', '.href='],
    ['img.src = data.url', 'review', '.src='],
    ["el.setAttribute('href', data.url)", 'review', 'setAttribute(url)'],
    ['window.open(data.url)', 'review', 'window.open'],
    ["el.innerHTML = `<p>${t('updates.brand_subtitle')}</p>`", 'review', 'text'],
    ["el.innerHTML = `<p>${t('conversation.title', { name: agent.name })}</p>`", 'review', 'text'],
    // nested templates, builders, unquoted attrs, more sinks
    ['el.innerHTML = `<b class="${a ? `x-${evil}` : \'\'}">y</b>`', 'review', 'attr:class'],
    ['el.innerHTML = `<b>${a ? `${server.name}` : ""}</b>`', 'review', 'text'],
    ['el.innerHTML = `<i>${xs.map(x => `${x.name}, `).join("")}</i>`', 'review', 'text'],
    ['el.innerHTML = cond ? `${a.name}` : ""', 'review', 'text'],
    ['el.innerHTML = `<a style="${a ? `color:${escapeHtml(c)}` : \'\'}">x</a>`', 'strict', 'style-escape-is-not-css-safe'],
    ['function f() {\n  let html = ""\n  html += `${x.name}`\n  el.innerHTML = html\n}', 'review', 'text'],
    ['function f() {\n  let out = ""\n  out += row.name\n  box.innerHTML = out\n}', 'review', 'builder'],
    ['function f() {\n  const lines = []\n  lines.push(row.name)\n  box.innerHTML = lines.join("")\n}', 'review', 'builder'],
    ['el.innerHTML = `<a href=${escapeHtml(u)}>x</a>`', 'strict', 'unquoted-attr'],
    ['el.innerHTML = `<b onclick=${jsArg(u)}>x</b>`', 'strict', 'unquoted-attr'],
    ['el.innerHTML = `<b class=${escapeHtml(c)}>x</b>`', 'strict', 'unquoted-attr'],
    ['el.innerHTML = `<a ${x ? `href="${escapeHtml(evil)}"` : \'\'}>y</a>`', 'strict', 'url:href'],
    ['el.closest(`[data-id="${card.id}"]`)', 'strict', 'selector'],
    ["el.matches('[data-id=\"' + card.id + '\"]')", 'strict', 'selector'],
    ['location = data.next', 'review', 'location='],
    ['window.location.href = data.next', 'review', '.href='],
    ['frame.srcdoc = data.html', 'strict', 'script-sink'],
    ["el.setAttribute('style', data.css)", 'strict', 'script-sink'],
    ["el.setAttribute('onclick', data.js)", 'strict', 'script-sink'],
    ['el.style.cssText = `color:${escapeHtml(c)}`', 'strict', 'style-escape-is-not-css-safe'],
    ['el.style.cssText = data.css', 'review', 'style.cssText='],
    ["document.querySelector('[data-id=\"' + card.id + '\"]')", 'strict', 'selector'],
    ["el['innerHTML'] = data.html", 'review', 'innerHTML='],
    ['document.write(data.html)', 'review', 'document.write'],
    ['range.createContextualFragment(data.html)', 'review', 'createContextualFragment'],
    ["a.href = safeHref(x) || evil", 'review', '.href='],
    ['el.innerHTML = `<b>${String(Number(a) + b.name)}</b>`', 'review', 'text'],
    // CSS sinks set from script
    ["chip.style.setProperty('--chip-color', label.color)", 'strict', 'style-prop'],
    ['sw.style.background = color', 'strict', 'style-prop'],
    ['el.style.backgroundImage = data.img', 'strict', 'style-prop'],
    ['el.style.cursor = data.cursor', 'strict', 'style-prop'],
    ['el.style.color = data.color', 'review', 'style-prop'],
    ['el.style.background = `url(${data.img})`', 'strict', 'style-prop'],
    ["el.style.setProperty('--x', `${escapeHtml(c)}`)", 'strict', 'style-escape-is-not-css-safe'],
    // DOMParser, a sink whose value starts on the next line, *Html returns
    ["new DOMParser().parseFromString(data.html, 'text/html')", 'review', 'DOMParser'],
    ['el.innerHTML =\n  data.html', 'review', 'innerHTML='],
    ['function bodyHtml(x) {\n  return x\n}', 'review', 'return-of-*Html'],
    ['function bodyHtml(x) { return x }', 'review', 'return-of-*Html'],
    ['const rowHtml = (r) => r.name', 'review', 'return-of-*Html'],
    ['function cardHtml(c) {\n  return `${c.title}`\n}', 'review', 'text'],
    // more CSS sink shapes
    ['el.style.cssText += data.css', 'review', 'style.cssText='],
    ['el.style.background =\n  data.bg', 'strict', 'style-prop'],
    ['el.style[prop] = data.v', 'strict', 'style-prop'],
    ["el.style['backgroundImage'] = data.v", 'strict', 'style-prop'],
    ['el.style.setProperty(name, data.v)', 'strict', 'style-prop'],
    ["el.style.setProperty('--x', safeCssColor(a, b))", 'strict', 'style-prop'],
    ['el.style.clipPath = data.v', 'strict', 'style-prop'],
    ['Object.assign(el.style, data.styles)', 'strict', 'style-object'],
    ['sheet.insertRule(data.rule, 0)', 'strict', 'insertRule'],
    ["sheet.insertRule('.x{background:url(' + data.u + ')}', 0)", 'strict', 'insertRule'],
    ["el.style.setProperty('--w', '1px'); el.style.setProperty('--c', data.c)", 'strict', 'style-prop'],
    ['el.setAttribute(`style`, data.css)', 'strict', 'script-sink'],
    ['el.innerHTML = `<b style="color:${escSnippet(c, 9)}">x</b>`', 'strict', 'style-escape-is-not-css-safe'],
    ['el.innerHTML = `<b style="color:${jsArg(c)}">x</b>`', 'strict', 'style-escape-is-not-css-safe'],
    ['el.innerHTML = `<svg><rect fill="${escapeHtml(c)}"/></svg>`', 'strict', 'style-escape-is-not-css-safe'],
    ['el.innerHTML = `<svg><rect stroke="${data.c}"/></svg>`', 'review', 'style'],
    // every shape of its table
    ['el.style[prop] = `${data.value}`', 'strict', 'style-prop'],
    ['el.style.setProperty(prop, `${data.value}`)', 'strict', 'style-prop'],
    ["el.style.color = 'red'; el.style.background = data.color", 'strict', 'style-prop'],
    ["el.style.setProperty(\n  '--chip-color',\n  data.color)", 'strict', 'style-prop'],
    ["el.setAttribute('fill', data.color)", 'strict', 'style-prop'],
    ['el.style.background = data.length', 'strict', 'style-prop'],
    ['el.innerHTML = data.bodyHtml', 'review', 'innerHTML='],
    ["el.innerHTML = `<button onclick=\"go('${jsArg(id)}')\">x</button>`", 'strict', 'handler-arg-in-js-string'],
    ["el.innerHTML = `<a href='/api/items/${encodeURIComponent(id)}'>x</a>`", 'strict', 'single-quoted-attr'],
    ["el.innerHTML = '<a href=\"' + escapeHtml(data.url) + '\">x</a>'", 'strict', 'url:href'],
    ["el.innerHTML = '<b onclick=\"go(' + escapeHtml(id) + ')\">x</b>'", 'strict', 'handler'],
    ["el.innerHTML = '<b style=\"color:' + escapeHtml(c) + '\">x</b>'", 'strict', 'style-escape-is-not-css-safe'],
    ["el.innerHTML = '<a href=\"' +\n  escapeHtml(data.url) +\n  '\">x</a>'", 'strict', 'url:href'],
    ['el.style.fill = data.color', 'strict', 'style-prop'],
    // unquoted attributes with a literal prefix, <style> content
    ['el.innerHTML = `<div class=x-${escapeHtml(v)}>y</div>`', 'strict', 'unquoted-attr'],
    ['el.innerHTML = `<input title=x${escapeHtml(v)}>`', 'strict', 'unquoted-attr'],
    ["el.innerHTML = '<div class=x-' + escapeHtml(v) + '>y</div>'", 'strict', 'unquoted-attr'],
    ['el.innerHTML = `<b style=color:${escapeHtml(c)}>y</b>`', 'strict', 'unquoted-attr'],
    ['el.innerHTML = `<style>${escapeHtml(css)}</style>`', 'strict', 'style-escape-is-not-css-safe'],
    ['el.innerHTML = `<style>.a{color:${data.c}}</style>`', 'strict', 'style-prop'],
    // HTML attribute names, '=' in unquoted values, <style> via '+'
    ['el.innerHTML = `<div data-a1=${escapeHtml(v)}>y</div>`', 'strict', 'unquoted-attr'],
    ['el.innerHTML = `<div data_x=x${escapeHtml(v)}>y</div>`', 'strict', 'unquoted-attr'],
    ['el.innerHTML = `<a href=/x?id=${escapeHtml(v)}>y</a>`', 'strict', 'unquoted-attr'],
    ['el.innerHTML = `<input value=a=${escapeHtml(v)}>`', 'strict', 'unquoted-attr'],
    ['el.innerHTML = `<a href=a"${escapeHtml(v)}>y</a>`', 'strict', 'unquoted-attr'],
    ["el.innerHTML = '<style>.a{color:' + escapeHtml(v) + '}</style>'", 'strict', 'style-escape-is-not-css-safe'],
    ["el.innerHTML = `<button onclick=\"go('prefix-${jsArg(id)}')\">x</button>`", 'strict', 'handler-arg-in-js-string'],
    ['el.innerHTML = `<button onclick="go(&quot;p-${jsArg(id)}&quot;)">x</button>`', 'strict', 'handler-arg-in-js-string'],
    ["el.setAttribute('fill', `${data.color}`)", 'strict', 'style-prop'],
    ["el.setAttribute('href', `${data.url}`)", 'strict', 'url:href'],
    ["el.setAttribute('onclick', `go(${data.id})`)", 'strict', 'script-sink'],
    ['el.innerHTML = `<b>${data.length}</b>`', 'review', 'text'],
    ['el.innerHTML = `<b>${data.size}</b>`', 'review', 'text'],
    ["el.style.setProperty(\n  '--chip-color',\n\n  data.color\n)", 'strict', 'style-prop'],
    ["el.style.setProperty(\n  '--chip-color',\n  // the colour\n\n\n  data.color\n)", 'strict', 'style-prop'],
    ["if (a) el.setAttribute('href', data.url); else b()", 'review', 'setAttribute(url)'],
    ["{ el.setAttribute('href', data.url) }", 'review', 'setAttribute(url)'],
    ["el.setAttribute('href', data.url) // the docs link", 'review', 'setAttribute(url)'],
    ["el.setAttribute('poster', data.url)", 'review', 'setAttribute(url)'],
    // every call on a line
    ["a.setAttribute('href', safeHref(x)); b.setAttribute('href', data.url)", 'review', 'setAttribute(url)'],
    ["a.setAttribute('href', '/ok'); b.setAttribute('src', data.url)", 'review', 'setAttribute(url)'],
    ["el.style.setProperty('--c', data.c); el.style.setProperty('--d', safeCssColor(x))", 'strict', 'style-prop'],
    ["b) x(1) && el.style.setProperty(\n  '--chip-color', data.color)", 'strict', 'style-prop'],
    // complete entity decoding, complete calls / assignments
    // (no line window, no lookbehind), the assembled URL judged as a whole
    ["el.innerHTML = `<button onclick=\"go(&#x27;prefix-${jsArg(id)}&#x27;)\">x</button>`", 'strict', 'handler-arg-in-js-string'],
    ['el.innerHTML = `<button onclick="go(&#34;p-${jsArg(id)}&#34;)">x</button>`', 'strict', 'handler-arg-in-js-string'],
    ['el.innerHTML = `<button onclick="go(&#39p-${jsArg(id)}&#39)">x</button>`', 'strict', 'handler-arg-in-js-string'],
    ['el.innerHTML = `<button onclick="go(&#X27;p-${jsArg(id)}&#X27;)">x</button>`', 'strict', 'handler-arg-in-js-string'],
    ['el.innerHTML = `<button onclick="go(&#0000039;p-${jsArg(id)})">x</button>`', 'strict', 'handler-arg-in-js-string'],
    ['el.innerHTML = `<button onclick="go(&grave;p-${jsArg(id)})">x</button>`', 'strict', 'handler-arg-in-js-string'],
    ['el.innerHTML = `<button onclick="go(&QUOT;p-${jsArg(id)})">x</button>`', 'strict', 'handler-arg-in-js-string'],
    ["el.style.setProperty(\n  '--chip-color'," + '\n'.repeat(21) + "  data.color\n)", 'strict', 'style-prop'],
    ["el.style.setProperty(\n  '--chip-color'," + '\n'.repeat(500) + "  data.color\n)", 'strict', 'style-prop'],
    ["el.setAttribute('fill'," + ' '.repeat(100) + '`${data.color}`)', 'strict', 'style-prop'],
    ["el.setAttribute('href', `javascript:${safeHref(data.url)}`)", 'strict', 'url:href'],
    ["el.setAttribute('href', `//evil.example/${encodeURIComponent(x)}`)", 'strict', 'url:href'],
    ["el.setAttribute(\n  'onclick',\n  data.code\n)", 'strict', 'script-sink'],
    ["el['href'] = data.url", 'review', '.href='],
    ['el["src"] =\n  data.url', 'review', '.src='],
    ["el.setAttribute('HREF', data.url)", 'review', 'setAttribute(url)'],
    ["el.setAttribute(\n  'Href',\n  data.url\n)", 'review', 'setAttribute(url)'],
    ["el['onclick'] = data.code", 'strict', 'script-sink'],
    ["el['srcdoc'] = data.html", 'strict', 'script-sink'],
    ["el['style'] = data.css", 'strict', 'style-prop'],
    ['el.href =\n  data.url', 'review', '.href='],
    ["el.style['background'] =\n  data.bg", 'strict', 'style-prop'],
    ["el.style.background = a\n  + data.bg", 'strict', 'style-prop'],
    ['el.href = safeHref(a)\n  + data.url', 'review', '.href='],
    ['el.style.background = safeCssColor(c)\n  + data.bg', 'strict', 'style-prop'],
    ["el.setAttribute(name, data.value)", 'review', 'setAttribute(computed name)'],
    ["el.querySelector(" + ' '.repeat(200) + "`[data-id=\"${id}\"]`)", 'strict', 'selector'],
    ["el.style.background =" + ' '.repeat(200) + "`url(${data.u})`", 'strict', 'style-prop'],
    ["el.style.setProperty('--x', /* a comment */ `${data.c}`)", 'strict', 'style-prop'],
    // a regex after a keyword / a postfix ++, '/*/',
    // sinks inside a ${...} expression, ||= / ??= writes, el.style = x, ?.()
    ["function f(x) { return /'/.test(x) }\na.setAttribute('href', x)", 'review', 'setAttribute(url)'],
    ["if (a) b(); else /\"/.test(x)\na.setAttribute('onclick', x)", 'strict', 'script-sink'],
    ["async function f() { await /'/ }\nel.style.background = data.bg", 'strict', 'style-prop'],
    ['x = n++ / 2; el.style.background = data.bg', 'strict', 'style-prop'],
    ['/*/ a comment */ el.style.background = data.bg', 'strict', 'style-prop'],
    ["el.innerHTML = `${(el.setAttribute('onclick', x), '')}`", 'strict', 'script-sink'],
    ['x = `${(el.style.background = data.bg)}`', 'strict', 'style-prop'],
    ["x = `${items.map(i => { a.href = i.url; return '' })}`", 'review', '.href='],
    ["x = `a${(() => { el.setAttribute('href', data.u) })()}b`", 'review', 'setAttribute(url)'],
    ["x = `a${`b${el.style.setProperty('--c', data.c)}`}`", 'strict', 'style-prop'],
    ['el.href ||= data.url', 'review', '.href='],
    ['el.style.background ??= data.bg', 'strict', 'style-prop'],
    ['el.style = data.css', 'strict', 'style-prop'],
    ["el.setAttribute?.('onclick', x)", 'strict', 'script-sink'],
    ['a.style.background ||= `url(${data.u})`', 'strict', 'style-prop'],
    ["a.style['background'] ??= `${data.u}`", 'strict', 'style-prop'],
    ["if (x) /'/.test(y)\na.setAttribute('href', x)", 'review', 'setAttribute(url)'],
    ['x = obj. return / 2; el.style.background = data.bg', 'strict', 'style-prop'],
    // regex / division ambiguity: the parser decides, the sink after it is found
    ["if (ok) /'/.test(s); el.style.background = data.bg", 'strict', 'style-prop'],
    ['const ratio = {} / 2; el.style.background = data.bg; /x/.test(s)', 'strict', 'style-prop'],
    ['if (x) /\\/\\//.test(s) && (el.style.background = data.bg)', 'strict', 'style-prop'],
    ['if (x) /a\\/*b/.test(s) && (el.style.background = data.bg)', 'strict', 'style-prop'],
    ["if (x) { a() } /a\\//.test(y) && (el.innerHTML = '<i>' + x.name)", 'review', 'concat'],
    ["if (x) { y(); } /\\(/.test(s); el.setAttribute('onclick', v);", 'strict', 'script-sink'],
    ["if (x) /{/.test(s); el.style.background = v;", 'strict', 'style-prop'],
    ["if (x) /\\[/.test(s); el.setAttribute('onclick', v);", 'strict', 'script-sink'],
    ["if (x) /\\s+/.test(v); el.setAttribute('onclick', v);", 'strict', 'script-sink'],
    ["if (x) /\\(a/.test(s); el.setAttribute('onclick', v);", 'strict', 'script-sink'],
    // brackets inside a regex inside a sink argument; a syntax error is strict
    ["el.setAttribute('onclick', function () { if (x) { y() } /[)]/.test(s); return data.code }())", 'strict', 'script-sink'],
    ["el.style.setProperty('--c', function () { if (x) { y() } /\\)a/.test(s); return data.color }())", 'strict', 'style-prop'],
    ["el.setAttribute('onclick', function () { if (x) { y() } /\\)\\]\\(\\[a/.test(s); return data.code }())", 'strict', 'script-sink'],
    ["el.setAttribute('onclick', function () { if (x) /[)]/.test(s); return data.code }())", 'strict', 'script-sink'],
    ["el.style.setProperty('--c', function () { if (x) /[(]/.test(s); return data.color }())", 'strict', 'style-prop'],
    ['el.setAttribute(\'onclick\', go(a)', 'strict', 'parse-error'],
    ['if (x) { y() } /[(\\]]/.test(s); el.style.background = v;', 'strict', 'style-prop'],
    // a lone CR / U+2028 / U+2029 ends a line comment; an Annex B HTML-like
    // comment is a syntax error for the parser, so it fails closed
    ["// c\u2028el.setAttribute('onclick', v)", 'strict', 'script-sink'],
    ["// c\u2029el.setAttribute('onclick', v)", 'strict', 'script-sink'],
    ["// c\rel.setAttribute('onclick', v)", 'strict', 'script-sink'],
    ["x = 1 <!-- /*\nel.setAttribute('onclick', v)", 'strict', 'parse-error'],
    ["x = 1\n --> hidden\nel.setAttribute('onclick', v)", 'strict', 'parse-error'],
    ["if (x) /a//g ; el.setAttribute('onclick', v)", 'strict', 'script-sink'],
    ["if (x) {}\n/a/*b; el.setAttribute('onclick', v)", 'strict', 'script-sink'],
    ["let of = 4; x = of / 2; el.setAttribute('onclick', v); y = 2 / 1", 'strict', 'script-sink'],
    ["x = éreturn / 2; el.setAttribute('onclick', v); y = 2 / 1", 'strict', 'script-sink'],
    ["a / /'/.test(b); el.setAttribute('onclick', v); var z = 'x';", 'strict', 'script-sink'],
    ["c = b+++/'/.test(d); el.setAttribute('onclick', v);", 'strict', 'script-sink'],
    // a regex after return / typeof inside a '+' chain with markup
    ["h = '<b>' + x + '</b>'; return /* c */ /'/.test(s) + data.v + '<i>'", 'review', 'concat'],
    ["h = '<b>' + x + '</b>'; t = typeof /* c */ /'/ + data.v + '<i>'", 'review', 'concat'],
    ["if (x) /(?i:a)'/.test(s); el.style.background = d", 'strict', 'style-prop'],
    // a line / block comment between a postfix ++ and a division
    ['const r = n++ // c\n / 2; el.style.background = data.bg; /x/.test(s)', 'strict', 'style-prop'],
    ['const r = n++ /* /* */ / 2; el.style.background = data.bg; /x/.test(s)', 'strict', 'style-prop'],
    ['x = `${n++ // c\n / 2 + (el.style.background = data.bg, 1) + /x/.test(s)}`', 'strict', 'style-prop'],
    ['x = `${n++ /* /* */ / 2 + (el.style.background = data.bg, 1) + /x/.test(s)}`', 'strict', 'style-prop'],
    ["function f(s) {\n  return // c\n    /'/.test(s) || el.style.setProperty('--c', data.c)\n}", 'strict', 'style-prop'],
    ['if (x) { y() } /a+/.test(v); el.style.background = v;', 'strict', 'style-prop'],
    ["if (x) /a*/.test(v); el.setAttribute('href', 'javascript:' + v);", 'review', 'setAttribute(url)'],
    ['if (x) /a|b|/.test(v); el.style.background = v;', 'strict', 'style-prop'],
    ['if (x) /[a-z]=/i.test(v); el.style.background = v;', 'strict', 'style-prop'],
    ["const ratio = n++ /* c */ / 2; el.style.setProperty('--c', data.c); /x/.test(s)", 'strict', 'style-prop'],
    ['x = `${n++ /* c */ / 2 + (el.style.background = data.bg, 1) + /x/.test(s)}`', 'strict', 'style-prop'],
    // a name the browser does not decode keeps the string open
    ['el.innerHTML = `<button onclick="go(\'&APOS;${jsArg(id)}\')">x</button>`', 'strict', 'handler-arg-in-js-string'],
    ['el.innerHTML = `<button onclick="go(\'&apos=;${jsArg(id)}\')">x</button>`', 'strict', 'handler-arg-in-js-string'],
    ["function f(s) { return /* c */ /'/.test(s) || el.style.setProperty('--c', data.c) }", 'strict', 'style-prop'],
    ['el.style.background = `url(\n${data.u}\n)`', 'strict', 'style-prop'],
    ["function f(a) {\n  // see obj.\n  return /'/.test(a) || el.style.setProperty('--c', data.c)\n}", 'strict', 'style-prop'],
    // every operand is judged: && (right side), || / ?? / + (each side), an
    // escaper only as the whole leaf, map / join with a literal separator
    ['el.innerHTML = `<b>${x.n === 1 && x.name}</b>`', 'review', 'text'],
    ['el.innerHTML = `<b>${escapeHtml(x.a) + x.name}</b>`', 'review', 'text'],
    ['el.innerHTML = `<b>${escapeHtml(x.a) || x.name}</b>`', 'review', 'text'],
    ['document.querySelector(`[data-id="${escapeHtml(x.id)}"]`)', 'strict', 'selector'],
    ['el.innerHTML = `<button formaction="${escapeHtml(x.url)}">x</button>`', 'strict', 'url:formaction'],
    ['el.innerHTML = `<b style="${x.css + n.toFixed(1)}">x</b>`', 'review', 'style'],
    ['el.innerHTML = `<b>${x.name + xs.map(esc).join("")}</b>`', 'review', 'text'],
    ['el.innerHTML = `<a href="${escapeHtml(safeHref(x.u)) + x.raw}">x</a>`', 'strict', 'url:href'],
    ['el.innerHTML = `<b>${xs.map(esc).join(x.sep)}</b>`', 'review', 'text'],
    ['el.innerHTML = `<b>${CSS.escape(x.name)}</b>`', 'review', 'text'],
    // an operand on a continuation line is judged like one on the same line
    ['el.innerHTML = (x.a)\n  ? `<img>`\n  : x.name', 'review', 'innerHTML='],
    ['el.innerHTML = (x.a)\n  || x.name', 'review', 'innerHTML='],
    ['el.innerHTML = (x.a)\n  && x.name', 'review', 'innerHTML='],
    ['const tagHtml = x.label\n  ?? x.name', 'review', '*Html='],
    ['function rowHtml(x) {\n  return x.ok\n    ? `<b>ok</b>`\n    : x.name\n}', 'review', 'return-of-*Html'],
    ['el.innerHTML = xs.map(x => x.ok\n  ? `<b>ok</b>`\n  : x.name).join("")', 'review', 'text'],
    ['function f(card) {\n  const projectHtml = card.p\n    ? `<i>${escapeHtml(card.p)}</i>`\n    : card.p\n  el.innerHTML = `<b>${projectHtml}</b>`\n}', 'review', '*Html='],
    ['function f(a) {\n  const initial = a.label.charAt(0)\n  box.innerHTML = a.img\n    ? `<img src="/x">`\n    : initial\n}', 'review', 'builder'],
    ["el.innerHTML = '<p>' +\n  (ok\n    ? escapeHtml(x.a)\n    : x.name) +\n  '</p>'", 'review', 'concat'],
    // a local function is judged by what it returns, in the caller's context
    ['function label(x) { return x.name }\nel.innerHTML = `<b>${label(d)}</b>`', 'review', 'return'],
    ['function cls(x) { return escapeHtml(x.c) }\nel.innerHTML = `<a href="${cls(d)}">y</a>`', 'strict', 'url:href'],
    ['el.innerHTML = `<b>${(() => { return d.name })()}</b>`', 'review', 'return'],
    ['const row = (x) => `<li>${x.name}</li>`\nel.innerHTML = xs.map(row).join("")', 'review', 'text'],
    // the markup context comes from the HTML tokenizer: '>' inside an earlier
    // quoted value, an attribute after '/' or a closing quote, upper-case
    // names, tag / attribute-name positions, raw-text elements; markup-producing
    // helpers only as text; more sinks, writes and leaves
    ["el.innerHTML = `<a title=\"a>b\" href=\"${escapeHtml(x)}\">y</a>`", 'strict', 'url:href'],
    ["el.innerHTML = `<button title=\"a > b\" onclick=\"go(${escapeHtml(x)})\">y</button>`", 'strict', 'handler'],
    ["el.innerHTML = `<b onclick=\"list.map(v => v)\" onmouseover=\"go(${escapeHtml(x)})\">y</b>`", 'strict', 'handler'],
    ["el.innerHTML = `<b data-hint=\"a>b\" onclick=\"openIdeaEdit(${escapeHtml(idea.id)})\">y</b>`", 'strict', 'handler'],
    ["el.innerHTML = `<b title=\"${mdInline(x)}\">y</b>`", 'strict', 'html-in-attr'],
    ["el.innerHTML = `<b title=\"${renderMarkdown(x)}\">y</b>`", 'strict', 'html-in-attr'],
    ["el.innerHTML = `<b title=\"${tHtml('k.a_html')}\">y</b>`", 'strict', 'html-in-attr'],
    ["el.innerHTML = `<img/onerror=\"${escapeHtml(x.code)}\" src=x>`", 'strict', 'handler'],
    ["el.innerHTML = `<a class=\"c\"href=\"${escapeHtml(x.url)}\">y</a>`", 'strict', 'url:href'],
    ["el.innerHTML = `<a class=\"c\"onclick=\"${escapeHtml(x.code)}\">y</a>`", 'strict', 'handler'],
    ["el.innerHTML = `<a/href=\"${escapeHtml(x.url)}\">y</a>`", 'strict', 'url:href'],
    ["el.innerHTML = `<a class=\"tg-link\"href=\"${escapeHtml(inv.deepLink)}\">y</a>`", 'strict', 'url:href'],
    ["el.innerHTML = `<b style=\"cursor:pointer\"onclick=\"openIdeaDetail(${escapeHtml(idea.id)})\">y</b>`", 'strict', 'handler'],
    ["el.innerHTML = `<b style=\"margin-left:auto\"onclick=\"loadChatThread(&quot;${escapeHtml(agentName)}&quot;)\">y</b>`", 'strict', 'handler-arg-in-js-string'],
    ["el.innerHTML = `<img ${escapeHtml(x.a)}>`", 'strict', 'markup'],
    ["el.innerHTML = `<${x.tag}>y</b>`", 'review', 'markup'],
    ["el.innerHTML = `<script>var a = ${escapeHtml(x.a)}</script>`", 'strict', 'raw-text:script'],
    ["el.innerHTML = `<a HREF=\"${escapeHtml(x.u)}\">y</a>`", 'strict', 'url:href'],
    ["el.innerHTML = `<b ONCLICK=\"${escapeHtml(x.c)}\">y</b>`", 'strict', 'handler'],
    ["el.innerHTML = `<object data=\"${escapeHtml(x.u)}\"></object>`", 'strict', 'url:data'],
    ["el.innerHTML = `<svg><use xlink:href=\"${escapeHtml(x.u)}\"/></svg>`", 'strict', 'url:xlink:href'],
    ["el.innerHTML = `<b onclick=\"go('a\\\\'${jsArg(x)})\">y</b>`", 'strict', 'handler-arg-in-js-string'],
    ["function f(x) {\n  const u = x.u\n  el.innerHTML = `<b>${u}</b><a href=\"${u}\">y</a>`\n}", 'strict', 'url:href'],
    ["el.innerHTML = `<a href=\"${escapeHtml(safeHref(x.a))}/api/${escapeHtml(x.b)}\">y</a>`", 'strict', 'url:href'],
    ["el.outerHTML = x.html", 'review', 'innerHTML='],
    ["el.formAction = x.u", 'review', '.src='],
    ["location.assign(x.u)", 'review', 'location.assign'],
    ["window.location.replace(x.u)", 'review', 'location.assign'],
    ["function statusIcon(x) { return x.svg }", 'review', 'return-of-*Html'],
    ["const u = `javascript:${x.a}`; el.href = u", 'review', '.href='],
    ["function f(x) {\n  const a = []\n  a[0] = x.name\n  el.innerHTML = a.join('')\n}", 'review', 'builder'],
    ["function f(x) {\n  let n = 'a';\n  [n] = x.list\n  el.innerHTML = `<b>${n}</b>`\n}", 'review', 'text'],
    ["function f(x) {\n  let n = 'a';\n  ({ n } = x)\n  el.innerHTML = `<b>${n}</b>`\n}", 'review', 'text'],
    ["function f(x) {\n  let n = 'a'\n  for (n of x.list) ;\n  el.innerHTML = `<b>${n}</b>`\n}", 'review', 'text'],
    ["let fmt = () => 'a'\nfmt = x.f\nel.innerHTML = `<b>${fmt()}</b>`", 'review', 'text'],
    ["el.innerHTML = `<td bgcolor=\"${escapeHtml(x.c)}\">y</td>`", 'strict', 'style-escape-is-not-css-safe'],
    ["rows.push('</b>' + x.name)", 'review', 'concat'],
    ["rows.push('<!--' + x.name)", 'review', 'concat'],
    ["el.innerHTML = `<b>${x.f().length}</b>`", 'review', 'text'],
    ["el.innerHTML = `<b>${tr('k.a', x.fb)}</b>`", 'review', 'text'],
    ["el.innerHTML = `<b>${t('k.a', { ...x })}</b>`", 'review', 'text'],
    ["el.innerHTML = `<b>${escapeHtml(x.a).replace('a', x.b)}</b>`", 'review', 'text'],
    ["el.innerHTML = `<b>${t('agents.marveen_boss')}</b>`", 'review', 'text'],
    ["el.innerHTML = `<b>${t('agents.confirm.hard_restart')}</b>`", 'review', 'text'],
    ["el.innerHTML = `<b>${xs.map(String).join('')}</b>`", 'review', 'text'],
    ["el.innerHTML = `<b>${[].concat(x.more).join('')}</b>`", 'review', 'text'],
    ["el.innerHTML = `<b title=\"${xs.map(mdInline).join('')}\">y</b>`", 'review', 'attr:title'],
    // one use site reaching the same value in two contexts judges both
    ["function view(x) {\n  const u = x.u\n  return `<b>${u}</b><a href=\"${u}\">y</a>`\n}\nel.innerHTML = view(d)", 'strict', 'url:href'],
    ["function g(x) { return x.u }\nfunction view(x) { return `<b>${g(x)}</b><a href=\"${g(x)}\">y</a>` }\nel.innerHTML = view(d)", 'strict', 'url:href'],
    // a character reference left open before a value (the value's first
    // characters complete it); each raw-text element and script-data state;
    // each colour attribute; each part of the per-context memo key
    ["el.innerHTML = `<b onclick=\"go(&quot${jsArg(x.id)}&quot;)\">y</b>`", 'strict', 'char-ref-before-interpolation'],
    ["el.innerHTML = `<b onclick=\"go(&#39${jsArg(x.id)}&#39)\">y</b>`", 'strict', 'char-ref-before-interpolation'],
    ["el.innerHTML = `<b onclick=\"go(&#x27${jsArg(x.id)})\">y</b>`", 'strict', 'char-ref-before-interpolation'],
    ["el.innerHTML = `<b onclick=\"go(&apos${jsArg(x.id)})\">y</b>`", 'strict', 'char-ref-before-interpolation'],
    ["el.innerHTML = `<b onclick=\"go(&#34${jsArg(x.id)})\">y</b>`", 'strict', 'char-ref-before-interpolation'],
    ["el.innerHTML = `<b onclick=\"go(&#x22${jsArg(x.id)})\">y</b>`", 'strict', 'char-ref-before-interpolation'],
    ["el.innerHTML = `<span style=\"cursor:pointer\" onclick=\"openIdeaDetail(&#39${jsArg(idea.id)}&#39;)\">y</span>`", 'strict', 'char-ref-before-interpolation'],
    ["el.innerHTML = `<a href=\"&${x.u}\">y</a>`", 'strict', 'char-ref-before-interpolation'],
    ["el.innerHTML = `<b onclick=\"go(&#${x.u})\">y</b>`", 'strict', 'char-ref-before-interpolation'],
    ["el.innerHTML = `<p>a &${escapeHtml(x.u)}</p>`", 'strict', 'char-ref-before-interpolation'],
    ["el.innerHTML = `<xmp>${x.a}</xmp>`", 'strict', 'raw-text:xmp'],
    ["el.innerHTML = `<iframe>${x.a}</iframe>`", 'strict', 'raw-text:iframe'],
    ["el.innerHTML = `<noembed>${x.a}</noembed>`", 'strict', 'raw-text:noembed'],
    ["el.innerHTML = `<noframes>${x.a}</noframes>`", 'strict', 'raw-text:noframes'],
    ["el.innerHTML = `<noscript>${x.a}</noscript>`", 'strict', 'raw-text:noscript'],
    ["el.innerHTML = `<plaintext>${x.a}`", 'strict', 'raw-text:plaintext'],
    ["el.innerHTML = `<script>if (a<${x.n})</script>`", 'strict', 'raw-text:script'],
    ["el.innerHTML = `<script><!--${x.n}</script>`", 'strict', 'raw-text:script'],
    ["el.innerHTML = `<svg><stop stop-color=\"${escapeHtml(x.c)}\"/></svg>`", 'strict', 'style-escape-is-not-css-safe'],
    ["el.innerHTML = `<svg><feFlood flood-color=\"${escapeHtml(x.c)}\"/></svg>`", 'strict', 'style-escape-is-not-css-safe'],
    ["el.innerHTML = `<svg><feDiffuseLighting lighting-color=\"${escapeHtml(x.c)}\"/></svg>`", 'strict', 'style-escape-is-not-css-safe'],
    ["el.innerHTML = `<font color=\"${escapeHtml(x.c)}\">y</font>`", 'strict', 'style-escape-is-not-css-safe'],
    ["el.setAttribute('color', x.c)", 'review', 'style-prop'],
    ["el.setAttribute('flood-color', x.c)", 'review', 'style-prop'],
    ["function view(x) {\n  const u = jsArg(x.id)\n  return `<b onclick=\"go(${u})\">a</b><b onclick=\"go('${u}')\">b</b>`\n}\nel.innerHTML = view(d)", 'strict', 'handler-arg-in-js-string'],
    ["function view(x) {\n  const u = encodeURIComponent(x.id)\n  return `<a href=\"/p/${u}\">a</a><a href=\"${u}\">b</a>`\n}\nel.innerHTML = view(d)", 'strict', 'url:href'],
    ["function view(x) {\n  const u = encodeURIComponent(x.id)\n  return `<b title=\"${u}\">a</b><b title='${u}'>b</b>`\n}\nel.innerHTML = view(d)", 'strict', 'single-quoted-attr'],
    ["function view(x) {\n  const u = safeCssColor(x.c)\n  return `<style>.a{color:${u}}</style><script>${u}</script>`\n}\nel.innerHTML = view(d)", 'strict', 'raw-text:script'],
    // t() params that are not one object literal; markup only in a later '+' literal
    ['el.innerHTML = `<b>${t(`k.a_html`)}</b>`', 'strict', 'html-key-needs-tHtml'],
    ["el.innerHTML = `<b>${t('a.b', x.params)}</b>`", 'review', 'text'],
    ["el.innerHTML = `<b>${t('a.b', {n:1}, x.u)}</b>`", 'review', 'text'],
    ["s = 'Hi ' + x.u + '<br>'", 'review', 'concat'],
    // a "/path" URL template with several parts: every part judged; an
    // *_html key with params; setAttribute('stroke') is url-capable; a number
    // in a '+' chain keeps the markup context; wrappers around a nested or
    // second-argument safeCssColor in a style attribute
    ["el.setAttribute('href', `/a/${encodeURIComponent(x.id)}/${x.u}`)", 'strict', 'url:href'],
    ["el.setAttribute('href', `/a/${x.u}/${encodeURIComponent(x.id)}`)", 'strict', 'url:href'],
    ["el.href = `/a/${encodeURIComponent(x.id)}/${x.u}`", 'review', '.href='],
    ["window.open(`/a/${1}/${x.u}`)", 'review', 'window.open'],
    ["el.innerHTML = `<p>${t('k.a_html', { n: 1 })}</p>`", 'strict', 'html-key-needs-tHtml'],
    ["x.textContent = t('k.a_html', { n: 1 })", 'strict', 'html-key-needs-tHtml'],
    ["el.setAttribute('stroke', x.c)", 'strict', 'style-prop'],
    ["el.innerHTML = '<a onclick=\"go(' + 1 + x.id + ')\">a</a>'", 'strict', 'handler'],
    ["el.innerHTML = '<a href=\"' + 1 + x.u + '\">a</a>'", 'strict', 'url:href'],
    ["el.innerHTML = `<p style=\"color:${String(c ? safeCssColor(x.c) : 'red')}\">y</p>`", 'strict', 'style-css-not-html-escaped'],
    ["el.innerHTML = `<p style=\"color:${wrap(safeCssColor(x.c), 'a')}\">y</p>`", 'strict', 'style-css-not-html-escaped'],
    // escaped text cut afterwards
    ['el.innerHTML = `<p>${escapeHtml(d.text).slice(0, 80)}</p>`', 'strict', 'slice-after-escape'],
    ["x = esc(e.content || '').replace(/\\n/g, ' ').slice(0, 200)", 'strict', 'slice-after-escape'],
  ]
  it('reads the markup context from the parse5 tokenizer state', () => {
    expect(contextAt('<b>x</b> ')).toMatchObject({ kind: 'text' })
    expect(contextAt('<a href="')).toMatchObject({ kind: 'attr', name: 'href', quote: '"', value: '' })
    expect(contextAt("<a HREF='/x")).toMatchObject({ kind: 'attr', name: 'href', quote: "'", value: '/x' })
    expect(contextAt('<a href=')).toMatchObject({ kind: 'attr', quote: '' })
    expect(contextAt('<a href=x')).toMatchObject({ kind: 'attr', quote: '', value: 'x' })
    // '>' inside an earlier quoted value, '/' or a closing quote before a name
    expect(contextAt('<a title="a>b" href="')).toMatchObject({ kind: 'attr', name: 'href' })
    expect(contextAt('<a class="c"href="')).toMatchObject({ kind: 'attr', name: 'href' })
    expect(contextAt('<img/onerror="')).toMatchObject({ kind: 'attr', name: 'onerror' })
    // character references are decoded the way the browser does (one pass)
    expect(contextAt('<b onclick="go(&#39;')).toMatchObject({ value: "go('" })
    expect(contextAt('<b onclick="go(&amp;#39;')).toMatchObject({ value: 'go(&#39;' })
    expect(contextAt('<b onclick="go(&APOS;')).toMatchObject({ value: 'go(&APOS;' })
    // a reference still open when the markup ends is its own context
    for (const p of ['<b onclick="go(&#39', '<b onclick="go(&quot', '<b onclick="go(&#x27', '<a href="&', '<p>a &']) expect(contextAt(p).kind).toBe('charref')
    // positions where a value writes markup, raw-text elements, comments
    for (const p of ['<a ', '<a', '<', '<a href="x" ', '<img/']) expect(contextAt(p).kind).toBe('markup')
    expect(contextAt('<style>a{color:')).toMatchObject({ kind: 'raw', tag: 'style' })
    expect(contextAt('<script>x=')).toMatchObject({ kind: 'raw', tag: 'script' })
    expect(contextAt('<textarea>')).toMatchObject({ kind: 'text' })
    expect(contextAt('<!-- ')).toMatchObject({ kind: 'text' })
  })

  it.each(PROBES)('the scanner catches %s', (code, bucket, context) => {
    const r = scanAppJs(code, Object.values(langSrc))
    expect(r[bucket].map(x => x.context)).toContain(context)
  })

  it.each([
    'el.innerHTML = `<b>${escapeHtml(server.name)}</b>`',
    'el.innerHTML = `<a href="${escapeHtml(safeHref(u))}">x</a>`',
    'el.innerHTML = `<a href="/api/x/${encodeURIComponent(id)}">x</a>`',
    'el.innerHTML = `<b style="color:${escapeHtml(safeCssColor(c))}">${Number(n.length)}</b>`',
    "el.innerHTML = `<b style=\"color:${esc(safeCssColor(c, '#fff'))}\">x</b>`",
    'el.innerHTML = `<b style="width:${Number(w)}px">x</b>`',
    "el.innerHTML = `<i>${ok ? `<b>${escapeHtml(x)}</b>` : ''}</i>`",
    "el.innerHTML = `<i>${a && b ? 'x' : t('common.loading')}</i>`",
    'document.querySelector(`[data-id="${CSS.escape(String(id))}"]`)',
    "el.innerHTML = tHtml('connectors.builtin.chrome_html')",
    'el.innerHTML = `<td colspan=${Number(n)}>${escapeHtml(k)}=${escapeHtml(v)}</td>`',
    "chip.style.setProperty('--chip-color', safeCssColor(label.color))",
    'sw.style.backgroundColor = safeCssColor(color)',
    "el.style.display = on ? '' : 'none'",
    'el.innerHTML = `<p>${escSnippet(d.text, 80)}</p>`',
    'function bodyHtml(x) {\n  return `<b>${escapeHtml(x)}</b>`\n}',
    "el.style.setProperty('--x', safeCssColor(a, '#64748b'))",
    'el.innerHTML = `<svg><rect fill="${escapeHtml(safeCssColor(c))}" width="${Number(n.length)}"/></svg>`',
    "el.style.width = Math.round(w) + 'px'",
    "el.style.setProperty('--w', '1px'); foo(a, b)",
    "sheet.insertRule('.x{color:red}', 0)",
    "el.innerHTML = '<a href=\"' + escapeHtml(safeHref(u)) + '\">' + escapeHtml(t) + '</a>'",
    "el.innerHTML = '<b onclick=\"go(' + jsArg(id) + ')\">x</b>'",
    "el.style.color = 'red'; el.style.background = safeCssColor(c, '#64748b')",
    "el.setAttribute('fill', safeCssColor(c))",
    "el.innerHTML = `<b title='${escapeHtml(u)}'>x</b>`.replace('x', 'y')",
    "el.innerHTML = `<button onclick=\"go(${jsArg(id)}, 'x')\">x</button>`",
    "el.setAttribute('href', `${safeHref(u)}`)",
    "el.setAttribute('fill', `${safeCssColor(c)}`)",
    "el.setAttribute('title', `${data.t}`)",
    "el.setAttribute(\n  'href',\n  safeHref(u)\n)",
    "el['href'] = safeHref(u)",
    "el.setAttribute('HREF', '/x')",
    "el.setAttribute('href', `/api/x/${encodeURIComponent(id)}`)",
    "el.innerHTML = `<button onclick=\"go(${jsArg(id)}, &#x27;x&#x27;)\">x</button>`",
    'el.innerHTML = `<button onclick="go(&amp;#39;, ${jsArg(id)})">x</button>`',
    "el.style.setProperty(\n  '--w',\n\n  '1px'\n)",
    'node.data = payload',
    'el.href = safeHref(a)\nfoo(data.url)',
    "#!/usr/bin/env node\nel.style.color = 'red'",
    "el.innerHTML = `<!-- a note --><b>${escapeHtml(x)}</b>`\r\nel.style.color = 'red'",
    "x = n++ / 2 / 3; el.style.color = 'red'",
    "el.style = ''",
    'const half = (a + b) / 2 + (c) / 3; el.style.color = safeCssColor(c)',
    'const m = Math.round((Date.now() / 1000 - t) / 60)',
    'start = { x: clamp01((e.clientX - r.left) / r.width), y: clamp01((e.clientY - r.top) / r.height) }',
    'const q = (a) / b + c / d - (e) / 2 * f / 3',
    'const t = Math.floor(u / 36) / 5, e = Math.floor(C / 6) / 5',
    "const h = (a) / f(b / 2); el.style.color = 'red'",
    'const g = (a) / (b + c) / 2',
    'x = `${el.style.background = safeCssColor(c)} y`',
    'x = obj. return / 2; y = obj.in / 3',
    'el.href = `/api/x/\n${encodeURIComponent(id)}`',
    "x = `${a ? `<b>${escapeHtml(b)}</b>` : ''}`; y = (n-- / 2)",
    "el.style['color'] =\n  safeCssColor(c)",
    'el.innerHTML = (x.a)\n  ? `<img>`\n  : escapeHtml(x.name)',
    'function f(d) {\n  const name = escapeHtml(d.a || d.b)\n  el.innerHTML = `<b>#${name}</b>`\n}',
    'function f(xs) {\n  const out = []\n  for (const x of xs) out.push(`<li>${escapeHtml(x)}</li>`)\n  el.innerHTML = out.join("")\n}',
    'function label(x) { return escapeHtml(x.name) }\nel.innerHTML = `<b>${label(d)}</b>`',
    'el.innerHTML = `<b>${new Date(d.ts * 1000).toLocaleString()}</b>`',
    'el.innerHTML = `<b>${d.items.filter(Boolean).length}</b>`',
    'function f(d) {\n  const color = escapeHtml(safeCssColor(d.c))\n  el.innerHTML = `<b style="color:${color}">x</b>`\n}',
  ])('the scanner accepts the safe shape %s', code => {
    const r = scanAppJs(code, Object.values(langSrc))
    expect([...r.strict, ...r.review]).toEqual([])
  })
})

// Every entry of every rule table, and every context a finding can carry,
// has a generated probe: an entry that stops working, a new entry, a new
// table or a new context without a probe fails here.
type Expect = { bucket: 'strict' | 'review'; context: string } | 'none' | { not: string }
type Probe = { code: string; expect: Expect; langs?: string[] }
const call = (name: string, args: string) => (name.startsWith('?.') ? `el.${name.slice(2)}(${args})` : `${name.replace('Math.*', 'Math.round')}(${args})`)
const fn = (name: string) => name.replace('Math.*', 'Math.round')
const strictP = (code: string, context: string): Probe => ({ code, expect: { bucket: 'strict', context } })
const reviewP = (code: string, context: string): Probe => ({ code, expect: { bucket: 'review', context } })
const noneP = (code: string): Probe => ({ code, expect: 'none' })
const CSS_SAFE_ESCAPERS = ['safeCssColor', 'Number', 'parseInt', 'parseFloat', 'Math.*']
const GENERATORS: { [K in keyof typeof RULES]: (entry: string) => Probe[] } = {
  urlProps: p => [strictP(`el.style['${p.replace('*', 'x')}'] = x.c`, 'style-prop')],
  urlAttrs: a => [(a === 'src' || a === 'poster' ? reviewP : strictP)(`el.innerHTML = \`<x ${a}="\${escapeHtml(x.u)}">y</x>\``, `url:${a}`)],
  cssAttrs: a => [strictP(`el.innerHTML = \`<x ${a}="\${escapeHtml(x.c)}">y</x>\``, 'style-escape-is-not-css-safe')],
  rawText: t => [t === 'style' ? strictP('el.innerHTML = `<style>${x.a}`', 'style-prop')
    : t === 'textarea' || t === 'title' ? noneP(`el.innerHTML = \`<${t}><a href="\${escapeHtml(x.u)}">\``)
      : strictP(`el.innerHTML = \`<${t}>\${x.a}\``, `raw-text:${t}`)],
  urlWriteProps: w => [reviewP(`el.${w} = x.u`, w === 'href' ? '.href=' : '.src='), reviewP(`el['${w}'] = x.u`, w === 'href' ? '.href=' : '.src=')],
  urlWriteBracketProps: w => [reviewP(`el['${w}'] = x.u`, '.src=')],
  htmlSinkProps: w => [reviewP(`el.${w} = x.h`, 'innerHTML='), reviewP(`el['${w}'] = x.h`, 'innerHTML=')],
  htmlSinkCalls: c => [reviewP(call(c, TABLES.htmlSinkCalls[c][0] === 1 ? "'beforeend', x.h" : "x.h, 'text/html'"), TABLES.htmlSinkCalls[c][1])],
  scriptAttrs: a => [strictP(`el.setAttribute('${a.replace('*', 'click')}', x.v)`, 'script-sink')],
  scriptProps: w => [strictP(`el.${w} = x.v`, 'script-sink'), strictP(`el['${w}'] = x.v`, 'script-sink')],
  scriptBracketProps: w => [strictP(`el['${w.replace('*', 'click')}'] = x.v`, 'script-sink')],
  // (not an attribute selector: the catch-all would flag that template anyway)
  selectorCalls: c => [strictP(call(c, '`#${x.id}`'), 'selector')],
  cutMethods: m => [strictP(`x.s = escapeHtml(x.u).${m}(0, 5)`, 'slice-after-escape')],
  cutEscapers: e => [strictP(`x.s = ${e}(x.u).slice(0, 5)`, 'slice-after-escape')],
  brandTokens: b => [{ code: "el.innerHTML = `<b>${t('k.a')}</b>`", expect: { bucket: 'review', context: 'text' }, langs: [`'k.a': 'x {${b}}',`] }],
  numberFns: f => [noneP(`el.innerHTML = \`<td colspan=\${${fn(f)}(x.a)}>y</td>\``)],
  escapers: e => [
    e === 'CSS.escape' ? reviewP(`el.innerHTML = \`<b>\${${e}(x.a)}</b>\``, 'text') : noneP(`el.innerHTML = \`<b>\${${fn(e)}(x.a)}</b>\``),
    CSS_SAFE_ESCAPERS.includes(e) ? noneP(`el.style.setProperty('--x', \`\${${fn(e)}(x.a)}\`)`)
      : strictP(`el.style.setProperty('--x', \`\${${fn(e)}(x.a)}\`)`, 'style-escape-is-not-css-safe'),
  ],
  quoteSafe: q => [noneP(`el.innerHTML = \`<b title='\${${fn(q)}(x.a)}'>y</b>\``)],
  htmlOut: h => [strictP(`el.innerHTML = \`<b title="\${${h}(x.a)}">y</b>\``, 'html-in-attr')],
  notHtmlFns: h => [{ code: `function ${h}(s) { return s }`, expect: { not: 'return-of-*Html' } }],
  trustedByName: h => [{ code: `function ${h}(k) { return d.a }\nel.innerHTML = \`<b>\${${h}('k.a')}</b>\``, expect: { not: 'return' } }],
}
const CONTEXT_PROBES: Record<string, Probe> = {
  'parse-error': strictP('el.setAttribute(', 'parse-error'),
  'text': reviewP('el.innerHTML = `<b>${x.a}</b>`', 'text'),
  'concat': reviewP("el.innerHTML = '<b>' + x.a", 'concat'),
  'builder': reviewP("function f(x) {\n  let h = ''\n  h += x.a\n  el.innerHTML = h\n}", 'builder'),
  'return': reviewP('function g(x) { return x.a }\nel.innerHTML = `<b>${g(d)}</b>`', 'return'),
  'innerHTML=': reviewP('el.innerHTML = x.a', 'innerHTML='),
  'innerHTML=t(': strictP("el.innerHTML = t('k.a')", 'innerHTML=t('),
  '*Html=': reviewP('const aHtml = x.a', '*Html='),
  'return-of-*Html': reviewP('function aHtml(x) { return x.a }', 'return-of-*Html'),
  'insertAdjacentHTML': reviewP("el.insertAdjacentHTML('beforeend', x.h)", 'insertAdjacentHTML'),
  'document.write': reviewP('document.write(x.h)', 'document.write'),
  'createContextualFragment': reviewP('r.createContextualFragment(x.h)', 'createContextualFragment'),
  'DOMParser': reviewP("p.parseFromString(x.h, 'text/html')", 'DOMParser'),
  'attr:*': reviewP('el.innerHTML = `<b title="${x.a}">y</b>`', 'attr:title'),
  'url:*': strictP('el.innerHTML = `<a href="${x.u}">y</a>`', 'url:href'),
  'raw-text:*': strictP('el.innerHTML = `<script>${x.a}`', 'raw-text:script'),
  'markup': reviewP('el.innerHTML = `<b ${x.a}>y</b>`', 'markup'),
  // a number completes '&#' into any code point ('&#39' is a quote)
  'char-ref-before-interpolation': strictP('el.innerHTML = `<b onclick="go(&#${Number(x.n)})">y</b>`', 'char-ref-before-interpolation'),
  'html-in-attr': strictP('el.innerHTML = `<b title="${mdInline(x.a)}">y</b>`', 'html-in-attr'),
  'unquoted-attr': strictP('el.innerHTML = `<b title=${escapeHtml(x.a)}>y</b>`', 'unquoted-attr'),
  'srcdoc': strictP('el.innerHTML = `<iframe srcdoc="${escapeHtml(x.a)}"></iframe>`', 'srcdoc'),
  'single-quoted-attr': strictP("el.innerHTML = `<b title='${encodeURIComponent(x.a)}'>y</b>`", 'single-quoted-attr'),
  'handler-arg-in-js-string': strictP("el.innerHTML = `<b onclick=\"go('${jsArg(x.a)}')\">y</b>`", 'handler-arg-in-js-string'),
  'handler': strictP('el.innerHTML = `<b onclick="go(${escapeHtml(x.a)})">y</b>`', 'handler'),
  'style': reviewP('el.innerHTML = `<b style="color:${x.c}">y</b>`', 'style'),
  'style-prop': strictP('el.style.background = x.c', 'style-prop'),
  'style-escape-is-not-css-safe': strictP('el.innerHTML = `<b style="color:${escapeHtml(x.c)}">y</b>`', 'style-escape-is-not-css-safe'),
  'style-css-not-html-escaped': strictP('el.innerHTML = `<b style="color:${safeCssColor(x.c)}">y</b>`', 'style-css-not-html-escaped'),
  'style.cssText=': reviewP('el.style.cssText = x.c', 'style.cssText='),
  'style-object': strictP('Object.assign(el.style, x.s)', 'style-object'),
  'insertRule': strictP('sheet.insertRule(x.r)', 'insertRule'),
  '.href=': reviewP('el.href = x.u', '.href='),
  '.src=': reviewP('el.src = x.u', '.src='),
  'location=': reviewP('location = x.u', 'location='),
  'location.assign': reviewP('location.assign(x.u)', 'location.assign'),
  'window.open': reviewP('window.open(x.u)', 'window.open'),
  'setAttribute(url)': reviewP("el.setAttribute('href', x.u)", 'setAttribute(url)'),
  'setAttribute(computed name)': reviewP('el.setAttribute(n, x.v)', 'setAttribute(computed name)'),
  'script-sink': strictP("el.setAttribute('onclick', x.v)", 'script-sink'),
  'selector': strictP('document.querySelector(`#${x.id}`)', 'selector'),
  'html-key-needs-tHtml': strictP('const s = t(el.dataset.i18nHtml)', 'html-key-needs-tHtml'),
  'slice-after-escape': strictP('x.s = escapeHtml(x.u).substring(0, 5)', 'slice-after-escape'),
}
// The test's own copy of the rule tables: probes are generated from it, and
// it must equal RULES, so removing an entry there or adding one without a
// probe both fail.
const TABLES: typeof RULES = {
  urlProps: ['background', 'backgroundImage', 'cursor', 'content', 'listStyle', 'listStyleImage', 'borderImage', 'borderImageSource', 'mask',
    'maskImage', 'webkitMaskImage', 'filter', 'backdropFilter', 'shapeOutside', 'clipPath', 'maskBorder', 'maskBorderSource', 'webkitMaskBoxImage',
    'offsetPath', 'background-image', 'list-style', 'list-style-image', 'border-image', 'border-image-source', 'mask-image', 'mask-border',
    'mask-border-source', 'backdrop-filter', 'shape-outside', 'clip-path', 'offset-path', 'fill', 'stroke', '--*'],
  urlAttrs: ['href', 'src', 'action', 'formaction', 'xlink:href', 'poster', 'data'],
  cssAttrs: ['style', 'fill', 'stroke', 'stop-color', 'flood-color', 'lighting-color', 'color', 'bgcolor'],
  rawText: ['style', 'xmp', 'iframe', 'noembed', 'noframes', 'noscript', 'script', 'textarea', 'title', 'plaintext'],
  urlWriteProps: ['href', 'src', 'action', 'formAction', 'poster'],
  urlWriteBracketProps: ['data'],
  htmlSinkProps: ['innerHTML', 'outerHTML'],
  htmlSinkCalls: { '?.insertAdjacentHTML': [1, 'insertAdjacentHTML'], 'document.write': [0, 'document.write'], 'document.writeln': [0,
    'document.write'], '?.createContextualFragment': [0, 'createContextualFragment'], '?.parseFromString': [0, 'DOMParser'] },
  scriptAttrs: ['on*', 'srcdoc', 'style'],
  scriptProps: ['srcdoc'],
  scriptBracketProps: ['on*'],
  selectorCalls: ['?.querySelector', '?.querySelectorAll', '?.closest', '?.matches', 'document.querySelector', 'document.querySelectorAll'],
  cutMethods: ['slice', 'substring', 'substr'],
  cutEscapers: ['escapeHtml', 'escapeHtmlUpdates', 'escapeAttr', 'esc'],
  brandTokens: ['brand', 'bot', 'agentId'],
  numberFns: ['Number', 'parseInt', 'parseFloat', 'Math.*', 'Date.now'],
  escapers: ['escapeHtml', 'escapeHtmlUpdates', 'escapeAttr', 'esc', 'escSnippet', 'jsArg', 'safeCssColor', 'tHtml', 'encodeURIComponent',
    'CSS.escape', 'mdInline', 'renderMarkdown', 'Number', 'parseInt', 'parseFloat', 'Math.*'],
  quoteSafe: ['escapeHtml', 'esc', 'escapeAttr', 'escSnippet', 'jsArg', 'escapeHtmlUpdates'],
  htmlOut: ['mdInline', 'renderMarkdown', 'tHtml'],
  notHtmlFns: ['escapeHtml', 'tHtml'],
  trustedByName: ['escapeHtml', 'escapeHtmlUpdates', 'escapeAttr', 'esc', 'escSnippet', 'jsArg', 'safeCssColor', 'safeHref', 'tHtml', 't', 'tr',
    'mdInline', 'renderMarkdown'],
}
const tableEntries = (k: keyof typeof RULES): string[] => {
  const v = TABLES[k] as unknown
  return Array.isArray(v) ? v as string[] : Object.keys(v as object)
}
const checkProbe = ({ code, expect: exp, langs }: Probe) => {
  const r = scanAppJs(code, langs ?? [])
  if (exp === 'none') expect([...r.strict, ...r.review].map(x => x.context)).toEqual([])
  else if ('not' in exp) expect([...r.strict, ...r.review].map(x => x.context)).not.toContain(exp.not)
  else expect(r[exp.bucket].map(x => x.context)).toContain(exp.context)
}

describe('rule tables: every entry has a probe that must be reported', () => {
  it('every table has a generator, and every context a probe', () => {
    expect(Object.keys(GENERATORS).sort()).toEqual(Object.keys(RULES).sort())
    // the scanner's tables are exactly the probed ones
    for (const k of Object.keys(RULES) as (keyof typeof RULES)[]) {
      const sorted = (v: unknown) => (Array.isArray(v) ? [...v].sort() : Object.entries(v as object).sort())
      expect(sorted(RULES[k]), k).toEqual(sorted(TABLES[k]))
    }
    expect(Object.keys(CONTEXT_PROBES).sort()).toEqual([...CONTEXTS].sort())
  })
  const cases = (Object.keys(TABLES) as (keyof typeof RULES)[]).flatMap(k =>
    tableEntries(k).flatMap(e => GENERATORS[k](e).map(p => [`${k}: ${e}: ${p.code}`, p] as const)))
  it.each(cases)('%s', (_name, probe) => checkProbe(probe))
  it.each(Object.entries(CONTEXT_PROBES))('context %s', (_ctx, probe) => checkProbe(probe))
})

// Value x composition x sink matrix. A value of each KIND (raw data, or one
// of the escapers) is composed in each SHAPE (both branches of ?:, both sides
// of || / ??, the right side of &&, every write of an identifier, array
// builders and the array methods before join, loop bindings, later template
// parts, t() params, local functions, an escape cut afterwards) and written
// to each SINK. Expected verdict per cell:
// - a kind that is not right for the sink: reported, at least at the sink's
//   severity (strict where the scanner header says strict);
// - a right kind through a shape the sink's rule proves (sink.through): no
//   finding; through any other shape: still reported (the rule fails closed).
type Shape = { pre?: string; expr: string; strict?: boolean }
const KINDS: Record<string, string> = {
  'raw': 'x.u', 'escapeHtml': 'escapeHtml(x.u)', 'esc': 'esc(x.u)', 'encodeURIComponent': 'encodeURIComponent(x.u)',
  'safeHref': 'safeHref(x.u)', 'safeCssColor': 'safeCssColor(x.u)', 'jsArg': 'jsArg(x.u)', 'CSS.escape': 'CSS.escape(x.u)',
  'escapeHtml(safeHref)': 'escapeHtml(safeHref(x.u))', 'escapeHtml(safeCssColor)': 'escapeHtml(safeCssColor(x.u))',
}
// v: the value expression of the cell's kind (shapes over data arrays / loop
// keys / an escape cut afterwards are unsafe whatever the kind)
const SHAPES: Record<string, (v: string) => Shape> = {
  'ternary-then': v => ({ expr: `(c ? ${v} : 'a')` }),
  'ternary-else': v => ({ expr: `(c ? 'a' : ${v})` }),
  'or-left': v => ({ expr: `(${v} || 'a')` }),
  'or-right': v => ({ expr: `('a' || ${v})` }),
  'nullish-left': v => ({ expr: `(${v} ?? 'a')` }),
  'nullish-right': v => ({ expr: `('a' ?? ${v})` }),
  'and-right': v => ({ expr: `(c && ${v})` }),
  'identifier-once': v => ({ pre: `const v = ${v}`, expr: 'v' }),
  'identifier-reassigned': v => ({ pre: `let v = 'a'\n  if (c) v = ${v}`, expr: 'v' }),
  'identifier-appended': v => ({ pre: `let v = 'a'\n  v += ${v}`, expr: 'v' }),
  'identifier-template': v => ({ pre: `const v = \`\${${v}}\``, expr: 'v' }),
  'array-push-join': v => ({ pre: `const a = []\n  a.push(${v})`, expr: "a.join('')" }),
  'array-unshift-join': v => ({ pre: `const a = []\n  a.unshift(${v})`, expr: "a.join('')" }),
  'array-index-join': v => ({ pre: `const a = []\n  a[0] = ${v}`, expr: "a.join('')" }),
  'array-push-spread-literal-join': v => ({ pre: `const a = []\n  a.push(...[${v}])`, expr: "a.join('')" }),
  'array-filter-join': v => ({ pre: `const a = [${v}]`, expr: "a.filter(Boolean).join('')" }),
  'array-map-filter-join': v => ({ expr: `xs.map(w => ${v}).filter(Boolean).join('')` }),
  'array-slice-join': v => ({ pre: `const a = [${v}]`, expr: "a.slice(0, 3).join('')" }),
  'array-sort-join': v => ({ pre: `const a = [${v}]`, expr: "a.sort().join('')" }),
  'array-concat-join': v => ({ pre: `const a = [${v}]`, expr: "a.concat(['b']).join('')" }),
  'array-reverse-join': v => ({ pre: `const a = [${v}]`, expr: "a.reverse().join('')" }),
  'array-push-spread-join': () => ({ pre: 'const a = []\n  a.push(...xs)', expr: "a.join('')" }),
  'array-unshift-spread-join': () => ({ pre: 'const a = []\n  a.unshift(...xs)', expr: "a.join('')" }),
  'array-spread-join': () => ({ expr: "['a', ...xs].join('')" }),
  'array-reassigned-join': () => ({ pre: 'let a = []\n  a = xs', expr: "a.join('')" }),
  'param-array-join': () => ({ expr: "xs.join('')" }),
  'for-in-binding': () => ({ pre: "let v = 'a'\n  for (const k in d) v = k", expr: 'v' }),
  'for-of-binding': () => ({ pre: "let v = 'a'\n  for (const k of xs) v = k", expr: 'v' }),
  'template-later-part': v => ({ expr: `\`a\${'b'}c\${${v}}\`` }),
  'plus-backtick-literal': v => ({ expr: `(\`a\` + ${v})` }),
  't-param': v => ({ expr: `t('k.a', { n: ${v} })` }),
  'replace-call': v => ({ expr: `${v}.replace(/a/g, 'b')` }),
  't-shorthand-param': v => ({ pre: `const name = ${v}`, expr: "t('k.a', { name })" }),
  'local-function-return': v => ({ pre: `const g = () => ${v}`, expr: 'g()' }),
  'escape-replace-slice': v => ({ expr: `escapeHtml(${v}).replace('a', 'b').replace('c', 'd').slice(0, 5)`, strict: true }),
}
// which shapes each sink's rule sees through
const BASE = ['ternary-then', 'ternary-else', 'or-left', 'or-right', 'nullish-left', 'nullish-right', 'identifier-once', 'identifier-reassigned',
  'identifier-appended']
const ARRAYS = ['array-push-join', 'array-unshift-join', 'array-index-join', 'array-push-spread-literal-join', 'array-filter-join',
  'array-map-filter-join', 'array-slice-join', 'array-sort-join', 'array-concat-join', 'array-reverse-join']
const THROUGH = {
  html: [...BASE, 'and-right', 'identifier-template', ...ARRAYS, 'template-later-part', 'plus-backtick-literal', 't-param', 'replace-call',
    't-shorthand-param', 'local-function-return'],
  // innerHTML = t(...) is its own strict rule
  htmlValue: [...BASE, 'and-right', 'identifier-template', ...ARRAYS, 'template-later-part', 'plus-backtick-literal', 'replace-call',
    'local-function-return'],
  attrRule: [...BASE, 'and-right', 'identifier-template', 'template-later-part', 'plus-backtick-literal', 'local-function-return'],
  urlValue: [...BASE, 'identifier-template'],
  urlPath: [...BASE, 'and-right', 'plus-backtick-literal', 't-param', 'replace-call', 't-shorthand-param'],
  cssProp: [...BASE, 'template-later-part', 'plus-backtick-literal'],
  cssTemplate: [...BASE, 'plus-backtick-literal'],
  selector: [...BASE, 'identifier-template', 'template-later-part', 'plus-backtick-literal'],
}
const TEXT_SAFE = ['escapeHtml', 'esc', 'encodeURIComponent', 'safeCssColor', 'jsArg', 'escapeHtml(safeHref)', 'escapeHtml(safeCssColor)']
// family: the CONTEXTS entry the sink stands for; right: the kinds that are
// correct there; through: the shapes its rule proves
type Sink = { code: (e: string) => string; strict: boolean; family: string; right: string[]; through: string[] }
const html = (code: (e: string) => string, family: string, through = THROUGH.html): Sink => ({ code, strict: false, family, right: TEXT_SAFE, through })
const SINKS: Record<string, Sink> = {
  'html-text': html(e => `el.innerHTML = \`<b>\${${e}}</b>\``, 'text'),
  'html-value': html(e => `el.innerHTML = ${e}`, 'innerHTML=', THROUGH.htmlValue),
  'html-computed-member': html(e => `el[\`innerHTML\`] = ${e}`, 'innerHTML=', THROUGH.htmlValue),
  'html-concat-upper': html(e => `x.h = '<B>' + ${e}`, 'concat'),
  'html-concat-backtick': html(e => `x.h = \`<b>\` + ${e}`, 'concat'),
  'html-variable': html(e => `const aHTML = ${e}`, '*Html='),
  'html-variable-assigned': html(e => `aHTML = ${e}`, '*Html='),
  'html-function-return': html(e => `function rowHTML() { return ${e} }`, 'return-of-*Html'),
  'attribute': html(e => `el.innerHTML = \`<b title="\${${e}}">y</b>\``, 'attr:*'),
  'url-attribute': { code: e => `el.innerHTML = \`<a href="\${${e}}">y</a>\``, strict: true, family: 'url:*', right: ['escapeHtml(safeHref)'], through: THROUGH.attrRule },
  'url-property': { code: e => `el.href = ${e}`, strict: false, family: '.href=', right: ['safeHref'], through: THROUGH.urlValue },
  'url-computed-member': { code: e => `el[\`href\`] = ${e}`, strict: false, family: '.href=', right: ['safeHref'], through: THROUGH.urlValue },
  'url-property-path': { code: e => `el.href = \`/api/\${${e}}\``, strict: false, family: '.href=', right: TEXT_SAFE, through: THROUGH.urlPath },
  'url-setAttribute': { code: e => `el.setAttribute('href', ${e})`, strict: false, family: 'setAttribute(url)', right: ['safeHref'], through: THROUGH.urlValue },
  'url-setAttribute-path': { code: e => `el.setAttribute('href', \`/api/\${${e}}\`)`, strict: true, family: 'url:*', right: TEXT_SAFE, through: THROUGH.urlPath },
  'location': { code: e => `location = ${e}`, strict: false, family: 'location=', right: ['safeHref'], through: THROUGH.urlValue },
  'window-location': { code: e => `window.location = ${e}`, strict: false, family: 'location=', right: ['safeHref'], through: THROUGH.urlValue },
  'document-location': { code: e => `document.location = ${e}`, strict: false, family: 'location=', right: ['safeHref'], through: THROUGH.urlValue },
  'window-open-path': { code: e => `window.open(\`/api/\${${e}}\`)`, strict: false, family: 'window.open', right: TEXT_SAFE, through: THROUGH.urlPath },
  'css-property': { code: e => `el.style.background = ${e}`, strict: true, family: 'style-prop', right: ['safeCssColor'], through: THROUGH.cssProp },
  'css-style-template': { code: e => `el.style = \`background:\${${e}}\``, strict: true, family: 'style-prop', right: ['safeCssColor'], through: THROUGH.cssTemplate },
  'style-attribute': { code: e => `el.innerHTML = \`<b style="color:\${${e}}">y</b>\``, strict: false, family: 'style', right: ['escapeHtml(safeCssColor)'], through: THROUGH.attrRule },
  'insertRule-template': { code: e => `sheet.insertRule(\`a{b:\${${e}}}\`)`, strict: true, family: 'insertRule', right: [], through: [] },
  'handler': { code: e => `el.innerHTML = \`<b onclick="go(\${${e}})">y</b>\``, strict: true, family: 'handler', right: ['jsArg'], through: THROUGH.attrRule },
  'selector-concat': { code: e => `document.querySelector('#a' + ${e})`, strict: true, family: 'selector', right: ['CSS.escape'], through: THROUGH.selector },
  'selector-template': { code: e => `document.querySelector(\`#a\${${e}}\`)`, strict: true, family: 'selector', right: ['CSS.escape'], through: THROUGH.selector },
  'selector-attr-tilde': { code: e => `x.s = \`[data-x~="\${${e}}"]\``, strict: true, family: 'selector', right: ['CSS.escape'], through: THROUGH.selector },
  'selector-attr-space': { code: e => `x.s = \`[data-x= "\${${e}}"]\``, strict: true, family: 'selector', right: ['CSS.escape'], through: THROUGH.selector },
  'selector-attr-single': { code: e => `x.s = \`[data-x='\${${e}}']\``, strict: true, family: 'selector', right: ['CSS.escape'], through: THROUGH.selector },
}
type Verdict = 'none' | 'review' | 'strict'
const matrixCase = (kind: string, shape: string, sink: string): { code: string; verdict: Verdict } => {
  const s = SHAPES[shape](KINDS[kind])
  const k = SINKS[sink]
  const code = `function f(x, xs, d, c) {\n  ${s.pre ?? ''}\n  ${k.code(s.expr)}\n}`
  // a shape that ignores the kind's value composes data
  const carries = s.expr.includes(KINDS[kind]) || (s.pre ?? '').includes(KINDS[kind])
  if (s.strict) return { code, verdict: 'strict' }
  if (!carries || !k.right.includes(kind)) return { code, verdict: k.strict ? 'strict' : 'review' }
  return { code, verdict: k.through.includes(shape) ? 'none' : 'review' }
}

describe('value x composition x sink matrix', () => {
  it('every kind, shape and sink takes part, and the sinks cover the context families', () => {
    const families = new Set(Object.values(SINKS).map(s => s.family))
    for (const f of families) expect(CONTEXTS).toContain(f)
    expect([...families].sort()).toEqual(['*Html=', '.href=', 'attr:*', 'concat', 'handler', 'innerHTML=', 'insertRule', 'location=', 'return-of-*Html',
      'selector', 'setAttribute(url)', 'style', 'style-prop', 'text', 'url:*', 'window.open'])
    for (const s of Object.values(SINKS)) {
      for (const k of s.right) expect(Object.keys(KINDS)).toContain(k)
      for (const sh of s.through) expect(Object.keys(SHAPES)).toContain(sh)
      // raw data is right nowhere
      expect(s.right).not.toContain('raw')
    }
    // every kind is right for some sink (except raw) and wrong for some other
    for (const k of Object.keys(KINDS)) {
      if (k !== 'raw') expect(Object.values(SINKS).some(s => s.right.includes(k)), k).toBe(true)
      expect(Object.values(SINKS).some(s => !s.right.includes(k)), k).toBe(true)
    }
  })
  // one test per sink x kind, every shape inside it
  const cells = Object.keys(SINKS).flatMap(sink => Object.keys(KINDS).map(kind => [sink, kind] as const))
  it.each(cells)('%s with %s', (sink, kind) => {
    const wrong = Object.keys(SHAPES).flatMap(shape => {
      const { code, verdict } = matrixCase(kind, shape, sink)
      const r = scanAppJs(code, [])
      const got: Verdict = r.strict.length ? 'strict' : r.review.length ? 'review' : 'none'
      const ok = verdict === 'none' ? got === 'none' : verdict === 'strict' ? got === 'strict' : got !== 'none'
      return ok ? [] : [`${shape}: expected ${verdict}, got ${got}\n${code}`]
    })
    expect(wrong).toEqual([])
  })
})

describe('fixed render sites stay escaped (source pins)', () => {
  it('no inline handler carries an interpolation inside a quoted JS string', () => {
    // onclick="fn('${x}')" -- escapeHtml cannot protect this; use jsArg(x).
    const hits = src.split('\n').map((l, i) => [i + 1, l] as const)
      .filter(([, l]) => /\son[a-z]+="[^"]*'\$\{/.test(l))
    expect(hits).toEqual([])
  })

  it.each([
    // [what, raw form that must not come back]
    ['connector detail env key', '${k}=${v}'],
    ['connector detail status', '${statusLabels[detail.status] || detail.status}<'],
    ['connector agent list id', 'id="assign-${agent.name}"'],
    ['new connector agent list id', 'id="new-assign-${agent.name}"'],
    ['catalog icon', '${item.icon || \'?\'}<'],
    ['catalog type', '${item.type}<'],
    ['catalog install id', 'data-id="${item.id}"'],
    ['kanban card id', 'data-card-id="${card.id}"'],
    ['kanban aging colour', 'style="color:${agingColor}"'],
    ['model suggestion agent', '<strong>${r.agent}</strong>'],
    ['voice option', '<option value="${v}"'],
    ['schedule agent option', '<option value="${a.name}">${a.label}<'],
    ['schedule cron text', '<span>${describeCron(task.schedule)}</span>'],
    ['memory graph tier', 'badge-${node.tier}"'],
    ['token tooltip agent', '</span> ${seg.agent}:'],
    ['idea status label', '">${statusLabel}</span>'],
    ['idea score', 'I${idea.impact}'],
    ['archived card status', '${STATUS_LABELS[card.status]?.() ?? card.status}<'],
    ['archived card priority', '${PRIORITY_LABELS[card.priority]?.() ?? card.priority}<'],
    ['network error message', '{msg: err.message}'],
    ['channel request id fallback', ': req.channel_id'],
    // the bgTasks map parameter must not shadow the i18n t() again
    ['bgTasks map param shadowing t()', 'tasks.map(t =>'],
    ['agent detail avatar initial', 'const initial = detailLabel.charAt(0)'],
  ])('%s', (_what, raw) => {
    expect(src).not.toContain(raw)
  })
})

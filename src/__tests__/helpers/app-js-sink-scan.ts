// Sink scanner for web/app.js, used by app-js-html-sinks.test.ts.
//
// Scope: a regression guard for the sinks and shapes it models. Shapes it
// does not model are listed under "Known limits" below; whether web/app.js
// itself is safe is judged on web/app.js, not on what this scanner accepts.
// The lists below (sinks, attributes, raw-text elements, CSS properties,
// brand tokens, escaper names) live in RULES, and every finding context in
// CONTEXTS; the test generates a probe for each entry and each context.
//
// The file is parsed with the TypeScript compiler (ScriptKind.JS), so strings,
// comments, regex literals, templates and multi-line expressions are exactly
// what the language says they are; a syntax error is itself a strict finding.
//
// Sinks and the rule for the value that reaches them:
//   HTML: .innerHTML / .outerHTML (=, +=, ||=, ??=, bracket spelling),
//     insertAdjacentHTML, document.write(ln), createContextualFragment,
//     DOMParser.parseFromString, a *Html variable, the return value of a
//     *Html / *Icon function, and every template literal or '+' chain that
//     contains markup. Inside markup the value is judged by where it lands:
//     the markup text before it is run through the parse5 HTML tokenizer
//     (contextAt), whose state gives text / attribute (name, quote, value so
//     far) / tag position / raw text, as a browser tokenizes that same text:
//     - text / other quoted attribute -> a safe expression (below);
//       mdInline / renderMarkdown / tHtml (markup) in text only
//     - href / src / action / formaction / xlink:href / poster / data
//       -> escapeHtml(safeHref(x)), or a fixed same-origin "/path" prefix
//     - on*="..."                       -> jsArg(x), never inside a JS string
//     - style / fill / stroke / ...     -> escapeHtml(cssSafe) or esc(cssSafe)
//       (escapeHtml / esc OUTERMOST; any other wrapper is strict)
//     - single-quoted attribute         -> a quote-safe escaper
//     - unquoted attribute              -> a number only
//     - srcdoc                          -> nothing
//     - tag / attribute-name position   -> a number only (else reviewed;
//       an escaper there is strict: there is no quote to escape)
//     - <style> element text            -> a CSS-safe value
//     - other raw text (script, xmp...) -> nothing
//     - right after an open character reference ('&quot', '&#39', '&')
//                                       -> nothing (the value completes it)
//   CSS: .style.X / .style[X] / setProperty / setAttribute(fill|stroke|...) /
//     .style = / style templates: a literal, a number or safeCssColor(x[,
//     'lit']); a url()-capable, custom or computed property is strict.
//   URL: .href / .src / .action / .formAction / .poster =, setAttribute(url),
//     window.open, location: safeHref(x) or a literal.
//   Selectors: querySelector(All) / closest / matches with a template or '+'
//     argument, and attribute-selector templates: every part CSS.escape(x).
//   Never: setAttribute('on*' | 'srcdoc' | 'style'), el['on*'|'srcdoc'] =,
//     .srcdoc =, Object.assign(el.style), insertRule(non-literal),
//     innerHTML = t(...), an *_html translation key through plain t(),
//     escaped text cut afterwards (escSnippet does it in the right order).
//
// Every value is judged RECURSIVELY: parentheses, both branches of ?:,
// every operand of ||, ?? and +, the right side of && and ',', every part of
// a template; whatever the line layout. A safe leaf is a literal, a number /
// boolean expression, an escaper call (escapeHtml, esc, jsArg, tHtml, ...),
// t() of a key without brand tokens whose params are safe, a Date formatter
// on new Date(...), the length of an array a method just built, or
// xs.map(f).join(lit) whose callback returns safe values. Two leaves are
// resolved instead of trusted by name:
// - an identifier, through the parser's scope binding: safe only if its
//   initializer AND every later assignment (=, +=, push / unshift, x[i] =)
//   are safe by the same rules, in the same context; a parameter, a
//   destructured / loop / catch binding or an undeclared name is data;
// - a call of a function of this file (declaration, const-bound function
//   expression, IIFE): what it returns, judged in the caller's context.
//
// A failing leaf is reported per slot (a template ${...}, an operand of a
// '+' chain, or the value written at a sink / assignment), per context and
// per place it is printed (a value reached through an identifier or a
// function counts at each use). Strict findings have no allowlist; reviewed
// ones are keyed <function>::<context>::<slot expression>, with the number
// of sites. The function part is the chain of enclosing functions (a named
// one by its name, an anonymous callback with a block body as
// "cb:<opening line>"); a chain used twice gets #2, #3 in source order.
//
// Known limits: sinks not modelled (eval, new Function, string setTimeout,
// el.onclick = string, srcset, setHTMLUnsafe, setAttributeNS, Reflect.set,
// el['setAttribute'](...), <style> textContent, a style object held in a
// variable); a function's ARGUMENTS are not followed into its body (a
// parameter there is data, reviewed where it is printed); an object
// property, a method of an object and an array mutated in a way other than
// push / unshift / x[i] = (splice, a helper) are not followed; a literal
// transform (.replace(lit, lit), .trim()) of safe text is trusted; the
// markup context after an interpolated value assumes it carried no markup of
// its own (it counts as one letter); the escapers and safeHref, t, tr, tHtml,
// mdInline, renderMarkdown are trusted by name (their bodies are tested
// directly); a selector argument that is a single non-composite value is not
// judged; foreign content (svg / math) is tokenized as HTML.

import ts from 'typescript'
import { Tokenizer, TokenizerMode } from 'parse5'

// fn: the enclosing function chain (part of the allowlist key, so a reviewed
// `label` in one renderer does not approve a `label` in another)
export interface Interp { line: number; context: string; expr: string; fn: string }

// Is the end of this handler code inside an open JS string literal?
// ("go('prefix-" -> yes, "go(" -> no); the tokenizer has already decoded the
// attribute's character references.
function inJsString(js: string): boolean {
  let q = ''
  for (let i = 0; i < js.length; i++) {
    const c = js[i]
    if (q) { if (c === '\\') i++; else if (c === q) q = '' }
    else if (c === "'" || c === '"' || c === '`') q = c
  }
  return q !== ''
}

// The markup context at the end of `before` (the HTML text up to an
// interpolation, earlier interpolations as 'X'), read from the state of the
// parse5 tokenizer after it has consumed that text: text, the content of a
// raw-text element, a tag / attribute-name position, or an attribute value
// (name lowercased, quote, value so far with character references decoded).
// Raw-text elements switch the tokenizer the way parse5's tree builder does.
type HtmlCtx = { kind: 'text' | 'raw' | 'markup' | 'attr' | 'charref'; tag: string; name: string; value: string; quote: string }
const RAW_TEXT: Record<string, number> = {
  style: TokenizerMode.RAWTEXT, xmp: TokenizerMode.RAWTEXT, iframe: TokenizerMode.RAWTEXT, noembed: TokenizerMode.RAWTEXT,
  noframes: TokenizerMode.RAWTEXT, noscript: TokenizerMode.RAWTEXT, script: TokenizerMode.SCRIPT_DATA,
  textarea: TokenizerMode.RCDATA, title: TokenizerMode.RCDATA, plaintext: TokenizerMode.PLAINTEXT,
}
// parse5 tokenizer states (State in its tokenizer; package.json pins parse5
// to exactly 8.0.1 because these numbers are read here): 8-10 RCDATA '<',
// 11-13 RAWTEXT '<', 14-30 script data, 34 before attribute value, 35 / 36 /
// 37 attribute value double / single / unquoted, 40-51 comments, 68-70
// CDATA, 71 / 72 inside a character reference. A reference still open when
// the markup ends ('&quot', '&#39', '&') is decoded by the browser only once
// the interpolated text arrives, possibly into a quote: its own context.
const ctxMemo = new Map<string, HtmlCtx>()
export function contextAt(before: string): HtmlCtx {
  const hit = ctxMemo.get(before)
  if (hit) return hit
  const noop = () => {}
  const tk: Tokenizer = new Tokenizer({}, {
    onStartTag: t => { if (RAW_TEXT[t.tagName] !== undefined) tk.state = RAW_TEXT[t.tagName] as Tokenizer['state'] },
    onEndTag: noop, onComment: noop, onDoctype: noop, onEof: noop, onCharacter: noop, onNullCharacter: noop, onWhitespaceCharacter: noop,
  })
  tk.write(before, false)
  const t = tk as unknown as { state: number; lastStartTagName: string; currentAttr: { name: string; value: string } }
  const st = t.state
  const between = (a: number, b: number) => st >= a && st <= b
  const c: HtmlCtx = { kind: 'markup', tag: t.lastStartTagName, name: '', value: '', quote: '' }
  if (st === TokenizerMode.DATA || st === TokenizerMode.RCDATA || between(8, 10) || between(40, 51) || between(68, 70)) c.kind = 'text'
  else if (st === TokenizerMode.RAWTEXT || st === TokenizerMode.SCRIPT_DATA || st === TokenizerMode.PLAINTEXT || between(11, 30)) c.kind = 'raw'
  else if (between(34, 37)) Object.assign(c, { kind: 'attr', name: t.currentAttr.name, value: t.currentAttr.value, quote: st === 35 ? '"' : st === 36 ? "'" : '' })
  else if (between(71, 72)) c.kind = 'charref'
  ctxMemo.set(before, c)
  return c
}

// Every list the rules use, in one place: the test generates a probe from
// each entry (and fails for a table without a generator), so an entry that
// stops working, or a new one without a probe, fails there.
// Names: '?.x' = a method x on any object, 'Math.*' = any Math method.
export const RULES = {
  // CSS properties whose value can be a url() (and every custom property: a
  // stylesheet may use --x as a whole background, and SVG paint)
  urlProps: ['background', 'backgroundImage', 'cursor', 'content', 'listStyle', 'listStyleImage', 'borderImage', 'borderImageSource',
    'mask', 'maskImage', 'webkitMaskImage', 'filter', 'backdropFilter', 'shapeOutside', 'clipPath', 'maskBorder', 'maskBorderSource',
    'webkitMaskBoxImage', 'offsetPath', 'background-image', 'list-style', 'list-style-image', 'border-image', 'border-image-source',
    'mask-image', 'mask-border', 'mask-border-source', 'backdrop-filter', 'shape-outside', 'clip-path', 'offset-path', 'fill', 'stroke', '--*'],
  urlAttrs: ['href', 'src', 'action', 'formaction', 'xlink:href', 'poster', 'data'],
  cssAttrs: ['style', 'fill', 'stroke', 'stop-color', 'flood-color', 'lighting-color', 'color', 'bgcolor'],
  rawText: Object.keys(RAW_TEXT),
  // property writes judged as URLs (dot or bracket), and bracket-only ones
  urlWriteProps: ['href', 'src', 'action', 'formAction', 'poster'],
  urlWriteBracketProps: ['data'],
  htmlSinkProps: ['innerHTML', 'outerHTML'],
  // HTML sink calls: name -> [index of the HTML argument, context]
  htmlSinkCalls: {
    '?.insertAdjacentHTML': [1, 'insertAdjacentHTML'], 'document.write': [0, 'document.write'], 'document.writeln': [0, 'document.write'],
    '?.createContextualFragment': [0, 'createContextualFragment'], '?.parseFromString': [0, 'DOMParser'],
  } as Record<string, [number, string]>,
  // never with a value: setAttribute names, property writes (any spelling /
  // bracket only)
  scriptAttrs: ['on*', 'srcdoc', 'style'],
  scriptProps: ['srcdoc'],
  scriptBracketProps: ['on*'],
  selectorCalls: ['?.querySelector', '?.querySelectorAll', '?.closest', '?.matches', 'document.querySelector', 'document.querySelectorAll'],
  // escaped text is never cut afterwards (escSnippet cuts first)
  cutMethods: ['slice', 'substring', 'substr'],
  cutEscapers: ['escapeHtml', 'escapeHtmlUpdates', 'escapeAttr', 'esc'],
  // a translation that carries one of these tokens is not a constant
  brandTokens: ['brand', 'bot', 'agentId'],
  numberFns: ['Number', 'parseInt', 'parseFloat', 'Math.*', 'Date.now'],
  // calls that escape for some context (HTML text except CSS.escape; never CSS-safe by themselves)
  escapers: ['escapeHtml', 'escapeHtmlUpdates', 'escapeAttr', 'esc', 'escSnippet', 'jsArg', 'safeCssColor', 'tHtml', 'encodeURIComponent',
    'CSS.escape', 'mdInline', 'renderMarkdown', 'Number', 'parseInt', 'parseFloat', 'Math.*'],
  // escapers that also encode the apostrophe
  // (numbers pass on their own)
  quoteSafe: ['escapeHtml', 'esc', 'escapeAttr', 'escSnippet', 'jsArg', 'escapeHtmlUpdates'],
  // helpers whose output is markup: safe as HTML text, never inside an attribute
  htmlOut: ['mdInline', 'renderMarkdown', 'tHtml'],
  // *Html-named helpers whose returns are not markup sinks
  notHtmlFns: ['escapeHtml', 'tHtml'],
  // helpers judged by name (their own bodies are tested directly), never by their returns
  trustedByName: ['escapeHtml', 'escapeHtmlUpdates', 'escapeAttr', 'esc', 'escSnippet', 'jsArg', 'safeCssColor', 'safeHref', 'tHtml', 't', 'tr',
    'mdInline', 'renderMarkdown'],
}
// every context a finding can carry ('x:*' = x: plus a name); put() refuses
// any other, and the test needs a probe for each
export const CONTEXTS = ['parse-error', 'text', 'concat', 'builder', 'return', 'innerHTML=', 'innerHTML=t(', '*Html=', 'return-of-*Html',
  'insertAdjacentHTML', 'document.write', 'createContextualFragment', 'DOMParser', 'attr:*', 'url:*', 'raw-text:*', 'markup',
  'char-ref-before-interpolation', 'html-in-attr', 'unquoted-attr', 'srcdoc', 'single-quoted-attr', 'handler-arg-in-js-string', 'handler',
  'style', 'style-prop', 'style-escape-is-not-css-safe', 'style-css-not-html-escaped', 'style.cssText=', 'style-object', 'insertRule',
  '.href=', '.src=', 'location=', 'location.assign', 'window.open', 'setAttribute(url)', 'setAttribute(computed name)', 'script-sink',
  'selector', 'html-key-needs-tHtml', 'slice-after-escape']
const nameRe = (names: string[]) => new RegExp(`^(${names.map(n => n.replace(/[.?$]/g, c => '\\' + c).replace('*', '\\w+')).join('|')})$`)
const URL_PROP = new RegExp(`^(${RULES.urlProps.map(p => p.replace('*', '.+')).join('|')})$`)
const URL_ATTRS = RULES.urlAttrs
const CSS_ATTRS = RULES.cssAttrs
const NUMBER_FN = nameRe(RULES.numberFns)
const ESCAPERS = nameRe(RULES.escapers)
const QUOTE_SAFE = nameRe(RULES.quoteSafe)
const HTML_OUT = nameRe(RULES.htmlOut)
const NOT_HTML_FNS = nameRe(RULES.notHtmlFns)
const NO_RESOLVE = nameRe(RULES.trustedByName)
const isScriptAttr = (a: string) => RULES.scriptAttrs.some(x => (x === 'on*' ? a.startsWith('on') : a === x))
const ASSIGN_OPS = new Set([ts.SyntaxKind.EqualsToken, ts.SyntaxKind.PlusEqualsToken, ts.SyntaxKind.BarBarEqualsToken, ts.SyntaxKind.QuestionQuestionEqualsToken, ts.SyntaxKind.AmpersandAmpersandEqualsToken])

const strip = (n: ts.Expression): ts.Expression => (ts.isParenthesizedExpression(n) ? strip(n.expression) : n)
const norm = (s: string) => s.trim().replace(/\s+/g, ' ')
// callee as a dotted name: esc, CSS.escape, Math.round, x.y.slice -> "?.slice"
function calleeName(c: ts.CallExpression): string {
  const e = c.expression
  if (ts.isIdentifier(e)) return e.text
  if (ts.isPropertyAccessExpression(e)) return ts.isIdentifier(e.expression) && /^(Math|CSS|Date|Array|document|window|Object|location)$/.test(e.expression.text) ? `${e.expression.text}.${e.name.text}` : `?.${e.name.text}`
  return ''
}
// the written name of a property target: el.x / el['x'] / el[`x`]
function propName(n: ts.Expression): string | undefined {
  if (ts.isPropertyAccessExpression(n)) return n.name.text
  if (ts.isElementAccessExpression(n) && ts.isStringLiteralLike(n.argumentExpression)) return n.argumentExpression.text
  return undefined
}
const isLit = (n: ts.Expression) => {
  const e = strip(n)
  return ts.isStringLiteralLike(e) || ts.isNumericLiteral(e) || e.kind === ts.SyntaxKind.TrueKeyword || e.kind === ts.SyntaxKind.FalseKeyword ||
    e.kind === ts.SyntaxKind.NullKeyword || (ts.isIdentifier(e) && /^(undefined|NaN|Infinity)$/.test(e.text))
}
const isFnLike = (n: ts.Node): n is ts.FunctionLikeDeclaration => ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n) || ts.isMethodDeclaration(n) || ts.isGetAccessor(n) || ts.isSetAccessor(n)

function parse(src: string) {
  const fileName = 'app.js'
  const sf = ts.createSourceFile(fileName, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
  const host: ts.CompilerHost = {
    getSourceFile: n => (n === fileName ? sf : undefined), getDefaultLibFileName: () => 'lib.d.ts', writeFile: () => {},
    getCurrentDirectory: () => '/', getCanonicalFileName: f => f, useCaseSensitiveFileNames: () => true, getNewLine: () => '\n',
    fileExists: n => n === fileName, readFile: () => undefined,
  }
  const program = ts.createProgram({ rootNames: [fileName], options: { allowJs: true, noLib: true, noResolve: true, types: [] }, host })
  return { sf, checker: program.getTypeChecker(), diagnostics: program.getSyntacticDiagnostics(sf) }
}

export function scanAppJs(src: string, langSources: string[]): { strict: Interp[]; review: Interp[] } {
  const brandRe = new RegExp(`'([\\w.]+)'\\s*:\\s*'[^'\\n]*\\{(?:${RULES.brandTokens.join('|')})\\}`, 'g')
  const brandKeys = new Set(langSources.flatMap(l => [...l.matchAll(brandRe)].map(m => m[1])))
  const { sf, checker, diagnostics } = parse(src)
  const lineOf = (n: ts.Node | number) => sf.getLineAndCharacterOfPosition(typeof n === 'number' ? n : n.getStart(sf)).line + 1

  // ---- scope names (the allowlist key's function part)
  // A callback's name is its opening line with template text blanked.
  const masked = src.split('')
  const blankTemplates = (n: ts.Node): void => {
    if (ts.isTemplateExpression(n) || ts.isNoSubstitutionTemplateLiteral(n)) {
      for (let k = n.getStart(sf); k < n.getEnd(); k++) if (masked[k] !== '\n') masked[k] = ' '
      return
    }
    ts.forEachChild(n, blankTemplates)
  }
  blankTemplates(sf)
  const maskedLines = masked.join('').split('\n')
  const ownName = (f: ts.Node): string | undefined => {
    if ((ts.isFunctionDeclaration(f) || ts.isFunctionExpression(f)) && f.name) return f.name.text
    if ((ts.isMethodDeclaration(f) || ts.isGetAccessor(f) || ts.isSetAccessor(f)) && ts.isIdentifier(f.name)) return f.name.text
    const p = f.parent
    if (ts.isVariableDeclaration(p) && ts.isIdentifier(p.name)) return p.name.text
    if (ts.isBinaryExpression(p) && p.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isPropertyAccessExpression(p.left)) return p.left.name.text
    return undefined
  }
  // a scope's name is the chain of its enclosing scopes; a name used twice
  // (two functions renderCard) gets #2, #3 in source order
  const scopeName = new Map<ts.Node, string>()
  const taken = new Map<string, number>()
  const nameScopes = (n: ts.Node, outer: string): void => {
    let inner = outer
    if (isFnLike(n) && (ownName(n) || (n.body && ts.isBlock(n.body)))) {
      const own = ownName(n) ?? 'cb:' + (maskedLines[lineOf(n.body!) - 1] || '').trim().replace(/\s+/g, ' ').slice(0, 80)
      let name = (outer === '(top)' ? '' : outer + '>') + own
      const k = (taken.get(name) ?? 0) + 1
      taken.set(name, k)
      if (k > 1) name += `#${k}`
      scopeName.set(n, name)
      inner = name
    }
    ts.forEachChild(n, c => nameScopes(c, inner))
  }
  nameScopes(sf, '(top)')
  const scopeOf = (n: ts.Node): string => {
    let f: ts.Node | undefined = n.parent
    while (f && !scopeName.has(f)) f = f.parent
    return f ? scopeName.get(f)! : '(top)'
  }

  // ---- findings: one per slot node, context and use site (a value reached
  // through an identifier or a function counts once per place it is printed)
  const ids = new Map<ts.Node, number>()
  const idOf = (n: ts.Node | undefined) => (n ? ids.get(n) ?? (ids.set(n, ids.size + 1), ids.size) : 0)
  let useSite: ts.Node | undefined
  const found = new Map<string, { line: number; context: string; expr: string; fn: string; strict: boolean }>()
  const loose: { line: number; context: string; expr: string; fn: string; strict: boolean }[] = []
  const put = (node: ts.Node, context: string, strict: boolean, expr = norm(node.getText(sf))) => {
    if (!CONTEXTS.includes(context) && !CONTEXTS.includes(context.replace(/:.*$/, ':*'))) throw new Error(`unlisted context ${context}`)
    const key = `${idOf(node)}|${context}|${idOf(useSite)}`
    if (!found.has(key)) found.set(key, { line: lineOf(node), context, expr, fn: scopeOf(node), strict })
  }
  // judge `f` with `site` as the use site (the outermost one wins)
  const from = (site: ts.Node, f: () => void) => {
    const prev = useSite
    useSite ??= site
    try { f() } finally { useSite = prev }
  }
  for (const d of diagnostics) loose.push({ line: lineOf(d.start ?? 0), context: 'parse-error', expr: ts.flattenDiagnosticMessageText(d.messageText, ' '), fn: '(top)', strict: true })

  // ---- identifier resolution: every value a binding can hold
  const writes = new Map<ts.Symbol, { value: ts.Expression; elem: boolean }[]>()
  const opaque = new Set<ts.Symbol>()
  const symOf = (n: ts.Node) => (ts.isShorthandPropertyAssignment(n.parent) && n.parent.name === n
    ? checker.getShorthandAssignmentValueSymbol(n.parent) : checker.getSymbolAtLocation(n))
  const addWrite = (target: ts.Expression, value: ts.Expression, elem: boolean) => {
    const s = symOf(target)
    if (s) { if (!writes.has(s)) writes.set(s, []); writes.get(s)!.push({ value, elem }) }
  }
  const markOpaque = (n: ts.Node): void => { if (ts.isIdentifier(n)) { const s = symOf(n); if (s) opaque.add(s) } else ts.forEachChild(n, markOpaque) }
  const indexWrites = (n: ts.Node): void => {
    if (ts.isBinaryExpression(n) && ASSIGN_OPS.has(n.operatorToken.kind)) {
      const l = strip(n.left)
      if (ts.isIdentifier(l)) addWrite(l, n.right, false)
      else if (ts.isElementAccessExpression(l) && ts.isIdentifier(l.expression)) addWrite(l.expression, n.right, true)
      else if (ts.isArrayLiteralExpression(l) || ts.isObjectLiteralExpression(l)) markOpaque(l)
    } else if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && /^(push|unshift)$/.test(n.expression.name.text) && ts.isIdentifier(n.expression.expression)) {
      for (const a of n.arguments) addWrite(n.expression.expression, ts.isSpreadElement(a) ? a.expression : a, !ts.isSpreadElement(a))
    } else if ((ts.isForOfStatement(n) || ts.isForInStatement(n)) && !ts.isVariableDeclarationList(n.initializer)) markOpaque(n.initializer)
    ts.forEachChild(n, indexWrites)
  }
  indexWrites(sf)
  // the values of an identifier, or null when it is data (parameter,
  // destructured / loop / catch binding, function, undeclared)
  type Value = { value: ts.Expression; elem: boolean; name: string }
  const valuesOf = (id: ts.Identifier): Value[] | null => {
    const s = symOf(id)
    if (!s || opaque.has(s) || !s.declarations?.length) return null
    const out: Value[] = []
    for (const d of s.declarations) {
      if (!ts.isVariableDeclaration(d) || !ts.isIdentifier(d.name)) return null
      const list = d.parent
      if (ts.isVariableDeclarationList(list) && (ts.isForOfStatement(list.parent) || ts.isForInStatement(list.parent))) return null
      if (d.initializer) out.push({ value: d.initializer, elem: false, name: d.name.text })
    }
    for (const w of writes.get(s) || []) out.push({ ...w, name: id.text })
    return out
  }

  // ---- CSS values
  const cssMemo = new Map<ts.Symbol, boolean>()
  const containsSafeCssColor = (n: ts.Node): boolean =>
    (ts.isCallExpression(n) && calleeName(n) === 'safeCssColor') || !!ts.forEachChild(n, c => containsSafeCssColor(c) || undefined)
  const cssSafe = (n0: ts.Expression): boolean => {
    const n = strip(n0)
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isNumericLiteral(n)) return true
    if (ts.isPrefixUnaryExpression(n) && ts.isNumericLiteral(n.operand)) return true
    if (ts.isConditionalExpression(n)) return cssSafe(n.whenTrue) && cssSafe(n.whenFalse)
    if (ts.isBinaryExpression(n) && [ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.PlusToken].includes(n.operatorToken.kind)) return cssSafe(n.left) && cssSafe(n.right)
    if (ts.isCallExpression(n)) {
      const name = calleeName(n)
      if (NUMBER_FN.test(name) || name === '?.toFixed') return true
      if (name === 'safeCssColor') return n.arguments.length === 1 || (n.arguments.length === 2 && ts.isStringLiteral(n.arguments[1]))
      return false
    }
    if (ts.isIdentifier(n)) {
      const s = symOf(n)
      if (!s) return false
      if (cssMemo.has(s)) return cssMemo.get(s)!
      cssMemo.set(s, true) // a cycle adds no new value
      const vs = valuesOf(n)
      const ok = !!vs && vs.every(v => cssSafe(v.value))
      cssMemo.set(s, ok)
      return ok
    }
    return false
  }
  // a CSS value in a style property / style template / <style> text
  const judgeCss = (n: ts.Expression, slot: ts.Node, strictValue: boolean) => {
    if (cssSafe(n)) return
    const e = strip(n)
    if (ts.isCallExpression(e) && ESCAPERS.test(calleeName(e))) put(slot, 'style-escape-is-not-css-safe', true)
    else put(slot, strictValue ? 'style-prop' : 'style', strictValue)
  }
  // a CSS value inside an HTML attribute: also HTML-escaped, escapeHtml / esc
  // the OUTERMOST call; any other call around a safeCssColor value is strict
  const judgeCssAttr = (e: ts.Expression, slot: ts.Node) => {
    if (ts.isCallExpression(e)) {
      const name = calleeName(e)
      if ((name === 'escapeHtml' || name === 'esc') && e.arguments.length === 1 && cssSafe(e.arguments[0])) return
      if (e.arguments.length && e.arguments.every(cssSafe) && e.arguments.some(containsSafeCssColor)) return put(slot, 'style-css-not-html-escaped', true)
    }
    if (cssSafe(e)) { if (containsSafeCssColor(e)) put(slot, 'style-css-not-html-escaped', true); return }
    judgeCss(e, slot, false)
  }
  const tplCss = (t: ts.Expression, strictValue: boolean) => {
    if (ts.isTemplateExpression(t)) for (const s of t.templateSpans) judgeCss(s.expression, s.expression, strictValue)
  }
  const judgeCssValue = (prop: string, v: ts.Expression) => {
    if (ts.isTemplateExpression(strip(v))) return tplCss(strip(v), URL_PROP.test(prop))
    if (!cssSafe(v)) put(v, 'style-prop', URL_PROP.test(prop), norm(`${prop} = ${v.getText(sf)}`))
  }

  // ---- URL values (property writes, setAttribute, window.open, location)
  const urlOk = (n0: ts.Expression, seen = new Set<ts.Symbol>()): boolean => {
    const n = strip(n0)
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) return true
    if (ts.isCallExpression(n)) return calleeName(n) === 'safeHref'
    if (ts.isConditionalExpression(n)) return urlOk(n.whenTrue, seen) && urlOk(n.whenFalse, seen)
    if (ts.isBinaryExpression(n) && [ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(n.operatorToken.kind)) return urlOk(n.left, seen) && urlOk(n.right, seen)
    if (ts.isTemplateExpression(n)) return tplUrlOk(n)
    if (ts.isIdentifier(n)) {
      const s = symOf(n)
      if (s && seen.has(s)) return true
      const vs = valuesOf(n)
      if (s) seen.add(s)
      return !!vs && vs.every(v => urlOk(v.value, seen))
    }
    return false
  }
  // `${safeHref(x)}` alone, or a fixed same-origin "/path" prefix with safe
  // parts: a safe part after "javascript:" is NOT a safe URL
  const tplUrlOk = (t: ts.TemplateExpression): boolean => {
    if (t.head.text === '' && t.templateSpans.length === 1 && t.templateSpans[0].literal.text === '') {
      const e = strip(t.templateSpans[0].expression)
      if (ts.isCallExpression(e) && calleeName(e) === 'safeHref') return true
    }
    return /^\/[\w.~%-]/.test(t.head.text) && t.templateSpans.every(s => quiet(s.expression, new Set()))
  }
  const judgeUrl = (ctx: string, name: string, v: ts.Expression, tplStrict: boolean) => {
    const e = strip(v)
    if (ts.isTemplateExpression(e)) { if (!tplUrlOk(e)) put(v, tplStrict ? `url:${name}` : ctx, tplStrict); return }
    if (!urlOk(v)) put(v, ctx, false)
  }

  // ---- HTML values
  type Slot = { node: ts.Node; ctx: string; root: boolean }
  const handled = new Set<ts.Node>()
  const done = new Map<ts.Symbol, Set<string>>()
  const doneFn = new Map<ts.Node, Set<string>>()
  // the function a callee names: an IIFE, a function declaration, or a const
  // bound to a function expression
  const localFn = (c0: ts.Expression): ts.FunctionLikeDeclaration | undefined => {
    const c = strip(c0)
    if (ts.isFunctionExpression(c) || ts.isArrowFunction(c)) return c
    if (!ts.isIdentifier(c)) return undefined
    const d = symOf(c)?.valueDeclaration
    if (d && ts.isFunctionDeclaration(d)) return d
    if (d && ts.isVariableDeclaration(d) && d.initializer && (ts.getCombinedNodeFlags(d) & ts.NodeFlags.Const)) {
      const i = strip(d.initializer)
      if (ts.isFunctionExpression(i) || ts.isArrowFunction(i)) return i
    }
    return undefined
  }
  const ctxKey = (before: string) => {
    const c = contextAt(before)
    return `${c.kind}|${c.kind === 'raw' ? c.tag : ''}|${c.name}|${c.quote}|${/^\/[\w.~%-]/.test(c.value)}|${inJsString(c.value)}`
  }
  // a value printed into markup; `before` = the markup text before it
  const html = (n0: ts.Expression, before: string, slot: Slot, seen: Set<ts.Symbol>): void => {
    const n = strip(n0)
    if (ts.isConditionalExpression(n)) { html(n.whenTrue, before, slot, seen); html(n.whenFalse, before, slot, seen); return }
    if (ts.isBinaryExpression(n)) {
      const k = n.operatorToken.kind
      if (k === ts.SyntaxKind.BarBarToken || k === ts.SyntaxKind.QuestionQuestionToken) { html(n.left, before, slot, seen); html(n.right, before, slot, seen); return }
      // x && y prints a falsy x (false / 0 / '' / null) or y
      if (k === ts.SyntaxKind.AmpersandAmpersandToken || k === ts.SyntaxKind.CommaToken || ASSIGN_OPS.has(k)) { html(n.right, before, slot, seen); return }
      if (k === ts.SyntaxKind.PlusToken) { sequence(n, before, slot, seen); return }
    }
    if (ts.isTemplateExpression(n)) { sequence(n, before, slot, seen); return }
    leaf(n, before, slot, seen)
  }
  // a template or '+' chain: each part judged with the markup before it
  const sequence = (n: ts.Expression, before: string, slot: Slot, seen: Set<ts.Symbol>) => {
    handled.add(n)
    let b = before
    const part = (p: ts.Expression, s: Slot) => { html(p, b, s, seen); b += 'X' }
    const walk = (e: ts.Expression) => {
      if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.PlusToken) { walk(e.left); walk(e.right); return }
      if (ts.isStringLiteralLike(e)) { b += e.text; return }
      if (ts.isNumericLiteral(e)) { b += e.text; return }
      if (ts.isTemplateExpression(e)) {
        handled.add(e)
        b += e.head.text
        for (const s of e.templateSpans) { part(s.expression, { node: s.expression, ctx: 'text', root: false }); b += s.literal.text }
        return
      }
      part(e, slot.root ? { node: e, ctx: 'concat', root: false } : slot)
    }
    walk(n)
  }
  const leaf = (n: ts.Expression, before: string, slot: Slot, seen: Set<ts.Symbol>): void => {
    if (isLit(n)) return
    if (ts.isIdentifier(n)) {
      const s = symOf(n)
      if (s && seen.has(s)) return
      const vs = valuesOf(n)
      if (vs && s) {
        // judged once per symbol, markup context and use site
        const key = `${ctxKey(before)}|${idOf(useSite ?? n)}`
        if (!done.has(s)) done.set(s, new Set())
        if (done.get(s)!.has(key)) return
        done.get(s)!.add(key)
        const next = new Set(seen).add(s)
        from(n, () => { for (const v of vs) html(v.value, before, { node: v.value, ctx: /(Html|HTML)$/.test(v.name) ? '*Html=' : 'builder', root: true }, next) })
        return
      }
    }
    // a function of this file (or an IIFE): what it returns, in this context
    const f = ts.isCallExpression(n) && !NO_RESOLVE.test(calleeName(n)) ? localFn(n.expression) : undefined
    if (f) {
      const key = `${ctxKey(before)}|${idOf(useSite ?? n)}`
      if (!doneFn.has(f)) doneFn.set(f, new Set())
      if (doneFn.get(f)!.has(key)) return
      doneFn.get(f)!.add(key)
      from(n, () => { for (const r of returnsOf(f)) html(r, before, { node: r, ctx: 'return', root: true }, seen) })
      return
    }
    const c = contextAt(before)
    const at = (context: string, strict: boolean) => put(slot.node, context, strict)
    if (c.kind === 'raw') return c.tag === 'style' ? judgeCss(n, slot.node, true) : at(`raw-text:${c.tag}`, true)
    const call = ts.isCallExpression(n) ? calleeName(n) : ''
    const num = NUMBER_FN.test(call) || ts.isNumericLiteral(n)
    // a character reference left open right before the value: the value's
    // first characters complete it (jsArg's '&quot;' turns '&#39' into a quote)
    if (c.kind === 'charref') return at('char-ref-before-interpolation', true)
    // a tag or attribute name position: data there writes attributes; an
    // escaper does not help (no quote to escape), only a number fits
    if (c.kind === 'markup') { if (!num) at('markup', ts.isCallExpression(n) && ESCAPERS.test(call)); return }
    if (c.kind === 'text') { if (!textSafe(n, before, slot.node, seen, true)) at(slot.ctx, false); return }
    if (HTML_OUT.test(call)) return at('html-in-attr', true)
    if (!c.quote) { if (!num) at('unquoted-attr', true); return }
    if (c.name === 'srcdoc') return at('srcdoc', true)
    // encodeURIComponent / safeHref keep the apostrophe: checked before the URL rules
    if (c.quote === "'" && !QUOTE_SAFE.test(call) && !num) return at('single-quoted-attr', true)
    if (URL_ATTRS.includes(c.name)) {
      const escHref = call === 'escapeHtml' && (n as ts.CallExpression).arguments.length === 1 &&
        ts.isCallExpression(strip((n as ts.CallExpression).arguments[0])) && calleeName(strip((n as ts.CallExpression).arguments[0]) as ts.CallExpression) === 'safeHref'
      if (escHref || (/^\/[\w.~%-]/.test(c.value) && textSafe(n, before, slot.node, seen, true))) return
      return at(`url:${c.name}`, c.name !== 'src' && c.name !== 'poster')
    }
    if (c.name.startsWith('on')) {
      if (inJsString(c.value)) return at('handler-arg-in-js-string', true)
      if (call !== 'jsArg') at('handler', true)
      return
    }
    if (CSS_ATTRS.includes(c.name)) return judgeCssAttr(n, slot.node)
    if (!textSafe(n, before, slot.node, seen, true)) at(`attr:${c.name}`, false)
  }
  // a leaf that is safe as HTML text; composite safe forms (t() params,
  // map callbacks, joined arrays) report their own failing parts and pass
  const textSafe = (n0: ts.Expression, before: string, slotNode: ts.Node, seen: Set<ts.Symbol>, report: boolean): boolean => {
    const n = strip(n0)
    if (isLit(n)) return true
    if (ts.isPrefixUnaryExpression(n) || ts.isPostfixUnaryExpression(n) || ts.isTypeOfExpression(n) || ts.isVoidExpression(n)) return true
    if (ts.isBinaryExpression(n)) {
      const k = n.operatorToken.kind
      return k >= ts.SyntaxKind.FirstBinaryOperator && k <= ts.SyntaxKind.LastBinaryOperator && ![ts.SyntaxKind.PlusToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken,
        ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.CommaToken].includes(k) && !ASSIGN_OPS.has(k)
    }
    // the length of an array a method or Object.keys() just built (data
    // cannot carry a function, so these never return a non-array)
    if (ts.isPropertyAccessExpression(n) && n.name.text === 'length' && ts.isCallExpression(strip(n.expression)) &&
      /^(\?\.(filter|map|slice|split|concat|flat|flatMap)|Object\.(keys|values|entries)|Array\.from)$/.test(calleeName(strip(n.expression) as ts.CallExpression))) return true
    if (!ts.isCallExpression(n)) return false
    const name = calleeName(n)
    // (CSS.escape backslash-escapes, it keeps '<': not an HTML escaper)
    if ((ESCAPERS.test(name) && name !== 'CSS.escape') || /^\?\.(toFixed|toLocaleDateString|toLocaleTimeString)$/.test(name)) return true
    // a Date formatter on a Date built right here
    if (/^\?\.(toLocaleString|toISOString)$/.test(name)) {
      const r = strip((n.expression as ts.PropertyAccessExpression).expression)
      if (ts.isNewExpression(r) && ts.isIdentifier(r.expression) && r.expression.text === 'Date') return true
    }
    const slot: Slot = { node: slotNode, ctx: 'text', root: false }
    const sub = (e: ts.Expression) => { if (report) html(e, before, slot, seen); else if (!quiet(e, seen)) throw new Error('unsafe') }
    try {
      // t('key', { p: safe }) of a key without brand tokens; tr('key', 'lit')
      if (name === 't' || name === 'tr') {
        const [key, arg] = n.arguments
        if (!key || !ts.isStringLiteral(key) || brandKeys.has(key.text)) return false
        if (name === 'tr') return !arg || ts.isStringLiteral(arg)
        if (!arg) return n.arguments.length === 1
        if (!ts.isObjectLiteralExpression(arg) || n.arguments.length > 2) return false
        for (const p of arg.properties) {
          if (ts.isPropertyAssignment(p)) sub(p.initializer)
          else if (ts.isShorthandPropertyAssignment(p)) sub(p.name)
          else return false
        }
        return true
      }
      // xs.join(lit) of an array whose elements are safe
      if (name === '?.join') {
        const sep = n.arguments[0]
        if (sep && !ts.isStringLiteralLike(sep)) return false
        if (!report) return false
        array((n.expression as ts.PropertyAccessExpression).expression, before, slot, seen)
        return true
      }
      // a literal transform of safe text
      if (/^\?\.(replace|replaceAll|trim)$/.test(name) && n.arguments.every(a => isLit(a) || ts.isRegularExpressionLiteral(a))) {
        sub((n.expression as ts.PropertyAccessExpression).expression)
        return true
      }
    } catch { return false }
    return false
  }
  // the same check without reporting (a URL template's parts)
  const quiet = (n0: ts.Expression, seen: Set<ts.Symbol>): boolean => {
    const n = strip(n0)
    if (ts.isConditionalExpression(n)) return quiet(n.whenTrue, seen) && quiet(n.whenFalse, seen)
    if (ts.isBinaryExpression(n) && [ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.PlusToken].includes(n.operatorToken.kind)) return quiet(n.left, seen) && quiet(n.right, seen)
    if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) return quiet(n.right, seen)
    if (ts.isIdentifier(n) && !isLit(n)) {
      const s = symOf(n)
      if (s && seen.has(s)) return true
      const vs = valuesOf(n)
      return !!vs && vs.every(v => quiet(v.value, s ? new Set(seen).add(s) : seen))
    }
    return textSafe(n, '', n, seen, false)
  }
  // an array whose elements are printed by join()
  const array = (n0: ts.Expression, before: string, slot: Slot, seen: Set<ts.Symbol>): void => {
    const n = strip(n0)
    const bad = () => { const c = contextAt(before); put(slot.node, c.kind === 'attr' ? `attr:${c.name}` : slot.ctx, false) }
    if (ts.isArrayLiteralExpression(n)) {
      for (const el of n.elements) {
        if (ts.isSpreadElement(el)) array(el.expression, before, slot, seen)
        else html(el, before, slot.root ? { node: el, ctx: slot.ctx, root: true } : slot, seen)
      }
      return
    }
    if (ts.isIdentifier(n)) {
      const vs = valuesOf(n)
      const s = symOf(n)
      if (!vs) return bad()
      if (s && seen.has(s)) return
      const next = s ? new Set(seen).add(s) : seen
      for (const v of vs) {
        const vslot: Slot = { node: v.value, ctx: 'builder', root: true }
        if (v.elem) html(v.value, before, vslot, next)
        else array(v.value, before, vslot, next)
      }
      return
    }
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)) {
      const m = n.expression.name.text
      const recv = n.expression.expression
      if (m === 'map') {
        const cb = n.arguments[0] && strip(n.arguments[0])
        if (cb && ts.isIdentifier(cb) && (/^(escapeHtml|esc)$/.test(cb.text) || (HTML_OUT.test(cb.text) && contextAt(before).kind === 'text'))) return
        const f = cb && localFn(cb)
        if (f) return returnsOf(f).forEach(r => html(r, before, f === cb ? slot : { node: r, ctx: 'return', root: true }, seen))
        return bad()
      }
      if (/^(filter|slice|reverse|sort|flat|concat)$/.test(m)) {
        array(recv, before, slot, seen)
        if (m === 'concat') n.arguments.forEach(a => array(a, before, slot, seen))
        return
      }
    }
    bad()
  }
  // the values a function returns (a concise body, or every return of its
  // own body -- not of nested functions)
  const returnsOf = (f: ts.FunctionLikeDeclaration): ts.Expression[] => {
    if (!f.body) return []
    if (!ts.isBlock(f.body)) return [f.body]
    const out: ts.Expression[] = []
    const visit = (n: ts.Node): void => {
      if (ts.isReturnStatement(n)) { if (n.expression) out.push(n.expression) }
      else if (!isFnLike(n)) ts.forEachChild(n, visit)
    }
    ts.forEachChild(f.body, visit)
    return out
  }
  const sink = (v: ts.Expression, ctx: string) => html(v, '', { node: v, ctx, root: true }, new Set())

  // ---- selectors: every interpolated / concatenated part through CSS.escape
  const selector = (n0: ts.Expression, part: ts.Node | null, seen = new Set<ts.Symbol>()): void => {
    const n = strip(n0)
    if (isLit(n)) return
    if (ts.isConditionalExpression(n)) { selector(n.whenTrue, part, seen); selector(n.whenFalse, part, seen); return }
    if (ts.isBinaryExpression(n) && [ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(n.operatorToken.kind)) { selector(n.left, part, seen); selector(n.right, part, seen); return }
    if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.PlusToken) { selector(n.left, part ?? n.left, seen); selector(n.right, part ?? n.right, seen); return }
    if (ts.isTemplateExpression(n)) { handled.add(n); n.templateSpans.forEach(s => selector(s.expression, s.expression, seen)); return }
    if (!part) return // a whole non-composite argument is not modelled
    if (ts.isCallExpression(n) && calleeName(n) === 'CSS.escape') return
    if (ts.isIdentifier(n)) {
      const s = symOf(n)
      const vs = valuesOf(n)
      if (s && seen.has(s)) return
      if (vs) { if (s) seen.add(s); vs.forEach(v => selector(v.value, part, seen)); return }
    }
    put(part, 'selector', true)
  }

  // ---- the sink pass
  const htmlFnName = (f: ts.Node) => {
    const name = ownName(f)
    return !!name && /(Html|HTML|Icon)$/.test(name) && !NOT_HTML_FNS.test(name)
  }
  const visit = (n: ts.Node): void => {
    if (ts.isBinaryExpression(n) && ASSIGN_OPS.has(n.operatorToken.kind)) {
      const l = strip(n.left)
      const v = n.right
      const name = propName(l)
      const bracket = ts.isElementAccessExpression(l)
      if (name && RULES.htmlSinkProps.includes(name)) {
        const e = strip(v)
        if (ts.isCallExpression(e) && ts.isIdentifier(e.expression) && e.expression.text === 't') put(v, 'innerHTML=t(', true)
        else sink(v, 'innerHTML=')
      } else if (name && RULES.urlWriteProps.concat(bracket ? RULES.urlWriteBracketProps : []).includes(name)) {
        judgeUrl(name === 'href' ? '.href=' : '.src=', name.toLowerCase(), v, false)
      } else if (name && (RULES.scriptProps.includes(name) || (bracket && RULES.scriptBracketProps.some(x => x === 'on*' ? /^on[a-z]+$/.test(name) : x === name)))) {
        put(v, 'script-sink', true, norm(`${name} = ${v.getText(sf)}`))
      } else if (name === 'style') {
        if (ts.isTemplateExpression(strip(v))) tplCss(strip(v), true)
        else if (!isLit(v)) put(v, 'style-prop', true, norm(`style = ${v.getText(sf)}`))
      } else if ((ts.isPropertyAccessExpression(l) || ts.isElementAccessExpression(l)) && propName(l.expression as ts.Expression) === 'style' && ts.isPropertyAccessExpression(l.expression)) {
        const prop = name ?? '--dynamic'
        if (prop === 'cssText') {
          if (ts.isTemplateExpression(strip(v))) tplCss(strip(v), false)
          else if (!cssSafe(v)) put(v, 'style.cssText=', false)
        } else judgeCssValue(prop, v)
      } else if (ts.isIdentifier(l) && l.text === 'location' || (name === 'location' && !bracket)) {
        if (!urlOk(v)) put(v, 'location=', false)
      } else if (ts.isIdentifier(l) && /(Html|HTML)$/.test(l.text)) sink(v, '*Html=')
    } else if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && /(Html|HTML)$/.test(n.name.text) && n.initializer && !isFnLike(strip(n.initializer))) {
      sink(n.initializer, '*Html=')
    } else if (ts.isReturnStatement(n) && n.expression) {
      let f: ts.Node | undefined = n.parent
      while (f && !isFnLike(f)) f = f.parent
      if (f && htmlFnName(f)) sink(n.expression, 'return-of-*Html')
    } else if (ts.isArrowFunction(n) && !ts.isBlock(n.body) && htmlFnName(n)) {
      sink(n.body, 'return-of-*Html')
    } else if (ts.isCallExpression(n)) {
      const name = calleeName(n)
      const [a0, a1] = n.arguments
      const htmlCall = Object.prototype.hasOwnProperty.call(RULES.htmlSinkCalls, name) ? RULES.htmlSinkCalls[name] : undefined
      if (htmlCall) { if (n.arguments[htmlCall[0]]) sink(n.arguments[htmlCall[0]], htmlCall[1]) }
      else if (RULES.selectorCalls.includes(name)) { if (a0) selector(a0, null) }
      else if (name === '?.insertRule' && a0 && !ts.isStringLiteral(strip(a0))) put(a0, 'insertRule', true)
      else if (name === 'Object.assign' && a0 && propName(strip(a0)) === 'style') put(n, 'style-object', true)
      else if (name === 'window.open' && a0 && !urlOk(a0)) put(a0, 'window.open', false)
      else if (/^(\?|location)\.(assign|replace)$/.test(name) && ts.isPropertyAccessExpression(n.expression) && /location$/.test(n.expression.expression.getText(sf)) && a0 && !urlOk(a0)) put(a0, 'location.assign', false)
      else if (name === '?.setProperty' && a1) {
        const prop = ts.isStringLiteral(a0) ? a0.text : '--dynamic'
        if (ts.isTemplateExpression(strip(a1))) tplCss(strip(a1), !ts.isStringLiteral(a0) || URL_PROP.test(prop))
        else judgeCssValue(prop, a1)
      } else if (name === '?.setAttribute' && a1) {
        if (!ts.isStringLiteralLike(a0)) { if (!isLit(a1)) put(a1, 'setAttribute(computed name)', false, norm(`${a0.getText(sf)}, ${a1.getText(sf)}`)) }
        else {
          const attr = a0.text.toLowerCase()
          if (isScriptAttr(attr)) put(a1, 'script-sink', true, norm(`setAttribute(${a0.getText(sf)}, ${a1.getText(sf)})`))
          else if (URL_ATTRS.includes(attr)) judgeUrl('setAttribute(url)', attr, a1, true)
          else if (CSS_ATTRS.includes(attr)) judgeCssValue(attr === 'fill' || attr === 'stroke' ? attr : `attr:${attr}`, a1)
        }
      }
      // an HTML translation (*_html key, data-i18n-html) only through tHtml
      if (name === 't' && n.arguments.some(a => (ts.isStringLiteralLike(a) && /_html$/.test(a.text)) || /i18nHtml/.test(a.getText(sf)))) put(n, 'html-key-needs-tHtml', true)
      // escaped text is never cut afterwards (it splits entities): escSnippet()
      if (RULES.cutMethods.some(m => name === `?.${m}`)) {
        let r = strip((n.expression as ts.PropertyAccessExpression).expression)
        while (ts.isCallExpression(r) && calleeName(r) === '?.replace') r = strip((r.expression as ts.PropertyAccessExpression).expression)
        if (ts.isCallExpression(r) && RULES.cutEscapers.includes(calleeName(r))) put(n, 'slice-after-escape', true)
      }
    }
    ts.forEachChild(n, visit)
  }
  visit(sf)

  // ---- markup built anywhere else: every template / '+' chain with a tag,
  // and attribute-selector templates
  const MARKUP = /<[a-zA-Z/!]/
  const catchAll = (n: ts.Node): void => {
    if (handled.has(n)) return
    if (ts.isTemplateExpression(n)) {
      const raw = n.head.text + n.templateSpans.map(s => 'X' + s.literal.text).join('')
      if (MARKUP.test(raw)) { sequence(n, '', { node: n, ctx: 'text', root: false }, new Set()); return }
      if (/\[[\w-]+[~|^$*]?=\s*["']?X/.test(raw)) { selector(n, null); return }
    }
    if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const lits: string[] = []
      const collect = (e: ts.Expression): void => {
        if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.PlusToken) { collect(e.left); collect(e.right) }
        else if (ts.isStringLiteralLike(e)) lits.push(e.text)
      }
      collect(n)
      if (lits.some(l => MARKUP.test(l))) { sequence(n, '', { node: n, ctx: 'concat', root: true }, new Set()); return }
    }
    ts.forEachChild(n, catchAll)
  }
  catchAll(sf)

  const all = [...loose, ...found.values()].sort((a, b) => a.line - b.line)
  const out = (strict: boolean): Interp[] => all.filter(x => x.strict === strict).map(({ line, context, expr, fn }) => ({ line, context, expr, fn }))
  return { strict: out(true), review: out(false) }
}

// the allowlist key: function chain, the context the value is printed in, expression
export const allowKey = (r: Pick<Interp, 'fn' | 'context' | 'expr'>) => `${r.fn}::${r.context}::${r.expr}`

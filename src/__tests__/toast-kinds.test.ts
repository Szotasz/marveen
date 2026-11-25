// The toast had one look for everything: an error read like a "saved" (Szabolcs on #2583, the type word did not
// colour anything). showToast(msg, x) now takes a kind as its second argument ('error' | 'success' | 'warn', or
// { kind, duration }), and the kind colours it. The first block marks every refusal the server gave as an error.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import ts from 'typescript'

const APP = readFileSync(new URL('../../web/app.js', import.meta.url), 'utf-8')
const CSS = readFileSync(new URL('../../web/style.css', import.meta.url), 'utf-8')
const slice = (from: string) => {
  const i = APP.indexOf(from)
  const j = i < 0 ? -1 : APP.indexOf('\n}\n', i)
  return i < 0 || j < 0 ? '' : APP.slice(i, j + 2)
}
const SRC = slice('function showToast(') + slice('function toastDuration(')
const KINDS = ['error', 'success', 'warn']

function show(...calls: unknown[][]): { classes: Set<string>; delays: number[] } {
  const classes = new Set<string>()
  const delays: number[] = []
  const toast = {
    textContent: '',
    classList: {
      add: (c: string) => { classes.add(c) },
      remove: (c: string) => { classes.delete(c) },
      toggle: (c: string, on: boolean) => { if (on) classes.add(c); else classes.delete(c) },
    },
  }
  const setTimeout = (_fn: () => void, ms: number) => { delays.push(ms) }
  new Function('toast', 'setTimeout', 'calls', `${SRC}\nfor (const args of calls) showToast(...args)`)(toast, setTimeout, calls)
  return { classes, delays }
}
const kindsOf = (classes: Set<string>) => [...classes].filter(c => c.startsWith('toast-')).sort()

// Every showToast(...) call in app.js with its arguments split at the top level. Quotes, template literals (with
// their ${...} parts) and nested brackets are skipped, so a comma or a paren inside a string never splits.
function calls(src: string): Array<{ line: number; args: string[]; at: number }> {
  const out: Array<{ line: number; args: string[]; at: number }> = []
  const re = /(?<![\w.])showToast\(/g
  let m: RegExpExecArray | null
  while ((m = re.exec(src))) {
    if (src.slice(Math.max(0, m.index - 9), m.index) === 'function ') continue
    let i = m.index + m[0].length
    const args: string[] = []
    let cur = ''
    const stack: string[] = [')']
    while (stack.length) {
      const c = src[i]
      const top = stack[stack.length - 1]
      if (top === '`') {
        if (c === '\\') { cur += c + src[i + 1]; i += 2; continue }
        if (c === '`') stack.pop()
        else if (c === '$' && src[i + 1] === '{') { stack.push('}'); cur += c; i++ }
        cur += src[i]; i++; continue
      }
      if (c === "'" || c === '"') {
        let k = i + 1
        while (src[k] !== c) k += src[k] === '\\' ? 2 : 1
        cur += src.slice(i, k + 1); i = k + 1; continue
      }
      if (c === '`') { stack.push('`'); cur += c; i++; continue }
      if (c === '(' || c === '[' || c === '{') stack.push(c === '(' ? ')' : c === '[' ? ']' : '}')
      else if (c === top) {
        stack.pop()
        if (!stack.length) break
      } else if (c === ',' && stack.length === 1) { args.push(cur.trim()); cur = ''; i++; continue }
      cur += c; i++
    }
    if (cur.trim()) args.push(cur.trim())
    out.push({ line: src.slice(0, m.index).split('\n').length, args, at: m.index })
  }
  return out
}
const ALL = calls(APP)
const kindArg = (args: string[]) => {
  const a = args[1] ?? ''
  const lit = a.match(/^'([a-z]+)'$/)
  if (lit) return lit[1]
  const obj = a.match(/^\{[^}]*\bkind: '([a-z]+)'[^}]*\}$/)
  return obj ? obj[1] : null
}

describe('showToast takes a kind', () => {
  it('the functions were found', () => {
    expect(SRC).toContain('function showToast(')
    expect(SRC).toContain('function toastDuration(')
  })

  it("'error', 'success' and 'warn' colour it, with the default duration", () => {
    for (const k of KINDS) {
      const r = show(['x', k])
      expect(kindsOf(r.classes)).toEqual([`toast-${k}`])
      expect(r.classes.has('visible')).toBe(true)
      expect(r.delays).toEqual([3000])
    }
  })

  it('{ kind, duration } gives both; a kind without a duration has the default', () => {
    const r = show(['x', { kind: 'error', duration: 8000 }])
    expect(kindsOf(r.classes)).toEqual(['toast-error'])
    expect(r.delays).toEqual([8000])
    expect(show(['x', { kind: 'warn' }]).delays).toEqual([3000])
  })

  it('a number, or nothing, is the neutral toast as before', () => {
    expect(kindsOf(show(['x', 6000]).classes)).toEqual([])
    expect(show(['x', 6000]).delays).toEqual([6000])
    expect(kindsOf(show(['x']).classes)).toEqual([])
  })

  it('an unknown kind is none, never a class of its own', () => {
    for (const k of ['danger', 'Error', 'visible', '']) {
      const r = show(['x', k])
      expect([...r.classes]).toEqual(['visible'])
      expect(r.delays).toEqual([3000])
    }
    expect([...show(['x', { kind: 'toast' }]).classes]).toEqual(['visible'])
  })

  it('the next toast does not keep the kind of the one before', () => {
    expect(kindsOf(show(['x', 'error'], ['y']).classes)).toEqual([])
    expect(kindsOf(show(['x', 'error'], ['y', 'success']).classes)).toEqual(['toast-success'])
  })
})

describe('the colours', () => {
  const lum = (hex: string) => {
    const c = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255)
      .map(x => (x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4))
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]
  }
  const ratio = (a: string, b: string) => {
    const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x)
    return (hi + 0.05) / (lo + 0.05)
  }
  const root = CSS.slice(CSS.indexOf(':root'), CSS.indexOf('}', CSS.indexOf(':root')))
  const resolve = (v: string) => {
    const name = v.match(/^var\((--[\w-]+)\)$/)?.[1]
    return name ? root.match(new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})`))?.[1] ?? '' : v
  }

  it.each(KINDS)('.toast-%s has its own background, and white text on it is at least 4.5:1', (k) => {
    const rule = CSS.match(new RegExp(`\\.toast\\.toast-${k} \\{([^}]*)\\}`))?.[1] ?? ''
    const bg = resolve(rule.match(/background: ([^;]+);/)?.[1]?.trim() ?? '')
    expect(rule).toContain('color: #fff;')
    expect(bg).toMatch(/^#[0-9a-fA-F]{6}$/)
    expect(ratio(bg, '#ffffff')).toBeGreaterThanOrEqual(4.5)
  })

  it('the dark theme leaves the three backgrounds alone (no --danger of its own), so they read the same', () => {
    const dark = CSS.slice(CSS.indexOf('[data-theme="dark"] {'), CSS.indexOf('}', CSS.indexOf('[data-theme="dark"] {')))
    expect(dark).not.toMatch(/--danger:/)
  })
})

describe('the callers', () => {
  it('the calls were found', () => {
    expect(ALL.length).toBeGreaterThan(300)
  })

  it('a kind given as a word is always one showToast knows', () => {
    const bad = ALL.filter(c => /^'[^']*'$/.test(c.args[1] ?? '') && !KINDS.includes(kindArg(c.args) ?? ''))
      .concat(ALL.filter(c => /^\{.*\bkind:/.test(c.args[1] ?? '') && !KINDS.includes(kindArg(c.args) ?? '')))
    expect(bad.map(c => `${c.line}: ${c.args[1]}`)).toEqual([])
  })

  it('every refusal from the server is an error toast (refusalReason, common.not_done)', () => {
    const refusals = ALL.filter(c => /\brefusalReason\(|'common\.not_done'/.test(c.args[0] ?? ''))
    expect(refusals.length).toBeGreaterThanOrEqual(23)
    expect(refusals.filter(c => kindArg(c.args) !== 'error').map(c => `${c.line}: ${c.args.join(', ')}`)).toEqual([])
  })

  it('a refusal thrown to the catch is an error toast there too', () => {
    const missed: string[] = []
    let n = 0
    for (let t = APP.indexOf('throw new Error(refusalReason('); t >= 0; t = APP.indexOf('throw new Error(refusalReason(', t + 1)) {
      const c = APP.indexOf('catch (', t)
      const first = ALL.find(x => x.at > c)
      n++
      if (!first || kindArg(first.args) !== 'error') missed.push(`${APP.slice(0, t).split('\n').length}: ${first?.args.join(', ')}`)
    }
    expect(n).toBeGreaterThanOrEqual(6)
    expect(missed).toEqual([])
  })
})

// Block 2: whatever a catch clause shows is an error (a failed fetch, a thrown refusal, a bad file). The typescript
// parser finds the clauses, so a nested function or a try inside a catch is counted the way the code runs it.
// Every showToast call, from the typescript parser: its line, its text, its message argument, the kind (null when there
// is none, or when it is not a plain word or { kind: '...' }), and whether a catch clause shows it.
type Toast = { line: number; text: string; msg: string; kind: string | null; caught: boolean }
const TOASTS: Toast[] = (() => {
  const sf = ts.createSourceFile('app.js', APP, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
  const kindOf = (a: ts.Expression | undefined): string | null => {
    if (!a) return null
    if (ts.isStringLiteral(a)) return a.text
    if (ts.isObjectLiteralExpression(a)) {
      const p = a.properties.find(p => ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === 'kind')
      return p && ts.isPropertyAssignment(p) && ts.isStringLiteral(p.initializer) ? p.initializer.text : null
    }
    return null
  }
  const out: Toast[] = []
  const visit = (n: ts.Node, caught: boolean): void => {
    if (ts.isCatchClause(n)) caught = true
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'showToast') {
      out.push({
        line: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1,
        text: n.getText(sf).replace(/\s+/g, ' '),
        msg: n.arguments[0] ? n.arguments[0].getText(sf).replace(/\s+/g, ' ') : '',
        kind: kindOf(n.arguments[1]),
        caught,
      })
    }
    ts.forEachChild(n, ch => visit(ch, caught))
  }
  visit(sf, false)
  return out
})()

describe('the catch toasts', () => {
  // The one catch toast that is not an error: the invite was created, only copying its link to the clipboard failed,
  // and the toast says the invite is there.
  const NOT_ERRORS = ['channel.toast.invite_created']
  const inCatch = TOASTS.filter(c => c.caught)

  it('the catch toasts were found', () => {
    expect(inCatch.length).toBeGreaterThanOrEqual(120)
  })

  it('every toast in a catch clause is an error toast', () => {
    const missed = inCatch.filter(c => c.kind !== 'error' && !NOT_ERRORS.some(k => c.text.includes(`'${k}'`)))
    expect(missed.map(c => `${c.line}: ${c.text}`)).toEqual([])
  })

  it('the exception is still a catch toast, and still neutral', () => {
    for (const k of NOT_ERRORS) {
      const hits = inCatch.filter(c => c.text.includes(`'${k}'`))
      expect(hits.length).toBe(1)
      expect(hits[0].kind).toBeNull()
    }
  })

  it('a duration the catch toast had is kept next to the kind', () => {
    for (const k of ['channel.toast.reconnect_error', 'channel.smoke_test.error', 'updates.rebase.plan_error']) {
      expect(inCatch.find(c => c.text.includes(`'${k}'`))?.text).toMatch(/\{ kind: 'error', duration: \d+ \}\)$/)
    }
  })
})

// Block 3: a failure outside a catch. A toast whose message is an error key (…_error, …error_…, …failed, …errors) or
// the error the server sent (data.error, err.error, 'HTTP ' + status) is an error toast, or a warning where the step
// was not lost: the save went through and only the restart failed, the rebase plan only predicts a failure, the
// status poll ran out without an outcome, the update applied but needs a human, a probe was throttled. A rolled-back
// update is a failure without an error key, so it is named. What the owner chose (a request denied, a skill or a breakdown rejected)
// carries no error key and stays neutral.
describe('the failures outside a catch', () => {
  const ERROR_SHAPED = /'[\w.]*[._](error|errors|failed)(_\w+)?'|\b(data|err|e|body|approval|plan)\.errors?\b|'HTTP '/
  const WARN = ['agents.channel.saved_restart_failed', 'updates.rebase.will_fail', 'updates.toast.status_timeout',
    'updates.toast.warning', 'settings.claude_plans.probe_throttled']
  const shaped = TOASTS.filter(c => ERROR_SHAPED.test(c.msg))

  it('the error-shaped toasts were found', () => {
    expect(shaped.filter(c => !c.caught).length).toBeGreaterThanOrEqual(60)
  })

  it('every error-shaped toast is an error toast, or one of the warnings', () => {
    const bad = shaped.filter(c => (WARN.some(k => c.msg.includes(`'${k}'`)) ? c.kind !== 'warn' : c.kind !== 'error'))
    expect(bad.map(c => `${c.line}: ${c.text}`)).toEqual([])
  })

  it('the warnings are still there, each a warning; a rolled-back update is an error', () => {
    for (const k of WARN) {
      const hits = TOASTS.filter(c => c.msg.includes(`'${k}'`))
      expect(hits.length).toBeGreaterThanOrEqual(1)
      expect(hits.every(c => c.kind === 'warn')).toBe(true)
    }
    // The Slack scopes the token lacks: the message is built into msg first.
    expect(APP).toContain("const msg = t('channel.toast.missing_scopes'")
    expect(APP).toContain("showToast(msg, { kind: 'warn', duration: 12000 })")
    expect(TOASTS.filter(c => c.msg.includes("'updates.toast.rolled_back'")).map(c => c.kind)).toEqual(['error'])
  })

  it('a model saved for a stopped agent is no failure; a failed restart is', () => {
    expect(APP).toContain("if (restartRes.status === 409) showToast(t('agents.toast.model_saved_stopped'))\n      else showToast(t('agents.restart_failed'), 'error')")
  })

  it("what the owner chose stays neutral", () => {
    for (const k of ['channel.toast.denied', 'kanban.toast.breakdown_rejected', 'skills.pending.rejected']) {
      const hits = TOASTS.filter(c => c.msg.includes(`'${k}'`))
      expect(hits.length).toBe(1)
      expect(hits[0].kind).toBeNull()
    }
  })
})

// Block 4: what the owner has to fix, or what the dashboard does not allow, is a warning: nothing broke, the step just
// cannot go on like this. An empty required field, a wrong file, a card someone else changed meanwhile, a step only the
// owner may take, a team move that would make a loop. What only informs, or follows the owner's own choice, stays
// neutral.
describe('the warnings: something to fix, or a step that is not allowed', () => {
  const WARN_KEYS = [
    'kanban.toast.blocker_not_on_board', 'kanban.toast.stale_version_form', 'kanban.toast.stale_version',
    'kanban.toast.comment_no_author', 'kanban.breakdown.select_one', 'common.owner_session_required',
    'agents.model.custom_model_required', 'agents.settings.ctx_guard_pct_hint', 'agents.toast.avatar_format',
    'agents.toast.avatar_size', 'agents.main_auth.unverified', 'skills.toast.name_required', 'skills.toast.desc_required',
    'skills.toast.select_file', 'tasks.expand.need_answer', 'tasks.toast.select_schedule', 'connectors.toast.required_field',
    'vault.ssh.toast.label_user_required', 'vault.scan.none_selected', 'memories.toast.select_files',
    'memories.toast.no_content', 'fleet.import.no_file', 'team.drop.cycle', 'bgTasks.select_agent', 'bgTasks.enter_task',
    'fleet_freeze.toast.owner_only', 'ideas.toast.no_subtasks', 'terminal.input_off',
    // An error until this block; an empty title is something to fix like the other required fields.
    'ideas.form.title_required',
  ]
  const withKey = (k: string) => TOASTS.filter(c => c.msg.includes(`'${k}'`))

  it('every listed toast is there, and each is a warning', () => {
    const bad: string[] = []
    let n = 0
    for (const k of WARN_KEYS) {
      const hits = withKey(k)
      if (!hits.length) bad.push(`${k}: not found`)
      for (const c of hits) { n++; if (c.kind !== 'warn') bad.push(`${c.line}: ${c.text}`) }
    }
    expect(bad).toEqual([])
    expect(n).toBeGreaterThanOrEqual(35)
  })

  it('a required field or a missing choice is a warning wherever it is said, a new one too', () => {
    const shaped = TOASTS.filter(c => /'[\w.]*(_required|\.select_\w+|_no_\w+|\.no_\w+)'|t\(missing\[1\]\)/.test(c.msg))
    expect(shaped.length).toBeGreaterThanOrEqual(15)
    expect(shaped.filter(c => c.kind !== 'warn').map(c => `${c.line}: ${c.text}`)).toEqual([])
  })

  it('a settings reset that partly failed is an error, with its duration', () => {
    expect(withKey('settings.toast.reset_tab_partial').map(c => c.text)).toEqual([
      "showToast(t('settings.toast.reset_tab_partial'), { kind: 'error', duration: 6000 })",
    ])
  })

  it('what only informs, or follows the owner\'s choice, stays neutral', () => {
    for (const k of ['agents.wizard.already_created', 'agents.toast.restart_not_forced', 'agents.import.fleet_kept',
      'memories.toast.delete_pending']) {
      const hits = withKey(k)
      expect(hits.length).toBeGreaterThanOrEqual(1)
      expect(hits.every(c => c.kind === null)).toBe(true)
    }
  })
})

// Block 5: a step that is done is green. What is still running or waiting (a restart, an approval, the AI), what only
// informs, and what follows the owner's own "no" stays neutral. Where one call can end two ways, the kind follows the
// outcome: saved but not restarted, connected with a caveat, or a team saved with something dropped is amber.
describe('the successes: the step is done', () => {
  const NEUTRAL_KEYS = [
    'kanban.toast.breakdown_rejected', 'agents.wizard.already_created', 'agents.toast.restart_not_forced',
    'agents.toast.model_save_restart', 'agents.toast.model_saved_stopped', 'agents.import.fleet_kept',
    'channel.toast.invite_created', 'channel.toast.invite_pending', 'channel.toast.denied',
    'memories.toast.delete_pending', 'vault.sync.nothing', 'skills.pending.rejected', 'updates.cli.started',
    'updates.diagnose.already', 'updates.diagnose.started', 'updates.toast.applying', 'ideas.toast.ai_elaborating',
    'agents.auth.toast_started', 'federation.routing.toast_set',
  ]
  const withKey = (k: string) => TOASTS.filter(c => c.msg.includes(`'${k}'`))

  it('the plain successes are green', () => {
    expect(TOASTS.filter(c => c.kind === 'success').length).toBeGreaterThanOrEqual(100)
    for (const k of ['kanban.toast.card_created', 'agents.toast.deleted', 'common.toast.copied', 'tasks.toast.updated',
      'vault.weblogin.toast.deleted', 'settings.toast.saved', 'updates.toast.success', 'notes.toast.added']) {
      const hits = withKey(k)
      expect(hits.length, k).toBeGreaterThanOrEqual(1)
      expect(hits.every(c => c.text.includes("'success'")), k).toBe(true)
    }
  })

  it('a key that says it is done is green wherever it is said, a new one too', () => {
    const done = TOASTS.filter(c => /'[\w.]*[._](saved|created|updated|deleted|added|removed|copied)'/.test(c.msg)
      && !NEUTRAL_KEYS.some(k => c.msg.includes(`'${k}'`)))
    expect(done.length).toBeGreaterThanOrEqual(45)
    expect(done.filter(c => !c.text.includes("'success'")).map(c => `${c.line}: ${c.text}`)).toEqual([])
  })

  it('a call that can end two ways takes its kind from the outcome', () => {
    for (const piece of [
      "'agents.main_auth.saved_not_restarted'), restarted ? 'success' : 'warn')",
      "showToast(parts.join(' '), data.kind === 'fleet' && (data.skipped || []).length ? 'warn' : 'success')",
      "result.pollerNote ? { kind: 'warn', duration: 10000 } : 'success')",
      "showToast(t('channel.toast.test_ok') + suffix, secretNeedsCare ? { kind: 'warn', duration: 8000 } : { kind: 'success', duration: suffix ? 8000 : 3000 })",
      "t('skills.toast.added'), created.pending ? undefined : 'success')",
      "{ list: importedList.join(', ') }), result.pending ? undefined : 'success')",
      "t('messages.sent'), reply.body.queued === true ? 6000 : { kind: 'success', duration: 3000 })",
      "t('team.save_ok'), warningMsg ? 'warn' : 'success')",
      "'approvals.toast.rejected'), decision === 'approved' ? 'success' : undefined)",
      "{ label: data.label || data.id }), data.verified ? 'success' : 'warn')",
    ]) expect(APP, piece).toContain(piece)
  })

  it('a Teams secret that needs care makes the working connection amber', () => {
    expect(APP).toContain("const secretNeedsCare = ['missing', 'invalid', 'soon', 'expired'].includes(exp?.state)")
  })

  it('what is still running, only informs, or follows the owner\'s no stays neutral', () => {
    for (const k of NEUTRAL_KEYS) {
      const hits = withKey(k)
      expect(hits.length, k).toBeGreaterThanOrEqual(1)
      expect(hits.filter(c => c.kind !== null).map(c => `${c.line}: ${c.text}`), k).toEqual([])
    }
  })
})

// PANEFOOTEROUTSIDE1114: ONE footer anchor, three implementations.
//
// liveFooterLine (src/pane-state.ts) is the rule. Two consumers cannot import
// it: scripts/stuck-modal-guard.sh is a recovery path that must run without
// node or the built tree, and scripts/telegram-live-progress.py is a Python
// daemon. Each carries a port (`stuck-modal-guard.sh footer-line`,
// `live_footer_line` in the Python file), and this test runs all three over
// one corpus and fails on ANY difference.
//
// It must never pass without running a port: bash and python3 are started
// without a fallback (a missing interpreter throws, and the test fails), and
// every port has to answer for every case.
import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { liveFooterLine } from '../pane-state.js'
import { unlockPaneReady } from '../web/channel-plugin-unlock.js'

const REPO = join(__dirname, '..', '..')
const GUARD = join(REPO, 'scripts', 'stuck-modal-guard.sh')
const PROGRESS = join(REPO, 'scripts', 'telegram-live-progress.py')
const FIXTURES = join(__dirname, 'fixtures', 'pane')
const FOOTERS = join(FIXTURES, 'footer-2.1.325')

const RULE = '─'.repeat(80)
const QUOTES = [
  '  ⎿  ⏵⏵ bypass permissions on · 1 shell · ↓ to manage',
  '  ⎿  ⏸ manual mode on · ? for shortcuts',
  'the log said: bypass permissions on (shift+tab to cycle)',
  '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
  'Press ? for shortcuts to see them.',
]
const DIALOG = [
  '╭' + '─'.repeat(40),
  ' Bash command',
  '   echo hi',
  ' Do you want to proceed?',
  ' ❯ 1. Yes',
  '   2. No, and tell Claude what to do differently (esc)',
]

function corpus(): Array<[string, string]> {
  const out: Array<[string, string]> = []
  // Claude Code 2.1.325 footers (seven modes, 60 and 80 columns), each as
  // captured, under output, under a quote, and with the box replaced by a dialog.
  for (const name of readdirSync(FOOTERS).sort()) {
    const box = readFileSync(join(FOOTERS, name), 'utf8').replace(/\n+$/, '').split('\n')
    out.push([name, box.join('\n')])
    out.push([name + ' +output', ['⏺ Done.', '', ...box].join('\n') + '\n'])
    QUOTES.forEach((q, i) => {
      out.push([name + ' +quote' + i, ['⏺ Done.', q, '', ...box].join('\n')])
      out.push([name + ' dialog+quote' + i, ['⏺ Done.', q, '', ...DIALOG].join('\n')])
    })
  }
  // Every captured pane fixture, as is and with each quote inserted at the top.
  for (const name of readdirSync(FIXTURES).filter((n) => n.endsWith('.txt')).sort()) {
    const pane = readFileSync(join(FIXTURES, name), 'utf8')
    out.push([name, pane])
    QUOTES.forEach((q, i) => out.push([name + ' +quote' + i, q + '\n' + pane]))
  }
  // Shapes the captures above do not hold.
  const shapes: Array<[string, string[]]> = [
    ['empty', []],
    ['blank lines only', ['', '   ', '\t']],
    ['no rule, footer last', ['⏺ Done.', '  ⏵⏵ bypass permissions on (shift+tab to cycle)']],
    ['no rule, quote last', ['⏺ Done.', 'bypass permissions on (shift+tab to cycle)']],
    ['no rule, old bare shortcuts footer', ['╭─────╮', '│ ❯   │', '╰─────╯', '  ? for shortcuts']],
    ['trailing blanks', [RULE, '❯ ', RULE, '  ⏵⏵ bypass permissions on (shift+tab to cycle)', '', '  ', '']],
    ['clipped footer, last line', ['⏺ Done.', '  ⏵⏵ bypass permissions on · 2 shells · ctrl+t to hi…']],
    ['clipped quote, last line, no glyph', ['⏺ Done.', 'x bypass permissions on · a · b…']],
    ['shell tail', [RULE, '❯ ', RULE, '  ⏵⏵ bypass permissions on · 1 shell']],
    ['shell tail with comma and monitor', ['⏺ Done.', '  ⏵⏵ auto mode on (shift+tab to cycle) · 1 shell, 2 monitors']],
    ['shell tail, four words', ['⏺ Done.', '  ⏵⏵ a b c d on · 1 shell']],
    ['shell tail, unknown counter', ['⏺ Done.', '  ⏵⏵ bypass permissions on · 1 task']],
    ['background agents under the footer', [RULE, '❯ ', RULE, '  ⏵⏵ bypass permissions on · ← for agents', '  ⏺ main', '    ⎿ agent-a  12s']],
    ['quota-wall lines between rule and footer', [RULE, '❯ ', RULE, '  ⚠ approaching usage limit', '  ⏵⏵ bypass permissions on (shift+tab to cycle)']],
    ['rule but no footer under it', ['⏺ Done.', RULE, '❯ ', RULE, 'some text']],
    ['footer above the last rule only', ['  ⏵⏵ bypass permissions on (shift+tab to cycle)', RULE, '❯ hi', RULE]],
    ['coloured glyph', [RULE, '❯ ', RULE, '\x1b[38;5;211m  ⏵⏵\x1b[39m bypass permissions on (shift+tab to cycle)']],
    ['colour inside the words', [RULE, '❯ ', RULE, '  ⏵⏵ bypass permissions on\x1b[2m (shift+tab to cycle)\x1b[22m']],
    ['carriage returns', [RULE + '\r', '❯ \r', RULE + '\r', '  ⏵⏵ bypass permissions on (shift+tab to cycle)\r']],
    ['word with digits and hyphen before on', [RULE, '❯ ', RULE, '  ⏵⏵ mode-2 on (shift+tab to cycle)']],
    ['tab before the glyph', [RULE, '❯ ', RULE, '\t⏸ plan mode on (shift+tab to cycle)']],
    ['mixed glyphs', [RULE, '❯ ', RULE, '  ⏵⏸ plan mode on (shift+tab to cycle)']],
    ['nine dashes is not a rule', ['─'.repeat(9), '❯ ', '  ⏵⏵ bypass permissions on (shift+tab to cycle)']],
  ]
  for (const [name, lines] of shapes) out.push([name, lines.join('\n')])
  return out
}

// Hermetic: an empty HOME and channel state dir, so the guard's preamble never
// resolves a live install's paths (it only reads them; footer-line writes nothing).
const SANDBOX = mkdtempSync(join(tmpdir(), 'footer-parity-'))
const GUARD_ENV = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: SANDBOX, TELEGRAM_STATE_DIR: SANDBOX, STUCK_MODAL_STATE_DIR: SANDBOX }

function viaGuard(pane: string): string | null {
  const printed = execFileSync('bash', [GUARD, 'footer-line'], { input: pane, encoding: 'utf8', env: GUARD_ENV })
  return printed === '' ? null : printed.replace(/\n$/, '')
}

function viaPython(panes: string[]): Array<string | null> {
  const code =
    'import importlib.util, json, sys\n' +
    'spec = importlib.util.spec_from_file_location("tlp", sys.argv[1])\n' +
    'm = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)\n' +
    'print(json.dumps([m.live_footer_line(p) for p in json.load(sys.stdin)]))\n'
  const printed = execFileSync('python3', ['-I', '-c', code, PROGRESS], { input: JSON.stringify(panes), encoding: 'utf8' })
  return JSON.parse(printed) as Array<string | null>
}

describe('PANEFOOTEROUTSIDE1114: one footer anchor, three implementations', () => {
  const cases = corpus()

  it('the corpus is not trivial', () => {
    const found = cases.filter(([, p]) => liveFooterLine(p) !== null).length
    expect(cases.length).toBeGreaterThan(150)
    expect(found).toBeGreaterThan(40)
    expect(cases.length - found).toBeGreaterThan(40)
  })

  it('the shell port answers exactly like liveFooterLine on every case', () => {
    const diff = cases
      .map(([name, pane]) => ({ name, ts: liveFooterLine(pane), sh: viaGuard(pane) }))
      .filter((r) => r.ts !== r.sh)
    expect(diff).toEqual([])
  }, 60_000)

  it('the Python port answers exactly like liveFooterLine on every case', () => {
    const py = viaPython(cases.map(([, p]) => p))
    expect(py).toHaveLength(cases.length)
    const diff = cases.map(([name, pane], i) => ({ name, ts: liveFooterLine(pane), py: py[i] })).filter((r) => r.ts !== r.py)
    expect(diff).toEqual([])
  })
})

describe('PANEFOOTEROUTSIDE1114: the unlock readiness reads the live footer', () => {
  const box = [RULE, '❯ ', RULE]
  it('ready on the live bypass footer', () => {
    expect(unlockPaneReady([...box, '  ⏵⏵ bypass permissions on (shift+tab to cycle)'].join('\n'))).toBe(true)
  })
  it('not ready when only a quote carries the bypass words', () => {
    expect(unlockPaneReady(['⏺ Done.', QUOTES[0], '', ...DIALOG].join('\n'))).toBe(false)
    expect(unlockPaneReady(['⏺ Done.', QUOTES[3], '', ...box, '  ⏸ plan mode on (shift+tab to cycle)'].join('\n'))).toBe(false)
  })
  it('still refuses the resume screen and the macOS settings dialog', () => {
    const ready = [...box, '  ⏵⏵ bypass permissions on (shift+tab to cycle)']
    expect(unlockPaneReady(['Resume from summary', ...ready].join('\n'))).toBe(false)
    expect(unlockPaneReady(['Open System Settings', ...ready].join('\n'))).toBe(false)
  })
})

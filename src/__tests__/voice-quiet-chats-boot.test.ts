// bd849630 (2): a malformed VOICE_NOTICE_QUIET_CHATS is reported at boot.
// Before the boot call the first report came with the first voice message that needed a notice, after that notice had
// already gone out to the recipient the list was meant to hold. The behavioural half reads the setting the way the boot
// does (no argument, the effective value). The wiring half parses web.ts: the call must use the name the import from
// ./web/voice-quiet-hours.js binds, in startWebServer's own body, so a commented-out call or one inside a nested
// function does not pass for the boot call.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'
import { logger } from '../logger.js'
import { voiceQuietChats } from '../web/voice-quiet-hours.js'

vi.mock('../settings-store.js', () => ({ getEffectiveSettingValue: vi.fn(() => '333000333;444000444') }))

const here = dirname(fileURLToPath(import.meta.url))
const WEB = readFileSync(join(here, '..', 'web.ts'), 'utf-8')

/** True when startWebServer's own body (not a nested function) calls the quiet-chat reader by the local name its
 *  import from ./web/voice-quiet-hours.js binds, without an argument (an argument would bypass the stored setting). */
function bootCallsQuietChats(src: string): boolean {
  const sf = ts.createSourceFile('web.ts', src, ts.ScriptTarget.Latest, true)
  let local: string | undefined
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier)) continue
    if (st.moduleSpecifier.text !== './web/voice-quiet-hours.js') continue
    const named = st.importClause?.namedBindings
    if (named && ts.isNamedImports(named)) {
      for (const el of named.elements) if ((el.propertyName ?? el.name).text === 'voiceQuietChats') local = el.name.text
    }
  }
  const boot = sf.statements.find(
    (s): s is ts.FunctionDeclaration => ts.isFunctionDeclaration(s) && s.name?.text === 'startWebServer',
  )
  if (!local || !boot?.body) return false
  let found = false
  const visit = (node: ts.Node): void => {
    if (found || ts.isFunctionLike(node)) return
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === local) {
      found = node.arguments.length === 0
    }
    if (!found) ts.forEachChild(node, visit)
  }
  ts.forEachChild(boot.body, visit)
  return found
}

describe('bd849630 (2): the boot reads the quiet-chat setting and reports a malformed value', () => {
  it('without an argument the reader takes the effective setting: a malformed value is one log line, without the value', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined)
    try {
      expect([...voiceQuietChats()]).toEqual([])
      expect(warn.mock.calls.map((c) => c[0])).toEqual([{ invalid: 1, valid: 0 }])
      expect(JSON.stringify(warn.mock.calls)).not.toMatch(/333000333|444000444/)
      // the first voice notice after the boot reads the same value: no second line
      expect([...voiceQuietChats()]).toEqual([])
      expect(warn).toHaveBeenCalledTimes(1)
    } finally {
      warn.mockRestore()
    }
  })
})

describe('bd849630 (2): the boot check is wired into startWebServer', () => {
  it('web.ts imports the reader, and startWebServer calls it in its own body', () => {
    expect(bootCallsQuietChats(WEB)).toBe(true)
  })

  it('KNOWN-POSITIVE: the pin fails without the call, with the call in a comment, in a nested function or with an argument, and without the import', () => {
    const call = /^ {4}voiceQuietChats\(\)\n/m
    expect(WEB.match(new RegExp(call.source, 'gm'))).toHaveLength(1)
    expect(bootCallsQuietChats(WEB.replace(call, ''))).toBe(false)
    expect(bootCallsQuietChats(WEB.replace(call, '    // voiceQuietChats()\n'))).toBe(false)
    expect(bootCallsQuietChats(WEB.replace(call, '    const later = () => voiceQuietChats()\n'))).toBe(false)
    expect(bootCallsQuietChats(WEB.replace(call, "    voiceQuietChats('')\n"))).toBe(false)
    const imp = /^import \{ voiceQuietChats \} from '\.\/web\/voice-quiet-hours\.js'\n/m
    expect(WEB.match(new RegExp(imp.source, 'gm'))).toHaveLength(1)
    expect(bootCallsQuietChats(WEB.replace(imp, ''))).toBe(false)
  })
})

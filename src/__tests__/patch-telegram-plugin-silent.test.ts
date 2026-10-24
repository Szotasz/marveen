// `silent` on the Telegram reply tool (disable_notification), a separate patch in
// scripts/patch-telegram-plugin.py. Run for real on a copy of the 0.0.7 plugin excerpt.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, copyFileSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join, extname } from 'node:path'
import { tmpdir } from 'node:os'
import ts from 'typescript'

const ROOT = join(__dirname, '..', '..')
const SCRIPT = join(ROOT, 'scripts', 'patch-telegram-plugin.py')
const FIXTURE = join(__dirname, 'fixtures', 'telegram-plugin-0.0.7', 'server.ts.txt')
const SIL = 'MARVEEN-PATCH(tgsilent)'

let cache = ''
let server = ''

beforeEach(() => {
  cache = mkdtempSync(join(tmpdir(), 'tg-silent-cache-'))
  const dir = join(cache, 'claude-plugins-official', 'telegram', '0.0.7')
  mkdirSync(dir, { recursive: true })
  server = join(dir, 'server.ts')
  copyFileSync(FIXTURE, server)
})
afterEach(() => rmSync(cache, { recursive: true, force: true }))

function run(extra: string[] = []): { status: number | null; stderr: string } {
  const r = spawnSync('python3', [SCRIPT, ...extra, cache], { encoding: 'utf-8', timeout: 30_000 })
  return { status: r.status, stderr: r.stderr }
}

function readState(file: string): { files: Array<{ status: string; patches: Record<string, string> }> } {
  return JSON.parse(readFileSync(file, 'utf-8'))
}

function syntaxErrors(text: string): string[] {
  const out = ts.transpileModule(text, { reportDiagnostics: true, compilerOptions: { target: ts.ScriptTarget.ES2022 } })
  return (out.diagnostics ?? []).map(d => ts.flattenDiagnosticMessageText(d.messageText, '\n'))
}

function patchedWithoutSilent(text: string): string {
  const code = [
    'import importlib.util, sys',
    "spec = importlib.util.spec_from_file_location('ptp', sys.argv[1])",
    'm = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)',
    "m.PATCHES = [p for p in m.PATCHES if p['name'] != 'silent']",
    'sys.stdout.write(m.patch_text(sys.stdin.read())[0])',
  ].join('\n')
  const r = spawnSync('python3', ['-c', code, SCRIPT], { input: text, encoding: 'utf-8' })
  expect(r.status).toBe(0)
  return r.stdout
}

type Sent = { method: string; chat: string; opts: Record<string, unknown> | undefined }

function replyHandler(patched: string): { call: (args: Record<string, unknown>) => Promise<{ isError?: boolean; content: Array<{ text: string }> }>; sent: Sent[] } {
  const start = patched.indexOf('mcp.setRequestHandler(CallToolRequestSchema')
  expect(start).toBeGreaterThan(0)
  const js = ts.transpileModule(patched.slice(start), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
  const sent: Sent[] = []
  let handler: ((req: unknown) => Promise<never>) | undefined
  const mcp = { setRequestHandler: (_schema: unknown, fn: (req: unknown) => Promise<never>) => { handler = fn } }
  const rec = (method: string) => async (chat: string, _x: unknown, opts?: Record<string, unknown>) => {
    sent.push({ method, chat, opts }); return { message_id: sent.length }
  }
  const bot = { api: { sendMessage: rec('sendMessage'), sendPhoto: rec('sendPhoto'), sendDocument: rec('sendDocument') } }
  const names = ['mcp', 'CallToolRequestSchema', 'assertAllowedChat', 'assertSendable', 'statSync', 'MAX_ATTACHMENT_BYTES',
    'loadAccess', 'MAX_CHUNK_LIMIT', 'chunk', 'bot', 'extname', 'InputFile', 'PHOTO_EXTS']
  new Function(...names, js)(mcp, {}, () => {}, () => {}, () => ({ size: 0 }), 50 * 1024 * 1024,
    () => ({}), 4096, (text: string) => text.split('|'), bot, extname, class {}, new Set(['.png', '.jpg']))
  expect(handler).toBeDefined()
  return { call: args => handler!({ params: { name: 'reply', arguments: args } }), sent }
}

const hasKey = (s: Sent) => s.opts !== undefined && 'disable_notification' in s.opts

describe('silent: reply without a notification sound', () => {
  it('six marked lines, the field inside the reply schema, parses, state patched then already', () => {
    const state = join(cache, 'state.json')
    expect(run(['--state', state]).status).toBe(0)
    const text = readFileSync(server, 'utf-8')
    expect(text.split('\n').filter(l => l.includes(SIL))).toHaveLength(6)
    const reply = text.indexOf("name: 'reply'")
    const field = text.indexOf("silent: { type: 'boolean',")
    expect(field).toBeGreaterThan(reply)
    expect(field).toBeLessThan(text.indexOf("required: ['chat_id', 'text'],", reply))
    expect(field).toBeLessThan(text.indexOf("name: 'react'"))
    expect(syntaxErrors(text)).toEqual([])
    expect(readState(state).files[0].patches.silent).toBe('patched')
    run(['--state', state])
    expect(readState(state).files[0].patches.silent).toBe('already')
  })

  it('silent: true marks all 4 sends; photo via sendPhoto, pdf via sendDocument', async () => {
    run()
    const h = replyHandler(readFileSync(server, 'utf-8'))
    const res = await h.call({ chat_id: '42', text: 'a|b', files: ['/x/a.png', '/x/b.pdf'], silent: true })
    expect(res.isError).toBeUndefined()
    expect(h.sent.map(s => s.method)).toEqual(['sendMessage', 'sendMessage', 'sendPhoto', 'sendDocument'])
    for (const s of h.sent) expect(s.opts!.disable_notification).toBe(true)
  })

  it('silent together with reply_to: file opts keep reply_parameters', async () => {
    run()
    const h = replyHandler(readFileSync(server, 'utf-8'))
    await h.call({ chat_id: '42', text: 'a', files: ['/x/a.png', '/x/b.pdf'], reply_to: 7, silent: true })
    expect(h.sent.map(s => s.method)).toEqual(['sendMessage', 'sendPhoto', 'sendDocument'])
    expect(h.sent[0].opts).toEqual({ reply_parameters: { message_id: 7 }, disable_notification: true })
    for (const s of h.sent.slice(1)) {
      expect(s.opts).toEqual({ reply_parameters: { message_id: 7 }, disable_notification: true })
    }
  })

  it('silent missing or false: no disable_notification key, file opts as before', async () => {
    run()
    const h = replyHandler(readFileSync(server, 'utf-8'))
    await h.call({ chat_id: '42', text: 'a|b', files: ['/x/a.png', '/x/b.pdf'] })
    await h.call({ chat_id: '42', text: 'a|b', files: ['/x/a.png', '/x/b.pdf'], silent: false })
    await h.call({ chat_id: '42', text: 'a', files: ['/x/a.png'], silent: null })
    expect(h.sent).toHaveLength(10)
    expect(h.sent.some(hasKey)).toBe(false)
    for (const s of h.sent.filter(s => s.method !== 'sendMessage')) expect(s.opts).toBeUndefined()
    await h.call({ chat_id: '42', text: 'a', files: ['/x/a.png'], reply_to: 3, silent: false })
    expect(h.sent[h.sent.length - 1].opts).toEqual({ reply_parameters: { message_id: 3 } })
  })

  it('a bad silent value is a tool error before anything is sent', async () => {
    run()
    const h = replyHandler(readFileSync(server, 'utf-8'))
    for (const silent of ['true', 1, {}]) {
      const res = await h.call({ chat_id: '42', text: 'a', files: ['/x/a.png'], silent })
      expect(res.isError).toBe(true)
      expect(res.content[0].text).toMatch(/^reply failed: silent: /)
    }
    expect(h.sent).toHaveLength(0)
  })

  it('with topics: thread id and silent on text and file sends; topics off leaves the silent lines', async () => {
    const state = join(cache, 'state.json')
    expect(run(['--state', state, '--topics', 'on']).status).toBe(0)
    expect(readState(state).files[0].patches).toMatchObject({ topics: 'patched', silent: 'patched' })
    const text = readFileSync(server, 'utf-8')
    expect(syntaxErrors(text)).toEqual([])
    const h = replyHandler(text)
    await h.call({ chat_id: '42', text: 'a', files: ['/x/b.pdf'], message_thread_id: '5', silent: true })
    expect(h.sent).toHaveLength(2)
    for (const s of h.sent) expect(s.opts).toMatchObject({ message_thread_id: 5, disable_notification: true })

    run(['--topics', 'off'])
    const off = readFileSync(server, 'utf-8')
    expect(off).not.toContain('message_thread_id')
    expect(off.split('\n').filter(l => l.includes(SIL))).toHaveLength(6)
    copyFileSync(FIXTURE, server)
    run()
    expect(off).toBe(readFileSync(server, 'utf-8'))
  })

  it('taking it back = deleting the marked lines gives the file patched without silent', () => {
    run()
    const back = readFileSync(server, 'utf-8').split('\n').filter(l => !l.includes(SIL)).join('\n')
    expect(back).toBe(patchedWithoutSilent(readFileSync(FIXTURE, 'utf-8')))
  })

  it('all or nothing: a moved file-branch anchor leaves every silent line out, loudly', () => {
    writeFileSync(server, readFileSync(FIXTURE, 'utf-8').replace('if (PHOTO_EXTS.has(ext)) {', 'if (PHOTO_EXTS.has(ext) === true) {'))
    const state = join(cache, 'state.json')
    const r = run(['--state', state])
    expect(r.status).toBe(0)
    expect(r.stderr).toMatch(/LOUD: reply file branch not found exactly once.*the reply tool has no silent option/)
    expect(readFileSync(server, 'utf-8')).not.toContain(SIL)
    expect(readState(state).files[0].patches).toEqual({
      d4: 'patched', fwd: 'patched', evid: 'patched', kbd: 'patched', silent: 'anchor-missing:reply file branch',
    })
  })
})

// memory-lookup-nudge: on a HUMAN message the agent gets a short, fixed reminder
// to look in its memory, with the correct search recipe (owner request
// 2026-09-25, TG 16727). No memory content is injected: measured the same day,
// a strict FTS search built from the owner's messages hit 3/30 (all trivial) and
// the relaxed form 30/30 with ~2400 rows, i.e. noise.
//
// Behavioural tests run the python hook as a subprocess (deterministic, no LLM).
// Static tests lock the wiring (both settings surfaces, 3 s timeout) and the
// fail-open shape (no network, no DB, errors exit 0 silently).
import { describe, it, expect } from 'vitest'
import { readFileSync, mkdtempSync, mkdirSync, copyFileSync, writeFileSync, rmSync } from 'node:fs'
import { spawnSync, spawn } from 'node:child_process'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = join(__dirname, '..', '..')
const HOOK = join(ROOT, 'scripts', 'hooks', 'memory-lookup-nudge.py')
// Any way to reach the network, a DB, a subprocess or dynamic code, on ANY line, in
// any import shape (#1559 review: `import json, urllib.request` and `os.system(...)`
// both passed an import-line-only blacklist).
const NO_IO = /urlopen|urllib|http\.client|HTTPConnection|(?:from|import)\s+http\b|httplib|socket|sqlite3|subprocess|\brequests\b|os\.system|os\.popen|os\.exec|os\.spawn|popen|__import__|importlib|asyncio|open_connection|\b(?:exec|eval|compile)\s*\(/

function run(stdin: string, env: Record<string, string> = {}) {
  const r = spawnSync('python3', [HOOK], { input: stdin, encoding: 'utf-8', env: { ...process.env, ...env }, timeout: 10_000 })
  return { out: r.stdout ?? '', code: r.status }
}
const hook = (prompt: unknown, cwd = ROOT, env: Record<string, string> = {}) => run(JSON.stringify({ prompt, cwd }), env)

const channel = (body = 'Mi a helyzet a Molnár Gábor-féle telepítéssel?') =>
  `<channel source="plugin:telegram:telegram" chat_id="1" message_id="2" ts="2026-09-25T08:00:00Z">${body}</channel>`

describe('memory-lookup-nudge: speaks on a human message', () => {
  it('a channel message gets the nudge with the correct recipe', () => {
    const { out, code } = hook(channel())
    expect(code).toBe(0)
    expect(out).toContain('[memoria-szetnezes]')
    expect(out).toContain('curl -s -G -D')
    expect(out).toContain('--data-urlencode "q=KULCSSZO"')
    expect(out).toContain("grep -i '^x-memory-search'")
    expect(out).toContain('strict=1')
    // The raw-accent trap: q must never be glued into the URL.
    expect(out).not.toMatch(/api\/memories\?[^"]*q=/)
  })

  it('a bare terminal prompt (the owner at the dashboard) gets it too', () => {
    expect(hook('Nézd meg, mit írtunk Ádámnak a warm memóriáról').out).toContain('[memoria-szetnezes]')
  })

  // #1559 review, second round: with no token and nobody on the port, a side channel
  // that fetches memories fails silently and the output stays three lines, so an
  // exact-output test alone proved nothing. Here the hook runs from a copy under a
  // temp root that HAS a token, and WEB_PORT points at a real listener that answers
  // every request with memory JSON and counts it. Zero requests, exact output.
  it('prints EXACTLY the fixed nudge and makes ZERO requests, even with a token and a live port', async () => {
    let requests = 0
    const server = createServer((_req, res) => {
      requests++
      res.writeHead(200, { 'Content-Type': 'application/json', 'X-Memory-Search': 'strict=false; relaxed=false; hits=1' })
      res.end(JSON.stringify([{ id: 1, content: 'TITKOS-HOT-MEMORIA-TARTALOM', category: 'hot' }]))
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
    const port = String((server.address() as AddressInfo).port)
    const root = mkdtempSync(join(tmpdir(), 'nudge-root-'))
    try {
      mkdirSync(join(root, 'scripts', 'hooks'), { recursive: true })
      mkdirSync(join(root, 'store'), { recursive: true })
      mkdirSync(join(root, 'agents', 'samu'), { recursive: true })
      const hookCopy = join(root, 'scripts', 'hooks', 'memory-lookup-nudge.py')
      copyFileSync(HOOK, hookCopy)
      writeFileSync(join(root, 'store', '.dashboard-token'), 'teszt-token-nem-valodi')
      writeFileSync(join(root, '.env'), `WEB_PORT=${port}\n`)
      // Async spawn: a sync spawn would block this event loop and the listener
      // could never answer (the vitest in-process-server deadlock).
      const out = await new Promise<string>((resolve) => {
        const child = spawn('python3', [hookCopy], { cwd: join(root, 'agents', 'samu'), env: { ...process.env, WEB_PORT: port } })
        let buf = ''
        child.stdout.on('data', (c) => (buf += c))
        child.on('close', () => resolve(buf))
        child.stdin.end(JSON.stringify({ prompt: channel(), cwd: join(root, 'agents', 'samu') }))
      })
      await new Promise((r) => setTimeout(r, 500)) // a detached side channel gets its chance too
      const token = join(root, 'store', '.dashboard-token')
      expect(requests).toBe(0)
      expect(out).not.toContain('TITKOS-HOT-MEMORIA-TARTALOM')
      expect(out).toBe(
        '[memoria-szetnezes] Emberi uzenet: mielott valaszolsz, nezd meg, van-e rola emleked. ' +
          'A kulcsszot te valaszd (nev, tema), ne a mondat toltelekszavait.\n' +
          `curl -s -G -D /tmp/mem-fejlec-samu.txt -H "Authorization: Bearer $(cat ${token})" ` +
          `--data-urlencode "agent=samu" --data-urlencode "q=KULCSSZO" "http://localhost:${port}/api/memories"\n` +
          "grep -i '^x-memory-search' /tmp/mem-fejlec-samu.txt  " +
          '(relaxed=true = kozelites, nem bizonyitek; hiany-allitashoz: --data-urlencode "strict=1")\n',
      )
    } finally {
      server.close()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('the listener harness itself sees a request when one is made (positive control)', async () => {
    let requests = 0
    const server = createServer((_req, res) => { requests++; res.end('[]') })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
    const port = (server.address() as AddressInfo).port
    try {
      await new Promise<void>((resolve) => {
        const child = spawn('python3', ['-c', `import urllib.request; urllib.request.urlopen("http://127.0.0.1:${port}/api/memories", timeout=3).read()`])
        child.on('close', () => resolve())
      })
      expect(requests).toBe(1)
    } finally {
      server.close()
    }
  })

  it('stays short: one fixed block, well under the token ceiling', () => {
    const { out } = hook(channel())
    expect(out.trim().split('\n').length).toBe(3)
    expect(out.length).toBeLessThan(600)
  })

  it('names the agent from the cwd, and the main agent at the install root', () => {
    expect(hook(channel(), join(ROOT, 'agents', 'samu')).out).toContain('"agent=samu"')
    expect(hook(channel(), join(ROOT, 'agents', 'samu', 'sub', 'dir')).out).toContain('"agent=samu"')
    expect(hook(channel(), ROOT, { MAIN_AGENT_ID: 'fomenet' }).out).toContain('"agent=fomenet"')
  })
})

describe('memory-lookup-nudge: silent on everything that is not a human', () => {
  const silent: Array<[string, string]> = [
    ['inter-agent, trusted', '<trusted-peer source="agent:samu">MEGY</trusted-peer>'],
    ['inter-agent, untrusted', '<untrusted source="agent:dani">adat</untrusted>'],
    ['inter-agent prefix only', '[Uzenet @samu-tol -- trusted team member, msg_id:1]: szia'],
    ['a channel block forwarded inside peer traffic', `<trusted-peer source="agent:x">${channel()}</trusted-peer>`],
    ['scheduled task', '<scheduled-task source="scheduled-task:napindito">futtasd</scheduled-task>'],
    ['own task notice', '<task-notification><task-id>b1</task-id></task-notification>'],
    ['system directive', '[SYSTEM-DIREKTIVA msg_id:5] irj handoffot'],
    ['context guard', '[CONTEXT-GUARD] A munkakontextusod ~92%-on van'],
    ['recovery brief', '[recovery-brief] Ujraindultal'],
    ['slash command', '/rename Geri'],
    ['local command echo', '<command-name>/rename</command-name>'],
    ['empty', '   '],
    ['system reminder line', '<system-reminder>\nThe user named this session "Geri".\n</system-reminder>'],
    ['skill load text', 'Base directory for this skill: /x/skills/y\n\n## Page contract'],
  ]
  it.each(silent)('%s', (_label, prompt) => {
    const { out, code } = hook(prompt)
    expect(code).toBe(0)
    expect(out.trim()).toBe('')
  })
})

describe('memory-lookup-nudge: fail-open', () => {
  it('unparseable stdin exits 0 without output', () => {
    const { out, code } = run('ez nem json')
    expect(code).toBe(0)
    expect(out.trim()).toBe('')
  })

  it('a malformed payload (prompt not a string) exits 0 without output', () => {
    const { out, code } = hook(12345)
    expect(code).toBe(0)
    expect(out.trim()).toBe('')
  })

  it('does no network, DB or subprocess work, so the 3 s timeout is never the bound', () => {
    const src = readFileSync(HOOK, 'utf-8')
    expect(src).not.toMatch(NO_IO)
    const t0 = Date.now()
    hook(channel())
    expect(Date.now() - t0).toBeLessThan(2_000)
  })
})

describe('memory-lookup-nudge: wiring', () => {
  const surfaces: Array<[string, string]> = [
    ['templates/settings.json.template', 'every seeded agent'],
    ['.claude/settings.json', 'the checkout (main) agent'],
  ]
  it.each(surfaces)('%s registers it on UserPromptSubmit with a 3 s timeout (%s)', (file) => {
    const json = JSON.parse(readFileSync(join(ROOT, file), 'utf-8'))
    const hooks = (json.hooks?.UserPromptSubmit ?? []).flatMap((g: any) => g.hooks ?? [])
    const mine = hooks.filter((h: any) => String(h.command).includes('scripts/hooks/memory-lookup-nudge.py'))
    expect(mine).toHaveLength(1)
    expect(mine[0].timeout).toBe(3)
  })
})

import { describe, it, expect } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { buildTelegramMcpServerConfig } from '../web/agent-process.js'
import { PROJECT_ROOT } from '../config.js'

const WRAPPER = join(PROJECT_ROOT, 'scripts', 'channel-inbound-tee.mjs')

function runWrapper(stateDir: string, childCode: string): Promise<{ stdout: string, stderr: string, code: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [WRAPPER, process.execPath, '-e', childCode], {
      env: { ...process.env, TELEGRAM_STATE_DIR: stateDir },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', reject)
    child.on('exit', (code) => resolve({ stdout, stderr, code }))
    // MCP-contract: the parent owns the wrapper's stdin; close it so the
    // wrapper can exit once its child is done (mirrors a client disconnect).
    child.stdin.end()
  })
}

describe('channel-inbound-tee', () => {
  it('passes stdout through byte-for-byte and tees split channel notifications to the inbox', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'channel-inbound-tee-'))
    try {
      const notification = JSON.stringify({
        jsonrpc: '2.0',
        method: 'notifications/claude/channel',
        params: {
          content: 'hello',
          meta: { chat_id: 'c1', message_id: 'm1', user: 'u1', ts: '123' },
        },
      })
      const response = JSON.stringify({ jsonrpc: '2.0', id: 1, result: { ok: true } })
      const nonJson = 'not json'
      const expected = notification + '\n' + response + '\n' + nonJson + '\n'
      const childCode = `
        const fs = require('node:fs');
        const notification = ${JSON.stringify(notification)};
        const response = ${JSON.stringify(response)};
        fs.writeSync(1, notification.slice(0, 35));
        setTimeout(() => {
          fs.writeSync(1, notification.slice(35) + '\\n');
          fs.writeSync(1, response + '\\n');
          fs.writeSync(1, ${JSON.stringify(nonJson + '\n')});
        }, 10);
      `

      const result = await runWrapper(dir, childCode)
      expect(result.code).toBe(0)
      expect(result.stderr).toBe('')
      expect(result.stdout).toBe(expected)

      const inbox = readFileSync(join(dir, 'inbox-pending.jsonl'), 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
      expect(inbox).toHaveLength(1)
      expect(inbox[0].receivedAt).toEqual(expect.any(Number))
      expect(inbox[0].params).toEqual({
        content: 'hello',
        meta: { chat_id: 'c1', message_id: 'm1', user: 'u1', ts: '123' },
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('buildTelegramMcpServerConfig', () => {
  it('routes the per-agent telegram MCP server through the inbound tee wrapper', () => {
    const cfg = buildTelegramMcpServerConfig('/home/me/.bun/bin/bun', '/plugins/telegram/0.0.6', '/agents/nova/.claude/channels/telegram')
    expect(cfg.command).toBe('node')
    expect(cfg.args).toEqual([
      join(PROJECT_ROOT, 'scripts', 'channel-inbound-tee.mjs'),
      '/home/me/.bun/bin/bun',
      'run',
      '--cwd',
      '/plugins/telegram/0.0.6',
      '--shell=bun',
      '--silent',
      'start',
    ])
    expect(cfg.env).toEqual({ TELEGRAM_STATE_DIR: '/agents/nova/.claude/channels/telegram' })
  })
})

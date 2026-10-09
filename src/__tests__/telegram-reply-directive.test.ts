// scripts/hooks/telegram-reply-directive.py: the UserPromptSubmit reminder to
// answer through the reply tool. Spawned for real; stdout is what the model
// gets in front of the turn.
import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

const HOOK = join(__dirname, '..', '..', 'scripts', 'hooks', 'telegram-reply-directive.py')

function directive(prompt: string): { code: number | null; stdout: string } {
  const r = spawnSync('python3', [HOOK], { input: JSON.stringify({ prompt }), encoding: 'utf-8', timeout: 15_000 })
  return { code: r.status, stdout: r.stdout }
}

const PLAIN =
  '[TELEGRAM-DIREKTÍVA] Ez az üzenet a Telegram csatornáról érkezett (chat_id=42). ' +
  'A válaszod KÖTELEZŐEN a mcp__plugin_telegram_telegram__reply toolon keresztül menjen ki (chat_id=42) ' +
  '-- a sima assistant-szöveg NEM jut el hozzá, csak a tmux-ba. Ha csak nyugtázás kell (ok/köszi), ' +
  'akkor sem baj, de érdemi választ MINDIG a reply toollal küldj.\n'

describe('telegram-reply-directive.py', () => {
  // Pinned before the topics support went in: without a topic it must stay this.
  it('no topic: exactly the plain directive', () => {
    const r = directive('<channel source="plugin:telegram:telegram" chat_id="42" message_id="7" user="owner">szia</channel>')
    expect(r.code).toBe(0)
    expect(r.stdout).toBe(PLAIN)
  })

  it('a topic message: both the inbound and the reply target name the topic', () => {
    const r = directive('<channel source="plugin:telegram:telegram" chat_id="42" message_id="7" user="owner" message_thread_id="12">szia</channel>')
    expect(r.stdout).toBe(PLAIN.replaceAll('(chat_id=42)', '(chat_id=42, message_thread_id=12)'))
  })

  it('not a Telegram turn: silent', () => {
    expect(directive('heartbeat').stdout).toBe('')
  })
})

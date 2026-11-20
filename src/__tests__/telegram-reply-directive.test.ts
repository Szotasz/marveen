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

  // TELEGRAM_REACTIONS_ENABLED: a reaction block (reaction="...", no message_id) owes no reply.
  const REACTION = '<channel source="plugin:telegram:telegram" chat_id="42" user="owner" user_id="42" reaction="👍" reply_to_message_id="40" ts="2026-11-19T16:08:31.000Z">(reaction 👍)</channel>'
  it('reactions only: a short note that no reply is owed, not the mandatory-reply directive', () => {
    const r = directive(REACTION + '\n' + REACTION.replace('👍', '🔥').replace('👍', '🔥'))
    expect(r.code).toBe(0)
    expect(r.stdout).toBe('[TELEGRAM-REAKCIÓ] Ez egy emoji-reakció egy korábbi üzenetre (reply_to_message_id, és ha megvan, ' +
      'reply_to_text), nem kérdés: választ nem vár. Csak akkor írj a reply toollal, ha a reakció miatt tenned kell valamit. ' +
      NOT_CONSENT + '\n')
  })

  // #2958 security review (R1): a thumbs-up on "Mehet?" must not read as the owner's go-ahead.
  const NOT_CONSENT = 'A reakció nem jóváhagyás: ha a lépéshez a tulajdonos kifejezett engedélye kell (jóváhagyás, ' +
    'kifelé ható vagy visszafordíthatatlan lépés), kérd írásban, és várd meg a szöveges választ.'
  it('the reaction note says a reaction is no approval, and asks for it in writing', () => {
    const r = directive(REACTION)
    expect(r.stdout).toContain(NOT_CONSENT)
    expect(r.stdout.match(/nem jóváhagyás/g)).toHaveLength(1)
  })

  it('a reaction ahead of a message in the same delivery: the plain directive for the message, then the same warning', () => {
    const r = directive(REACTION + '\n<channel source="plugin:telegram:telegram" chat_id="42" message_id="41" user="owner">szia</channel>')
    expect(r.stdout).toBe(PLAIN + '[TELEGRAM-REAKCIÓ] Ebben a kézbesítésben reakció is van. ' + NOT_CONSENT + '\n')
  })

  it('a message without a reaction gets no reaction warning', () => {
    expect(directive('<channel source="plugin:telegram:telegram" chat_id="42" message_id="41" user="owner">Mehet? 👍</channel>').stdout).toBe(PLAIN)
  })

  it('not a Telegram turn: silent', () => {
    expect(directive('heartbeat').stdout).toBe('')
  })
})

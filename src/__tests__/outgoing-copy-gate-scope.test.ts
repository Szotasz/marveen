import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'

// KAPUHATOKOR822: four false positives in one afternoon, on THREE operation
// types (inter-agent message, sqlite write, file READ). The old trigger
// searched the WHOLE command string for send-patterns, so the '"to":' of an
// inter-agent envelope plus 'send.py' mentioned in the CONTENT read as an
// email send -- the gate silenced the fleet on exactly the topic it most
// needs to talk about (Iris: a real incident about this system could not be
// reported through it). The trigger now works on COMMAND POSITION: heredoc
// bodies and quoted strings are cut first, then the INVOKED program of each
// pipeline segment decides. These tests pin both directions: content can no
// longer fake a send, and every real send shape still fires.

const ROOT = join(__dirname, '..', '..')
const GATE = join(ROOT, 'scripts', 'hooks', 'outgoing-copy-gate.py')

function isSend(cmd: string): boolean {
  const out = execFileSync('python3', ['-c', `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("gate", ${JSON.stringify(GATE)})
g = importlib.util.module_from_spec(spec); spec.loader.exec_module(g)
print(json.dumps(g.is_send_invocation(sys.argv[1])))
`, cmd], { encoding: 'utf-8' })
  return JSON.parse(out.trim())
}

describe('outgoing-copy gate: content cannot fake a send (the four measured FP classes)', () => {
  it('an inter-agent curl whose CONTENT mentions send.py and carries a "to" envelope passes', () => {
    // Marveen's real morning case: a message TO an agent ABOUT the mail gate.
    expect(isSend(
      `curl -s -X POST http://localhost:3420/api/messages -H "Content-Type: application/json" ` +
      `-d '{"from":"marveen","to":"samu","content":"a scripts/support-mail/send.py hookon fennakadt, --to hianyzott"}'`,
    )).toBe(false)
  })

  it('a sqlite write whose text talks about a newsletter and a provider passes', () => {
    // Zara's real case: internal write, blocked on provider-name + "hirlevel".
    expect(isSend(
      `sqlite3 store/claudeclaw.db "INSERT INTO kanban_comments (card_id, author, content) ` +
      `VALUES ('X', 'Zara', 'a hirlevel az api.resend.com-on megy ki, sendmail nincs')"`,
    )).toBe(false)
  })

  it('READING the send script passes (cat, grep --to)', () => {
    // Iris's real case: a file read classified as a send.
    expect(isSend('cat /Users/marvin/ClaudeClaw/scripts/support-mail/send.py')).toBe(false)
    expect(isSend('grep -n -- "--to" scripts/support-mail/send.py')).toBe(false)
  })

  it('a heredoc that WRITES send-shaped content into a file passes', () => {
    expect(isSend(
      `cat > /tmp/notes.md <<'EOF'\nsendmail --to x@y.hu is how the legacy path worked\nEOF`,
    )).toBe(false)
  })

  it('an inter-agent message quoting a full send command in its content passes', () => {
    expect(isSend(
      `curl -s -X POST http://localhost:3420/api/messages ` +
      `-d '{"from":"samu","to":"marveen","content":"futtasd: python3 scripts/support-mail/send.py --to ugyfel@ceg.hu"}'`,
    )).toBe(false)
  })
})

describe('outgoing-copy gate: every real send shape still fires (no false negatives from the narrowing)', () => {
  it('send.py invoked with a recipient fires (python3 and direct path)', () => {
    expect(isSend('python3 /Users/marvin/ClaudeClaw/scripts/support-mail/send.py --to a@b.hu --subject "X" --body "Y"')).toBe(true)
    expect(isSend('./scripts/support-mail/send.py --to=a@b.hu < /tmp/body.txt')).toBe(true)
  })

  it('send.py WITHOUT a recipient does not fire (--help is not a send)', () => {
    expect(isSend('python3 scripts/support-mail/send.py --help')).toBe(false)
  })

  it('the pure senders fire from program position, also mid-pipeline', () => {
    expect(isSend('sendmail -t a@b.hu < /tmp/mail.txt')).toBe(true)
    expect(isSend('echo torzs | msmtp a@b.hu')).toBe(true)
    expect(isSend('swaks --to a@b.hu --server smtp.x.hu')).toBe(true)
  })

  it('graph-mail with the send subcommand fires; without it, it does not', () => {
    expect(isSend('npx tsx scripts/graph-mail.ts send --to a@b.hu --subject X')).toBe(true)
    expect(isSend('npx tsx scripts/graph-mail.ts list --folder inbox')).toBe(false)
  })

  it('curl with an UNQUOTED resend URL token fires; the same domain inside a quoted payload does not', () => {
    expect(isSend(`curl -X POST https://api.resend.com/emails -H "Authorization: Bearer X" -d '{"to":"a@b.hu"}'`)).toBe(true)
    expect(isSend(`curl -s http://localhost:3420/api/messages -d '{"to":"samu","content":"az api.resend.com lassu ma"}'`)).toBe(false)
  })

  it('an env-var prefix does not hide the sender program', () => {
    expect(isSend('SMTP_DEBUG=1 msmtp a@b.hu < /tmp/m.txt')).toBe(true)
  })
})

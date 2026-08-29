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

// Marveen's adversarial round (msg 14282): the first version stripped quoted
// strings BLINDLY, which opened two false negatives -- and the first is the
// NORMAL way people write curl, so it needed no intent to slip through. The
// quote is a good boundary against content, but it does not say whether the
// quoted token stands in URL/PROGRAM position. These pin the repaired
// distinction from both sides.
describe('outgoing-copy gate: quoted tokens in OPERATION position still fire (msg 14282)', () => {
  it('a QUOTED provider URL in curl argument position fires -- the usual way curl is written', () => {
    expect(isSend(`curl -X POST "https://api.resend.com/emails" -H "Authorization: Bearer X" -d @/tmp/mail.json`)).toBe(true)
    expect(isSend(`curl 'https://api.resend.com/emails' -d @/tmp/mail.json`)).toBe(true)
  })

  it('the same domain inside a quoted -d payload still does NOT fire (the FP fix must survive)', () => {
    expect(isSend(`curl -s http://localhost:3420/api/messages -d '{"to":"samu","content":"az api.resend.com lassu ma"}'`)).toBe(false)
  })

  it('a wrapper shell -c string is analyzed recursively', () => {
    expect(isSend(`bash -c "python3 scripts/support-mail/send.py --to a@b.hu --subject X"`)).toBe(true)
    expect(isSend(`sh -c 'msmtp a@b.hu < /tmp/m.txt'`)).toBe(true)
  })

  it('a wrapper shell -c string that only TALKS about sending does not fire', () => {
    expect(isSend(`bash -c "echo a kuldo-script a support-mail mappaban van"`)).toBe(false)
  })

  it('a real sender on the SECOND LINE of a multi-line command fires (newline is a separator)', () => {
    expect(isSend(`cat /tmp/x.txt\nsendmail -t a@b.hu < /tmp/mail.txt`)).toBe(true)
  })

  it('a multi-line quoted payload does not leak fake program positions', () => {
    expect(isSend(`curl -s http://localhost:3420/api/messages -d '{"to":"marveen","content":"elso sor\nsendmail emlitve a masodik sorban"}'`)).toBe(false)
  })

  it('naive exec-shape in interpreter code fires; exec alone or mailer-name alone does not (msg 14298)', () => {
    expect(isSend(`python3 -c "import subprocess; subprocess.run(['sendmail','-t','a@b.hu'])"`)).toBe(true)
    expect(isSend(`python3 -c "import subprocess; subprocess.run(['ls','-la'])"`)).toBe(false)
    expect(isSend(`python3 -c "print('a sendmail utvonala regen mas volt')"`)).toBe(false)
  })

  it('heredoc stripping is ORDER-INDEPENDENT: marker-first spelling is still content (round 3, msg 14286)', () => {
    // The same sentence as the redirect-first FP test, tokens swapped -- both
    // are completely ordinary shell.
    expect(isSend(`cat <<'EOF' > /tmp/notes.md\nsendmail --to x@y.hu is how the legacy path worked\nEOF`)).toBe(false)
  })

  it('a heredoc-FED real sender still fires: the intro line survives the stripping', () => {
    expect(isSend(`sendmail -t a@b.hu <<'EOF'\ntorzs sora\nEOF`)).toBe(true)
  })

  it('an unparseable command (unbalanced quote) falls back conservatively: audits on strong literals only', () => {
    expect(isSend(`echo "lezaratlan idezojel es sendmail emlitve`)).toBe(true)
    expect(isSend(`echo "lezaratlan idezojel, artalmatlan szoveg`)).toBe(false)
  })
})

describe('RESENDGATE826: the resend trigger fires on the METHOD, not the hostname', () => {
  // The method-blind pattern blocked a read-only GET /domains (no body, no
  // recipient, nothing leaves) exactly when a domain-verification MEASUREMENT
  // needed it. The narrowing is strict: recognize the method, or stay closed.

  it('read-only queries pass: bare GET, explicit GET, forced -G', () => {
    expect(isSend(`curl -s -H "Authorization: Bearer re_x" https://api.resend.com/domains`)).toBe(false)
    expect(isSend(`curl -sS -X GET https://api.resend.com/emails/abc123 -H "Authorization: Bearer re_x"`)).toBe(false)
    expect(isSend(`curl -G https://api.resend.com/domains -H "Authorization: Bearer re_x"`)).toBe(false)
    expect(isSend(`wget -qO- https://api.resend.com/domains`)).toBe(false)
  })

  it('KNOWN POSITIVE: a real POST /emails still fires, in every spelling', () => {
    // The condition of the narrowing: an actual send may never slip through.
    expect(isSend(`curl -X POST https://api.resend.com/emails -H "Authorization: Bearer X" -d '{"to":"a@b.hu"}'`)).toBe(true)
    expect(isSend(`curl 'https://api.resend.com/emails' -d @/tmp/mail.json`)).toBe(true) // implicit POST via body
    expect(isSend(`curl -sX POST https://api.resend.com/emails -d '{}'`)).toBe(true) // bundled cluster
    expect(isSend(`curl --request=POST https://api.resend.com/emails`)).toBe(true)
    expect(isSend(`curl --json '{"to":"a@b.hu"}' https://api.resend.com/emails`)).toBe(true)
  })

  it('state-changing non-POST methods fire too', () => {
    expect(isSend(`curl -X DELETE https://api.resend.com/emails/abc123`)).toBe(true)
    expect(isSend(`curl --request PATCH https://api.resend.com/emails/abc123 -d '{"scheduled_at":null}'`)).toBe(true)
  })

  it('an undeterminable method stays FAIL-CLOSED: variable, truncated flag, config file', () => {
    expect(isSend(`curl -X "$METHOD" https://api.resend.com/domains`)).toBe(true)
    expect(isSend(`curl https://api.resend.com/domains -X`)).toBe(true)
    expect(isSend(`curl -K /tmp/curlrc https://api.resend.com/domains`)).toBe(true)
  })

  it('a GET carrying a body is suspicious and stays closed', () => {
    expect(isSend(`curl -X GET https://api.resend.com/emails -d '{"to":"a@b.hu"}'`)).toBe(true)
  })
})

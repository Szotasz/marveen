import { describe, it, expect } from 'vitest'
// @ts-expect-error -- plain .mjs hook script, no types
import { gateDecision } from '../../scripts/email-send-gate.mjs'

// SUBGATEPOZ822: the gate blocked the DELIVERY of the mail-gate fix three
// times in one afternoon (commit message, PR body heredoc, card-comment
// sqlite write) plus five more content hits across the fleet -- all because
// the old trigger matched send-patterns anywhere in the command string. The
// old header premise ("a sub-agent has no legitimate need to invoke these")
// broke: the developer of the mail tooling is a sub-agent. (Writing THIS
// file was itself blocked by the live gate's old patterns -- the eighth
// measured false positive of the day.)
//
// Per Marveen's strict condition (msg 14282): this is a HARD-deny whose
// mistakes act outward, so REAL send attempts must keep failing -- the
// positive controls below are the acceptance bar, not decor.
describe('gateDecision Bash: content about mail no longer denies (the measured FP classes)', () => {
  const bash = (command: string) => gateDecision('Bash', { command })

  it('a git commit whose MESSAGE names the mailer binaries passes', () => {
    expect(bash('git commit -q -m "fix(hooks): sendmail/msmtp/swaks are now matched in program position, send.py needs --to"').deny).toBe(false)
  })

  it('a PR-create with a heredoc body that documents the send patterns passes', () => {
    expect(bash(`gh pr create --title "gate fix" --body-file /tmp/b.md <<'EOF'\nthe old trigger matched sendmail and api.resend.com anywhere\nEOF`).deny).toBe(false)
  })

  it('a card-comment sqlite write quoting the evidence passes', () => {
    expect(bash(`sqlite3 store/claudeclaw.db "INSERT INTO kanban_comments (card_id, author, content) VALUES ('X','Samu','a send.py es a sendmail mintak a tartalomra tuzeltek')"`).deny).toBe(false)
  })

  it('an inter-agent message about the mail infrastructure passes', () => {
    expect(bash(`curl -s -X POST http://localhost:3420/api/messages -d '{"from":"samu","to":"marveen","content":"az api.resend.com kulcs rotalva, a graph-mail send ut tesztelesre var"}'`).deny).toBe(false)
  })

  it('READING the send tooling passes (cat, grep)', () => {
    expect(bash('cat scripts/support-mail/send.py').deny).toBe(false)
    expect(bash('grep -n sendMail scripts/graph-mail.ts').deny).toBe(false)
  })
})

describe('gateDecision Bash: POSITIVE CONTROLS -- real send attempts still deny (msg 14282 acceptance bar)', () => {
  const bash = (command: string) => gateDecision('Bash', { command })

  it('the mail script executed with a recipient denies (python and direct)', () => {
    expect(bash('python3 scripts/support-mail/send.py --to x@y.hu --subject T --body B').deny).toBe(true)
    expect(bash('./scripts/support-mail/send.py --to=x@y.hu < /tmp/b.txt').deny).toBe(true)
  })

  it('the classic mailers deny, also mid-pipeline and behind env prefixes', () => {
    expect(bash('echo hi | sendmail user@host').deny).toBe(true)
    expect(bash('SMTP_DEBUG=1 msmtp a@b.hu < /tmp/m.txt').deny).toBe(true)
    expect(bash('swaks --to a@b.c --server smtp').deny).toBe(true)
  })

  it('a QUOTED provider URL in curl argument position denies (the normal curl spelling)', () => {
    expect(bash(`curl -X POST "https://api.resend.com/emails" -d @/tmp/mail.json`).deny).toBe(true)
    expect(bash(`curl 'https://api.resend.com/emails' -d @/tmp/mail.json`).deny).toBe(true)
  })

  it('a wrapper shell -c string is analyzed recursively and denies', () => {
    expect(bash(`bash -c "python3 scripts/support-mail/send.py --to a@b.hu --subject X"`).deny).toBe(true)
    expect(bash(`sh -c 'echo m | sendmail a@b.hu'`).deny).toBe(true)
  })

  it('interpreter code-strings that send deny (code handed to an interpreter is operation)', () => {
    expect(bash(`python3 -c "import smtplib; s = smtplib.SMTP('smtp.x.hu'); s.sendmail('a','b','m')"`).deny).toBe(true)
    expect(bash(`node -e "require('./src/graph-mail.js').sendMail({to:'a@b.hu'})"`).deny).toBe(true)
  })

  it('naive exec-shape in interpreter code denies; exec alone or mailer-name alone does not (msg 14298)', () => {
    expect(bash(`python3 -c "import subprocess; subprocess.run(['sendmail','-t','a@b.hu'])"`).deny).toBe(true)
    expect(bash(`node -e "require('child_process').execSync('msmtp a@b.hu < /tmp/m.txt')"`).deny).toBe(true)
    expect(bash(`python3 -c "import subprocess; subprocess.run(['ls','-la'])"`).deny).toBe(false)
    expect(bash(`python3 -c "print('a sendmail utvonala regen mas volt')"`).deny).toBe(false)
  })

  it('heredoc stripping is ORDER-INDEPENDENT: marker-first file-writes stay content, heredoc-FED senders still deny (round 3)', () => {
    expect(bash(`cat <<'EOF' > /tmp/notes.md\nsendmail --to x@y.hu is how the legacy path worked\nEOF`).deny).toBe(false)
    expect(bash(`sendmail -t a@b.hu <<'EOF'\ntorzs sora\nEOF`).deny).toBe(true)
  })

  it('an unparseable command falls back to the legacy patterns (never weaker than before)', () => {
    expect(bash(`echo "unbalanced quote and sendmail mentioned`).deny).toBe(true)
    expect(bash(`echo "unbalanced quote, harmless text`).deny).toBe(false)
  })
})

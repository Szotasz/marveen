import { describe, it, expect } from 'vitest'
// @ts-expect-error -- plain .mjs hook script, no types
import { gateDecision, stripHeredocBodies } from '../../scripts/self-pace-gate.mjs'

// A heredoc piped into an interpreter runs its body exactly like the same heredoc
// redirected into it: `cat <<'EOF' | bash` == `bash <<'EOF'`. The redirect form was
// already denied (PR #770 review); the pipe form was read as data and let through.
const deny = (command: string): boolean => gateDecision('Bash', { command }).deny
const TMUX = 'tmux send-keys -t agent-dev hi Enter'
const PY_TMUX = "import subprocess\nsubprocess.run(['tmux', 'send-keys', '-t', 'agent-dev', 'hi', 'Enter'])"

describe('self-pace-gate: heredoc piped into an interpreter', () => {
  it('DENIES pane injection in a heredoc piped into a shell', () => {
    for (const cmd of [
      `cat <<'EOF' | bash\n${TMUX}\nEOF`,
      `cat <<EOF | sh\n${TMUX}\nEOF`,
      `cat <<'EOF' | sudo bash -s\n${TMUX}\nEOF`,
      `cat <<'EOF' |& bash\n${TMUX}\nEOF`,
      `cat <<'EOF' | bash; echo done\n${TMUX}\nEOF`,
    ]) {
      expect(deny(cmd), cmd).toBe(true)
    }
  })

  it('DENIES pane injection in a heredoc piped into python / ssh', () => {
    expect(deny(`cat <<'EOF' | python3\n${PY_TMUX}\nEOF`)).toBe(true)
    expect(deny(`cat <<'EOF' | ssh box\n${TMUX}\nEOF`)).toBe(true)
  })

  it('DENIES a scheduler call in a heredoc piped into a shell', () => {
    expect(deny("cat <<'EOF' | bash\ncrontab -r\nEOF")).toBe(true)
    expect(deny("cat <<'EOF' | bash\nat now + 1 minute\nEOF")).toBe(true)
  })

  it('still ALLOWS a heredoc that only goes to a file or a non-interpreter', () => {
    for (const cmd of [
      `cat <<'EOF' > notes.txt\n${TMUX} is the incident vector\nEOF`,
      `cat <<'EOF' | tee notes.txt\n${TMUX} is the incident vector\nEOF`,
      `git commit -F - <<'EOF'\nfix: ${TMUX} handling | bash\nEOF`,
    ]) {
      expect(deny(cmd), cmd).toBe(false)
    }
  })

  it('stripHeredocBodies keeps a piped-into-interpreter body, blanks a piped-into-tee one', () => {
    expect(stripHeredocBodies(`cat <<'EOF' | bash\n${TMUX}\nEOF`)).toContain(TMUX)
    expect(stripHeredocBodies(`cat <<'EOF' | tee f\n${TMUX}\nEOF`)).not.toContain(TMUX)
  })
})

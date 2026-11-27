import { describe, it, expect } from 'vitest'
// @ts-expect-error -- plain .mjs hook script, no types
import { gateDecision } from '../../scripts/self-pace-gate.mjs'

// SELFPACEQUOTE1127: the command ssh runs on the remote host is shell code of its own (decided again, like the
// code of bash -c), and the code a program runs from its argument (python3 -c, node -e, perl -e, ruby -e) is read
// for a scheduler call. Only programs that never run an argument keep quoted text as data.
const deny = (command: string): boolean => gateDecision('Bash', { command }).deny

describe('self-pace-gate: the remote command of ssh', () => {
  it('DENIES a scheduler in it, quoted or not, behind ssh options', () => {
    for (const cmd of [
      'ssh box "crontab -r"',
      "ssh box 'at now + 1 minute'",
      'ssh localhost crontab -r',
      'ssh localhost at now',
      'ssh -p 22 -i ~/.ssh/k -o StrictHostKeyChecking=no box crontab -r',
      'ssh -J jump -vp2222 box "echo 1 | at now"',
      'ssh -- box crontab -',
      'sshpass -p x ssh box crontab -r',
      'ssh box "bash -c \'crontab -r\'"',
    ]) {
      expect(deny(cmd), cmd).toBe(true)
    }
  })

  it('DENIES an ssh option it does not know (the host position is not certain)', () => {
    expect(deny('ssh -Z box uptime')).toBe(true)
  })

  it('ALLOWS a remote command without a scheduler, and a read of the remote crontab', () => {
    for (const cmd of ['ssh box uptime', 'ssh box', 'ssh -p 22 box "crontab -l"', 'ssh box ls /tmp', 'ssh -o BatchMode=yes box "systemctl --user status x"']) {
      expect(deny(cmd), cmd).toBe(false)
    }
  })
})

describe('self-pace-gate: a scheduler in interpreter code', () => {
  it('DENIES it in python, node, perl and ruby code', () => {
    for (const cmd of [
      `python3 -c "import os; os.system('crontab -r')"`,
      `python3 -c "import subprocess; subprocess.run(['crontab','-r'])"`,
      `python3 -c "import subprocess; subprocess.run(['at','now'], input=b'x')"`,
      `python3 -c "import os; os.system('/usr/bin/at -f x now')"`,
      `python3 -c "import os; os.system('launchctl load x.plist')"`,
      `node -e "require('child_process').execSync('crontab -r')"`,
      `node -e "require('child_process').execSync('echo x | at now')"`,
      `perl -e "system('crontab -r')"`,
      `ruby -e "system('crontab -r')"`,
      `timeout 5 python3 -c "import os; os.system('crontab -r')"`,
    ]) {
      expect(deny(cmd), cmd).toBe(true)
    }
  })

  it('ALLOWS code where at is not a scheduler call', () => {
    for (const cmd of [
      `node -e "const a=[1,2]; console.log(a.at(-1))"`,
      `python3 -c "print('look at this')"`,
      `python3 -c "print('at least 3')"`,
    ]) {
      expect(deny(cmd), cmd).toBe(false)
    }
  })

  it('ALLOWS quoted text as the argument of a program that never runs it', () => {
    for (const cmd of [
      'grep "crontab -r" notes.txt',
      "echo 'at now' > x",
      'cat notes.txt | grep crontab',
      "jq '.crontab' x.json",
      "printf '%s\\n' 'crontab -r'",
      'crontab -l',
      'launchctl list | grep com.x',
    ]) {
      expect(deny(cmd), cmd).toBe(false)
    }
  })
})

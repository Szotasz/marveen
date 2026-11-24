// A bracket class with a REVERSED range (`[x-1]`, as in the Python index `row[x-1000]`) used to be read as an
// "unreadable glob" and matched every protected name, so a read-only pixel-measuring script (python heredoc) was
// denied as an egress-allowlist write (kodolo2, 2026-11-19 11:43). bash and dash expand a reversed range to nothing.
// The fix reads it as the swapped range (a superset), so nothing a shell could match is admitted. These tests pin
// both halves: the measured command now passes, every real write to a protected file is still denied.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
// @ts-expect-error -- plain .mjs hook script, no types
import { gateDecision, globMatchesName } from '../../scripts/self-pace-gate.mjs'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

let root: string
let store: string
let agentDir: string
let allowlist: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'reversed-glob-'))
  store = join(root, 'store')
  mkdirSync(store)
  // the incident's cwd: a sub-agent's own directory under the project root (agents/<name>)
  agentDir = join(root, 'agents', 'kodolo2')
  mkdirSync(agentDir, { recursive: true })
  allowlist = join(store, 'egress-allowlist.json')
  writeFileSync(allowlist, JSON.stringify({ domains: ['a.example'] }))
})
afterEach(() => { rmSync(root, { recursive: true, force: true }) })

const decide = (command: string, cwd?: string) =>
  gateDecision('Bash', { command }, { allowlistPath: allowlist, cwd: cwd ?? root })

// The command exactly as the gate stopped it (transcript 5ef0d90f, 2026-11-19T10:43:26Z): ffmpeg, then a python3
// heredoc with an UNQUOTED delimiter. The line that matched is the print with `row[x-1000]`.
const DENIED_COMMAND = String.raw`S=/tmp/claude-1000/-home-szonam-marveen-agents-kodolo2/5ef0d90f-1c3a-40d1-9eb1-30f8964f4fba/scratchpad; IMG="/mnt/c/Stalker Anomaly alapjáték/appdata/screenshots/ss_szonam_11-19-26_11-30-50_(la_cordon_bunker).jpg"; ffmpeg -v error -y -i "$IMG" -f rawvideo -pix_fmt rgb24 $S/ss.rgb && python3 - <<EOF
import numpy as np
a=np.fromfile("$S/ss.rgb",dtype=np.uint8).reshape(1440,3440,3).astype(int)
lum=a.sum(axis=2)/3
# text rows: bright pixels in x 1560..3000, y 100..1100
reg=lum[:, 1560:3050]
rows=np.where((reg>150).sum(axis=1)>3)[0]
# group rows
g=[];s=rows[0];p=rows[0]
for r in rows[1:]:
    if r-p>6: g.append((s,p)); s=r
    p=r
g.append((s,p)); print('text row groups (y):',[x for x in g if x[0]<1100 or True][:20])
# x extent of text rows 120-540
for (y0,y1) in [(120,150),(300,340)]:
    cols=np.where((lum[y0:y1,1400:3300]>150).sum(axis=0)>0)[0]+1400
    print(y0,y1,'x',cols.min(),cols.max())
# panel edges: mean luminance along row y=800 (x) and column x=2200 (y)
row=lum[1000,1000:3440]; print('row1000 lum at x', [(x,int(row[x-1000])) for x in range(1200,3440,100)])
col=lum[:,2400]; print('col2400 lum at y', [(y,int(col[y])) for y in range(300,1440,50)])
EOF`

describe('reversed bracket range in a read-only script: allowed', () => {
  // From the sub-agent's own directory, as in the incident. (From the project root itself the gate is stricter ON
  // PURPOSE: there a word that starts with an unresolved `$S/...` can be read as `*/...`, and `*` can be local-hooks.
  // That rule is not touched here.)
  it('the exact command the gate stopped now passes (cwd = agents/kodolo2)', () => {
    expect(decide(DENIED_COMMAND, agentDir)).toEqual({ deny: false })
  })
  it.each([
    ['python3 -c "print(row[x-1000])"'],
    ['python3 -c "print(lum[y-1000], row[a-1])"'],
    ['python3 - <<EOF\nprint(row[x-1000])\nEOF'],
    ["python3 - <<'EOF'\nprint(lum[y-1000])\nEOF"],
    ['node -e "console.log(arr[z-1000])"'],
  ])('%s', (cmd) => {
    expect(decide(cmd)).toEqual({ deny: false })
    expect(decide(cmd, agentDir)).toEqual({ deny: false })
  })
})

describe('real writes to the protected files stay denied (also next to a reversed range)', () => {
  const D = { deny: true, reason: 'egress-allowlist' }
  it.each([
    // 1: python open(..., 'w') on the allowlist, -c
    [`python3 -c "open('store/egress-allowlist.json','w').write('{}')"`],
    // 2: the same inside a QUOTED heredoc
    [`python3 - <<'EOF'\nopen("store/egress-allowlist.json","w").write("{}")\nEOF`],
    // 3: the same inside an UNQUOTED heredoc, extra-hooks.json this time
    [`python3 - <<EOF\nopen("${'$'}PWD/store/extra-hooks.json","w").write("{}")\nEOF`],
    // 4: the reversed-range line is present AND the script writes a local-hooks script: the new rule must not mask it
    [`python3 - <<'EOF'\nprint(row[x-1000])\nopen("local-hooks/x.py","w").write("1")\nEOF`],
    // 5: node writing the allowlist, with a reversed-range index in the same script
    [`node -e "const a=row[x-1000]; require('fs').writeFileSync('store/egress-allowlist.json','{}')"`],
    // 6: sed -i, cp, mv, tee, redirect
    ['sed -i s/a/b/ store/extra-hooks.json'],
    ['cp /tmp/x store/egress-allowlist.json'],
    ['mv /tmp/x local-hooks/a.py'],
    ['echo {} | tee store/egress-allowlist.json'],
    ['echo {} > store/egress-allowlist.json'],
    // 7: a REVERSED range used as a glob over the protected name is still read conservatively (the swapped range
    // [a-z] covers `t`), and a NEGATED reversed range stays fail-closed ([!z-a] is "any char" in bash)
  ])('%s', (cmd) => {
    expect(decide(cmd)).toEqual(D)
  })
  // a reversed range as a glob over the protected name: denied before the fix (by a generic path) and after it (by the
  // allowlist rule). Only the deny is pinned, not the reason.
  it.each([
    ['cp /tmp/x store/egress-allowlis[z-a].json'],
    ['cp /tmp/x store/egress-allowlis[!z-a].json'], // negated: "any char" in bash, so it really writes the file
  ])('%s', (cmd) => {
    expect(decide(cmd).deny).toBe(true)
  })
  // the same write seen from the sub-agent's directory (relative ../../store path)
  it('cp /tmp/x ../../store/egress-allowlist.json from agents/kodolo2', () => {
    expect(decide('cp /tmp/x ../../store/egress-allowlist.json', agentDir)).toEqual(D)
  })
})

describe('globMatchesName', () => {
  it('a reversed range is no longer "matches everything"', () => {
    expect(globMatchesName('row[x-1000]', 'local-hooks')).toBe(false)
    expect(globMatchesName('row[x-1000]', 'egress-allowlist.json')).toBe(false)
  })
  it('a reversed range is read as the swapped span, so a real target is still matched', () => {
    expect(globMatchesName('local-hook[z-a]', 'local-hooks')).toBe(true)
    expect(globMatchesName('extra-hook[z-a].json', 'extra-hooks.json')).toBe(true)
  })
  it('a negated reversed range stays fail-closed', () => {
    expect(globMatchesName('local-hook[!z-a]', 'local-hooks')).toBe(true)
    expect(globMatchesName('row[!x-1]', 'local-hooks')).toBe(true)
  })
  it('the ordinary readings are unchanged', () => {
    expect(globMatchesName('egress-allow*', 'egress-allowlist.json')).toBe(true)
    expect(globMatchesName('local-hook[s]', 'local-hooks')).toBe(true)
    expect(globMatchesName('local-hook[a-r]', 'local-hooks')).toBe(false)
    expect(globMatchesName('local-hook[!s]', 'local-hooks')).toBe(false)
    expect(globMatchesName('local-hook?', 'local-hooks')).toBe(true)
  })
})

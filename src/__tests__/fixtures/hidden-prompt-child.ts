// Child process for hidden-prompt.test.ts: asks twice, reports what it got. Runs under a pty, see the test.
// The answers go out base64-encoded: the test asserts the terminal never shows the typed text, so the
// report itself must not contain it in clear.
import { promptHidden } from '../../hidden-prompt.js'

const a = await promptHidden('New password: ')
const b = await promptHidden('Repeat password: ')
const enc = (s: string) => Buffer.from(s, 'utf-8').toString('base64')
process.stdout.write(`GOT:${enc(a)}|${enc(b)}\n`)

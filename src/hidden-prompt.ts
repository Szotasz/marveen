import { createInterface } from 'node:readline'
import { Writable } from 'node:stream'

// Interactive prompt that does not echo what is typed.
//
// readline writes EVERYTHING (the echo of each keystroke and the line-refresh
// escape sequences it uses to redraw the prompt) to the `output` stream it is
// given. The old implementation assigned `_writeToOutput` on process.stdout, a
// hook readline never calls there (it is a method of the readline Interface),
// so on a real terminal nothing was muted: the prompt text was wiped by the
// refresh sequence and the typed password showed in clear.
//
// Giving readline a throwaway sink instead needs no private API: it can echo and
// redraw into the sink all it likes, and the only bytes the user ever sees are
// the ones written to `output` below (the question, and the newline on Enter).
export function promptHidden(
  question: string,
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream = process.stdout,
): Promise<string> {
  return new Promise((resolve) => {
    const sink = new Writable({ write(_chunk, _enc, done) { done() } })
    const rl = createInterface({ input, output: sink, terminal: true })
    output.write(question)
    rl.question('', (answer) => {
      rl.close()
      output.write('\n')
      resolve(answer)
    })
  })
}

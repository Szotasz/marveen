// inputs that made the colour normalizer spend superlinear
// time (a long internal whitespace run under the old regex trim), plus their
// relatives: huge numeric tokens, huge hex / names, unbalanced parens, a
// valid colour with huge padding. Every one is longer than
// MAX_CSS_COLOR_LENGTH, so normalizeCssColor must return null for each, on the
// server and in the web/app.js mirror alike, well inside DEADLINE_MS.
export const DEADLINE_MS = 250

const run = (n: number, ch = ' ') => ch.repeat(n)

export function adversarialColourInputs(): [string, string][] {
  return [
    ['rgb(1 <64k spaces> 2 3)', 'rgb(1' + run(64_000) + '2 3)'],
    ['tab run between channels', 'rgb(1 2' + run(64_000, '\t') + '3)'],
    ['hsl hue followed by a space run', 'hsl(1' + run(64_000) + '100% 50%)'],
    ['space run before the alpha', 'rgb(1 2 3 /' + run(64_000) + '1)'],
    ['legacy comma syntax with a space run', 'rgb(1,' + run(64_000) + '2,3)'],
    ['mixed CSS whitespace run', 'rgb(1' + ' \t\n\r\f'.repeat(20_000) + '2 3)'],
    ['NBSP run (not CSS whitespace)', 'rgb(1' + run(64_000, ' ') + '2 3)'],
    ['internal run between two words', run(64_000) + 'x' + run(64_000) + 'y' + run(64_000)],
    ['a colour name padded by 64k spaces', run(64_000) + 'red' + run(64_000)],
    ['a valid rgb() with 1M trailing spaces', 'rgb(1 2 3)' + run(1_000_000)],
    ['1M-digit channel', 'rgb(' + run(1_000_000, '1') + ' 2 3)'],
    ['1M-digit hue with a unit', 'hsl(' + run(1_000_000, '1') + 'deg 100% 50%)'],
    ['1M hex digits', '#' + run(1_000_000, 'f')],
    ['1M letters', run(1_000_000, 'a')],
    ['100k open parens', 'rgb(' + run(100_000, '(')],
    ['100k space-separated channels', 'rgb(' + '1 '.repeat(100_000) + ')'],
    ['100k slashes', 'rgb(1 2 3' + run(100_000, '/') + ')'],
    ['100k commas', 'rgb(' + run(100_000, ',') + ')'],
  ]
}

// Trim / split themselves must stay linear even without the length budget:
// the budget is the first guard, the scans the second.
export function longWhitespaceRuns(): string[] {
  return [
    ' a' + run(64_000) + 'b ',
    run(64_000) + 'a' + run(64_000) + 'b' + run(64_000),
    'a' + ' \t\n\r\f'.repeat(50_000) + 'b',
  ]
}

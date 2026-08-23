/**
 * Test helper: reads all feature CSS files and concatenates them.
 * After F8 web/style.css was split into web/css/base.css + web/css/features/*.css;
 * this helper provides the same aggregated CSS string the tests used to get from style.css.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const CSS_DIR = join(__dirname, '..', '..', 'web', 'css')

export function readAllCss(): string {
  const base = readFileSync(join(CSS_DIR, 'base.css'), 'utf8')
  const featureDir = join(CSS_DIR, 'features')
  const featureFiles = readdirSync(featureDir)
    .filter(f => f.endsWith('.css'))
    .sort()
    .map(f => readFileSync(join(featureDir, f), 'utf8'))
  return [base, ...featureFiles].join('\n')
}

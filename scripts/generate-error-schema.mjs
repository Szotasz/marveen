// Updates the Error.error enum in docs/openapi.yaml from src/api-error-catalog.ts.
// Usage: node scripts/generate-error-schema.mjs
// Run automatically as part of npm run generate:sdk.
import { readFileSync, writeFileSync } from 'node:fs'

const src = readFileSync('src/api-error-catalog.ts', 'utf8')
const match = src.match(/ERROR_TOKENS = \[([\s\S]*?)\] as const/)
if (!match) { console.error('Cannot find ERROR_TOKENS array in src/api-error-catalog.ts'); process.exit(1) }
const tokens = match[1].match(/'([^']+)'/g).map(t => t.replace(/'/g, ''))

let yaml = readFileSync('docs/openapi.yaml', 'utf8')
const enumBlock = tokens.map(t => `            - ${t}`).join('\n')
yaml = yaml.replace(
  /(components:\n[\s\S]*?properties:\n\s+error:\n\s+type: string[\s\S]*?\n\s+enum:\n)([\s\S]*?)(\n\s+hint:)/,
  `$1${enumBlock}\n$3`,
)
writeFileSync('docs/openapi.yaml', yaml)
console.log(`Updated openapi.yaml Error enum: ${tokens.length} tokens`)

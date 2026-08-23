// AUTO-GENERATED SDK generator for the Marveen Dashboard API.
// Source spec: docs/openapi.yaml
// Output:      src/generated/api.ts
//
// Run: node scripts/generate-sdk.mjs
// CI check: npm run generate:sdk && git diff --exit-code src/generated/api.ts
//
// Supported spec features:
//   - components/schemas: object, string/integer/number/boolean, array, enum,
//     $ref, allOf (intersection), oneOf/anyOf (union), nullable (type: [T,'null'])
//   - paths: operationId -> request / response type aliases

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { load: parseYaml } = require('js-yaml')

// ---------------------------------------------------------------------------
// Load spec
// ---------------------------------------------------------------------------

// Allow path override for testing without touching production files.
const specPath = process.env['SDK_GEN_SPEC'] ?? 'docs/openapi.yaml'
const outPath = process.env['SDK_GEN_OUT'] ?? 'src/generated/api.ts'

const spec = parseYaml(readFileSync(specPath, 'utf-8'))

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Capitalise first letter */
function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1) }

/** Convert kebab/snake/path identifier to PascalCase */
function toPascal(s) {
  return s
    .replace(/^\//, '')                   // strip leading slash
    .split(/[-_/{}]/)
    .map(cap)
    .join('')
}

/** operationId -> PascalCase (already camelCase, just capitalise) */
function opToPascal(id) { return cap(id) }

/** Resolve $ref to a schema name ("…/schemas/Foo" -> "Foo") */
function refName(ref) {
  return ref.split('/').pop()
}

/**
 * Convert a JSON Schema node to a TypeScript type string (inline).
 * @param {object} schema
 * @param {number} depth  current nesting level (for indentation)
 */
function schemaToType(schema, depth = 0) {
  if (!schema) return 'unknown'
  const indent = '  '.repeat(depth)
  const innerIndent = '  '.repeat(depth + 1)

  // $ref
  if (schema['$ref']) return refName(schema['$ref'])

  // allOf -> intersection (&)
  if (schema.allOf) {
    return schema.allOf.map(s => schemaToType(s, depth)).join(' & ')
  }

  // oneOf / anyOf -> union (|)
  if (schema.oneOf || schema.anyOf) {
    const variants = (schema.oneOf || schema.anyOf).map(s => schemaToType(s, depth))
    return variants.join(' | ')
  }

  // nullable: type: ['something', 'null']  (OpenAPI 3.1)
  if (Array.isArray(schema.type)) {
    const nonNull = schema.type.filter(t => t !== 'null')
    const base = nonNull.length === 1
      ? primitiveOrObject({ ...schema, type: nonNull[0] }, depth)
      : nonNull.map(t => primitiveOrObject({ ...schema, type: t }, depth)).join(' | ')
    return `${base} | null`
  }

  return primitiveOrObject(schema, depth)
}

function primitiveOrObject(schema, depth) {
  const innerIndent = '  '.repeat(depth + 1)
  const closingIndent = '  '.repeat(depth)

  switch (schema.type) {
    case 'string':
      if (schema.enum) {
        return schema.enum.map(v => `'${v}'`).join(' | ')
      }
      return 'string'

    case 'integer':
    case 'number':
      return 'number'

    case 'boolean':
      return 'boolean'

    case 'null':
      return 'null'

    case 'array': {
      const itemType = schema.items ? schemaToType(schema.items, depth) : 'unknown'
      // Parenthesise union/intersection item types
      const needsParens = itemType.includes(' | ') || itemType.includes(' & ')
      return needsParens ? `(${itemType})[]` : `${itemType}[]`
    }

    case 'object':
    case undefined: {
      // No properties or additionalProperties — generic object
      if (!schema.properties && !schema.additionalProperties) {
        return 'Record<string, unknown>'
      }

      if (schema.additionalProperties && !schema.properties) {
        const valueType = schema.additionalProperties === true
          ? 'unknown'
          : schemaToType(schema.additionalProperties, depth)
        return `Record<string, ${valueType}>`
      }

      const required = new Set(schema.required ?? [])
      const props = Object.entries(schema.properties ?? {}).map(([key, propSchema]) => {
        const opt = required.has(key) ? '' : '?'
        const typeStr = schemaToType(propSchema, depth + 1)
        const descLine = propSchema.description
          ? `${innerIndent}/** ${propSchema.description} */\n`
          : ''
        return `${descLine}${innerIndent}${key}${opt}: ${typeStr};`
      })

      if (props.length === 0) return 'Record<string, unknown>'
      return `{\n${props.join('\n')}\n${closingIndent}}`
    }

    default:
      return 'unknown'
  }
}

// ---------------------------------------------------------------------------
// Emit a top-level schema as interface / type alias
// ---------------------------------------------------------------------------

function emitSchema(name, schema) {
  const lines = []

  if (schema.description) {
    lines.push(`/** ${schema.description} */`)
  }

  // Decide: interface (plain object) vs type alias (everything else)
  const isPlainObject = (schema.type === 'object' || schema.type === undefined)
    && !schema.allOf && !schema.oneOf && !schema.anyOf
    && !schema['$ref']
    && !Array.isArray(schema.type)

  if (isPlainObject && schema.properties) {
    const required = new Set(schema.required ?? [])
    lines.push(`export interface ${name} {`)
    for (const [key, propSchema] of Object.entries(schema.properties)) {
      if (propSchema.description) {
        lines.push(`  /** ${propSchema.description} */`)
      }
      const opt = required.has(key) ? '' : '?'
      lines.push(`  ${key}${opt}: ${schemaToType(propSchema, 1)};`)
    }
    lines.push('}')
  } else if (isPlainObject && !schema.properties) {
    // Object with no properties — generic
    lines.push(`export type ${name} = Record<string, unknown>`)
  } else {
    // enum, allOf, oneOf, $ref, array, primitive
    const typeStr = schemaToType(schema, 0)
    if (schema.type === 'string' && schema.enum) {
      lines.push(`export type ${name} =\n  | ${schema.enum.map(v => `'${v}'`).join('\n  | ')}`)
    } else {
      lines.push(`export type ${name} = ${typeStr}`)
    }
  }

  lines.push('')
  return lines
}

// ---------------------------------------------------------------------------
// Extract request/response schema from an operation
// ---------------------------------------------------------------------------

function resolveInlineSchema(schema) {
  if (!schema) return null
  // Only emit aliases for $ref (named type) or simple types — skip deeply
  // inline objects (would duplicate what's already in components/schemas).
  if (schema['$ref']) return refName(schema['$ref'])
  if (schema.allOf) {
    const parts = schema.allOf.map(s => s['$ref'] ? refName(s['$ref']) : schemaToType(s, 0))
    return parts.join(' & ')
  }
  if (schema.oneOf || schema.anyOf) {
    const variants = (schema.oneOf || schema.anyOf).map(s =>
      s['$ref'] ? refName(s['$ref']) : schemaToType(s, 0)
    )
    return variants.join(' | ')
  }
  if (schema.type === 'array') {
    const item = schema.items?.['$ref'] ? refName(schema.items['$ref']) : schemaToType(schema.items, 0)
    return `${item}[]`
  }
  if (schema.type === 'object' || schema.properties) return null  // skip inline objects
  return schemaToType(schema, 0)
}

function emitOperation(op) {
  const id = op.operationId
  if (!id) return []

  const lines = []
  const pascal = opToPascal(id)

  // Request body
  const reqContent = op.requestBody?.content?.['application/json']?.schema
  const reqType = resolveInlineSchema(reqContent)
  if (reqType) {
    lines.push(`export type ${pascal}Request = ${reqType}`)
  }

  // Success response (200 or 201)
  const successCode = op.responses?.['200'] || op.responses?.['201']
  const resContent = successCode?.content?.['application/json']?.schema
  const resType = resolveInlineSchema(resContent)
  if (resType) {
    lines.push(`export type ${pascal}Response = ${resType}`)
  }

  if (lines.length) lines.push('')
  return lines
}

// ---------------------------------------------------------------------------
// Build output
// ---------------------------------------------------------------------------

const out = [
  '// AUTO-GENERATED -- do not edit manually',
  `// Source: docs/openapi.yaml (${spec.info?.version ?? 'unknown'})`,
  '// Generator: scripts/generate-sdk.mjs',
  '// Run `npm run generate:sdk` to regenerate after spec changes.',
  '',
  '// -------------------------------------------------------------------------',
  '// Component schemas',
  '// -------------------------------------------------------------------------',
  '',
]

const schemas = spec.components?.schemas ?? {}
for (const [name, schema] of Object.entries(schemas)) {
  out.push(...emitSchema(name, schema))
}

out.push(
  '// -------------------------------------------------------------------------',
  '// Utility types',
  '// -------------------------------------------------------------------------',
  '',
  '/** Generic paginated response wrapper (not yet used by the spec but available for consumers) */',
  'export type PaginatedResponse<T> = { items: T[]; total: number; cursor?: string }',
  '',
  '// -------------------------------------------------------------------------',
  '// Per-operation request / response aliases',
  '// -------------------------------------------------------------------------',
  '',
)

for (const [, methods] of Object.entries(spec.paths ?? {})) {
  // Skip path-level parameters and non-operation keys
  for (const [method, op] of Object.entries(methods)) {
    if (['get', 'post', 'put', 'patch', 'delete'].includes(method) && op?.operationId) {
      out.push(...emitOperation(op))
    }
  }
}

// ---------------------------------------------------------------------------
// Write output
// ---------------------------------------------------------------------------

mkdirSync(dirname(outPath), { recursive: true })
writeFileSync(outPath, out.join('\n'))

const schemaCount = Object.keys(schemas).length
const opCount = Object.values(spec.paths ?? {})
  .flatMap(m => Object.keys(m))
  .filter(k => ['get', 'post', 'put', 'patch', 'delete'].includes(k)).length

console.log(`Generated ${outPath}: ${schemaCount} schemas, ${opCount} operations, ${out.length} lines`)

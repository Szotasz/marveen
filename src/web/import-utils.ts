// Extensions whose raw content is markup and should be stripped to plain text
// before storage and embedding, so cosine similarity finds content neighbours.
export const HTML_LIKE_EXTS = new Set(['.html', '.htm', '.xml', '.svg'])

// Strip HTML/XML/SVG markup down to plain text: removes script/style blocks,
// all tags, and common HTML entities, then normalises whitespace.
export function stripMarkup(raw: string): string {
  return raw
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z#0-9]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

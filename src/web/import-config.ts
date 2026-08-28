// Flood-guard limits for the import crawler. All values are configurable via
// this single module -- change here, every connector respects the new value.

/** Maximum content size in bytes kept per import memory (excess is truncated). */
export const MAX_CONTENT_BYTES = 100 * 1024 // 100 KB

/** Files larger than this are skipped entirely (size guard, before reading). */
export const MAX_FILE_SIZE_BYTES = 500 * 1024 // 500 KB

/** Maximum files processed per source per crawl run. */
export const MAX_FILES_PER_RUN = 1000

/** Soft cap: if import_memories total content exceeds this, no new files are inserted. */
export const MAX_TOTAL_CONTENT_BYTES = 50 * 1024 * 1024 // 50 MB

/** Maximum concurrent file reads within a single crawl run. */
export const MAX_CONCURRENT_READS = 5

/** Supported text extensions for import. */
export const ALLOWED_EXTENSIONS = new Set([
  'txt', 'md', 'mdx', 'mdc', 'json', 'html', 'htm', 'csv',
  'yaml', 'yml', 'xml', 'log', 'toml', 'ini', 'cfg', 'rst', 'tsv', 'sql',
  // Binary formats parsed by extractContent() before entering the text pipeline
  'xlsx', 'xls', 'docx',
])

/**
 * Extensions that require binary-aware parsing instead of readFileSync(utf-8).
 * Each extension must also appear in ALLOWED_EXTENSIONS.
 */
export const BINARY_EXTS = new Set(['xlsx', 'xls', 'docx'])

/**
 * Hard cap on the extracted text length from binary parsers (ZIP-bomb guard).
 * The downstream MAX_CONTENT_BYTES truncation still applies after this cap,
 * so the DB row size is bounded by MAX_CONTENT_BYTES regardless.
 */
export const MAX_EXTRACTED_BYTES = 2 * 1024 * 1024 // 2 MB

/**
 * File extensions that are unconditionally blocked from import regardless of
 * content (compliance, private key and credential formats).
 */
export const BLOCKED_EXTENSIONS = new Set([
  'env', 'key', 'pem', 'p12', 'pfx', 'der', 'crt', 'cer', 'p8', 'ppk',
  'keystore', 'jks',
])

/** File basenames (no extension) that are unconditionally blocked. */
export const BLOCKED_BASENAMES = new Set(['id_rsa', 'id_ed25519'])

/** Valid interval_hours values. */
export const VALID_INTERVALS = new Set([1, 2, 4, 24])

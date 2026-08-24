// Worker thread entry point for binary file content extraction.
// Spawned by parseBinaryInWorker() in import-crawler.ts.
// Runs in an isolated V8 heap with a capped memory limit so a malicious
// or corrupt xlsx/docx cannot OOM the main server process.
//
// Protocol:
//   input:  workerData = { filePath: string, ext: string }
//   output: postMessage({ ok: true, text: string })
//        or postMessage({ ok: false, error: string })

import { workerData, parentPort, isMainThread } from 'node:worker_threads'
import { readFileSync } from 'node:fs'

// Core extraction logic is exported so tests can exercise it directly
// without spawning a real Worker (which requires a compiled dist/ file).
export async function extractBinaryContent(filePath: string, ext: string): Promise<string> {
  if (ext === 'xlsx' || ext === 'xls') {
    const XLSX = (await import('xlsx')).default
    const buf = readFileSync(filePath)
    const wb = XLSX.read(buf, { type: 'buffer' })

    // SheetJS never throws on garbage input -- guard against empty/corrupt workbooks.
    if (wb.SheetNames.length === 0) throw new Error('empty_workbook')

    const sheets = wb.SheetNames.map(name => XLSX.utils.sheet_to_csv(wb.Sheets[name])).join('\n')

    // Reject extracted text that is mostly control characters (binary garbage
    // that SheetJS "parsed" without throwing).
    const nonPrintable = (sheets.match(/[\x00-\x08\x0E-\x1F]/g) ?? []).length
    if (nonPrintable > 0 && nonPrintable / sheets.length > 0.1) throw new Error('garbage_content')

    return sheets
  }

  // docx
  const mammoth = await import('mammoth')
  const buf = readFileSync(filePath)
  return (await mammoth.extractRawText({ buffer: buf })).value
}

// Worker entry point -- only runs when this file is the worker script,
// not when imported as a module in tests or other contexts.
if (!isMainThread) {
  const { filePath, ext } = workerData as { filePath: string; ext: string }

  extractBinaryContent(filePath, ext)
    .then(text => { parentPort!.postMessage({ ok: true, text }) })
    .catch(err => { parentPort!.postMessage({ ok: false, error: err instanceof Error ? err.message : String(err) }) })
}

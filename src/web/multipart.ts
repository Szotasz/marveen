// Egyszeru multipart/form-data parser: kep + szoveg mezok.

export interface ParsedForm {
  fields: Record<string, string>
  file?: { name: string; data: Buffer; mime: string }
}

export function parseMultipart(buf: Buffer, contentType: string): ParsedForm {
  const boundaryMatch = contentType.match(/boundary=(.+)/)
  if (!boundaryMatch) return { fields: {} }
  const boundary = boundaryMatch[1]
  const parts = buf.toString('binary').split(`--${boundary}`)

  const result: ParsedForm = { fields: {} }

  for (const part of parts) {
    if (part === '--\r\n' || part === '--' || !part.includes('Content-Disposition')) continue
    const headerEnd = part.indexOf('\r\n\r\n')
    if (headerEnd === -1) continue
    const headers = part.slice(0, headerEnd)
    const body = part.slice(headerEnd + 4).replace(/\r\n$/, '')

    const nameMatch = headers.match(/name="([^"]+)"/)
    if (!nameMatch) continue
    const fieldName = nameMatch[1]

    const filenameMatch = headers.match(/filename="([^"]+)"/)
    if (filenameMatch) {
      const mimeMatch = headers.match(/Content-Type:\s*(.+)\r?\n?/i)
      result.file = {
        name: filenameMatch[1],
        data: Buffer.from(body, 'binary'),
        mime: mimeMatch?.[1]?.trim() || 'application/octet-stream',
      }
    } else {
      result.fields[fieldName] = body
    }
  }

  return result
}

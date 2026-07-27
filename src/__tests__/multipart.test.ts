import { describe, it, expect } from 'vitest'
import { parseMultipart } from '../web/multipart.js'

function buildMultipart(
  boundary: string,
  parts: Array<{ name: string; value?: string; filename?: string; mime?: string; data?: Buffer }>,
): Buffer {
  const nl = '\r\n'
  const chunks: Buffer[] = []
  for (const part of parts) {
    chunks.push(Buffer.from(`--${boundary}${nl}`, 'binary'))
    if (part.filename !== undefined) {
      const mime = part.mime || 'application/octet-stream'
      chunks.push(Buffer.from(
        `Content-Disposition: form-data; name="${part.name}"; filename="${part.filename}"${nl}` +
        `Content-Type: ${mime}${nl}${nl}`,
        'binary',
      ))
      chunks.push(part.data ?? Buffer.from(part.value ?? '', 'binary'))
    } else {
      chunks.push(Buffer.from(
        `Content-Disposition: form-data; name="${part.name}"${nl}${nl}${part.value ?? ''}`,
        'binary',
      ))
    }
    chunks.push(Buffer.from(nl, 'binary'))
  }
  chunks.push(Buffer.from(`--${boundary}--${nl}`, 'binary'))
  return Buffer.concat(chunks)
}

describe('parseMultipart', () => {
  it('returns empty fields when boundary missing from content-type', () => {
    const result = parseMultipart(Buffer.from('anything'), 'multipart/form-data')
    expect(result).toEqual({ fields: {} })
  })

  it('parses a single text field', () => {
    const boundary = 'testboundary123'
    const buf = buildMultipart(boundary, [{ name: 'username', value: 'alice' }])
    const result = parseMultipart(buf, `multipart/form-data; boundary=${boundary}`)
    expect(result.fields.username).toBe('alice')
    expect(result.file).toBeUndefined()
  })

  it('parses multiple text fields', () => {
    const boundary = 'multibnd'
    const buf = buildMultipart(boundary, [
      { name: 'name', value: 'Bob' },
      { name: 'age', value: '42' },
    ])
    const result = parseMultipart(buf, `multipart/form-data; boundary=${boundary}`)
    expect(result.fields.name).toBe('Bob')
    expect(result.fields.age).toBe('42')
  })

  it('parses a file part', () => {
    const boundary = 'fileboundary'
    const fileData = Buffer.from('hello file content')
    const buf = buildMultipart(boundary, [
      { name: 'upload', filename: 'hello.txt', mime: 'text/plain', data: fileData },
    ])
    const result = parseMultipart(buf, `multipart/form-data; boundary=${boundary}`)
    expect(result.file).toBeDefined()
    expect(result.file!.name).toBe('hello.txt')
    expect(result.file!.mime).toBe('text/plain')
    expect(result.file!.data.toString()).toBe('hello file content')
  })

  it('defaults mime to application/octet-stream when not specified', () => {
    const boundary = 'bnd'
    // Build a file part without Content-Type header
    const nl = '\r\n'
    const raw = `--${boundary}${nl}Content-Disposition: form-data; name="f"; filename="x.bin"${nl}${nl}data${nl}--${boundary}--${nl}`
    const result = parseMultipart(Buffer.from(raw, 'binary'), `multipart/form-data; boundary=${boundary}`)
    expect(result.file!.mime).toBe('application/octet-stream')
  })

  it('parses mixed text fields and a file', () => {
    const boundary = 'mixed'
    const buf = buildMultipart(boundary, [
      { name: 'description', value: 'my upload' },
      { name: 'file', filename: 'img.png', mime: 'image/png', data: Buffer.from([0x89, 0x50]) },
    ])
    const result = parseMultipart(buf, `multipart/form-data; boundary=${boundary}`)
    expect(result.fields.description).toBe('my upload')
    expect(result.file!.name).toBe('img.png')
    expect(result.file!.mime).toBe('image/png')
  })

  it('returns empty result for empty body', () => {
    const boundary = 'bnd'
    const result = parseMultipart(Buffer.from(`--${boundary}--\r\n`, 'binary'), `multipart/form-data; boundary=${boundary}`)
    expect(result.fields).toEqual({})
    expect(result.file).toBeUndefined()
  })

  it('skips parts without Content-Disposition', () => {
    const boundary = 'bnd2'
    const nl = '\r\n'
    const raw = `--${boundary}${nl}Content-Type: text/plain${nl}${nl}no disposition${nl}--${boundary}--${nl}`
    const result = parseMultipart(Buffer.from(raw, 'binary'), `multipart/form-data; boundary=${boundary}`)
    expect(result.fields).toEqual({})
  })
})

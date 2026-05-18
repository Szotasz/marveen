import { getProvider, type ChannelProviderType } from './channel-provider.js'

const MAX_MESSAGE_LENGTH = 4096

export function formatForChannel(text: string, provider: ChannelProviderType): string {
  return getProvider(provider).formatMessage(text)
}

export function formatForTelegram(text: string): string {
  // Kódblokkok kimentése placeholderekbe
  const codeBlocks: string[] = []
  let result = text.replace(/```(\w*)\n?([\s\S]*?)```/g, (_match, lang, code) => {
    const idx = codeBlocks.length
    const escaped = escapeHtml(code.trimEnd())
    codeBlocks.push(lang ? `<pre><code class="language-${lang}">${escaped}</code></pre>` : `<pre>${escaped}</pre>`)
    return `\x00CB${idx}\x00`
  })

  // Inline kód kimentése
  const inlineCodes: string[] = []
  result = result.replace(/`([^`]+)`/g, (_match, code) => {
    const idx = inlineCodes.length
    inlineCodes.push(`<code>${escapeHtml(code)}</code>`)
    return `\x00IC${idx}\x00`
  })

  // HTML escape a szöveges részeknél
  result = escapeHtml(result)

  // Markdown konverziók
  result = result.replace(/^#{1,6}\s+(.+)$/gm, '<b>$1</b>')
  result = result.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
  result = result.replace(/__(.+?)__/g, '<b>$1</b>')
  result = result.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, '<i>$1</i>')
  result = result.replace(/(?<!_)_(?!_)(.+?)(?<!_)_(?!_)/g, '<i>$1</i>')
  result = result.replace(/~~(.+?)~~/g, '<s>$1</s>')
  result = result.replace(/\[(.+?)\]\((.+?)\)/g, '<a href="$2">$1</a>')
  result = result.replace(/^- \[ \]/gm, '☐')
  result = result.replace(/^- \[x\]/gm, '☑')

  // Elválasztók és nyers HTML eltávolítása
  result = result.replace(/^---+$/gm, '')
  result = result.replace(/^\*\*\*+$/gm, '')

  // Kódblokkok és inline kódok visszaállítása
  result = result.replace(/\x00CB(\d+)\x00/g, (_m, idx) => codeBlocks[parseInt(idx)])
  result = result.replace(/\x00IC(\d+)\x00/g, (_m, idx) => inlineCodes[parseInt(idx)])

  return result.trim()
}

export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

export function splitMessage(text: string, limit = MAX_MESSAGE_LENGTH): string[] {
  if (text.length <= limit) return [text]

  const chunks: string[] = []
  let remaining = text

  while (remaining.length > 0) {
    if (remaining.length <= limit) {
      chunks.push(remaining)
      break
    }

    let splitAt = remaining.lastIndexOf('\n', limit)
    if (splitAt === -1 || splitAt < limit * 0.3) {
      splitAt = remaining.lastIndexOf(' ', limit)
    }
    if (splitAt === -1 || splitAt < limit * 0.3) {
      splitAt = limit
    }

    chunks.push(remaining.slice(0, splitAt))
    remaining = remaining.slice(splitAt).trimStart()
  }

  return chunks
}

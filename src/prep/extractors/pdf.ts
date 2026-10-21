// PDF → per-page text (pdf.js via unpdf, pure JavaScript).
import { readFileSync } from 'node:fs'

export async function pdfPages(file: string): Promise<string[]> {
  const { extractText, getDocumentProxy } = await import('unpdf')
  const doc = await getDocumentProxy(new Uint8Array(readFileSync(file)))
  const { text } = await extractText(doc, { mergePages: false })
  return (Array.isArray(text) ? text : [text]).map((t) => t.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim())
}

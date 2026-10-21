// Plain-text reading with the encodings Windows tools actually produce (UTF-8 with/without BOM, UTF-16).
import { readFileSync } from 'node:fs'

export function decode(buf: Buffer): string {
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.subarray(3).toString('utf8')
  if (buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString('utf16le')
  if (buf[0] === 0xfe && buf[1] === 0xff) {
    const swapped = Buffer.from(buf.subarray(2))
    swapped.swap16()
    return swapped.toString('utf16le')
  }
  return buf.toString('utf8')
}

/** True if the first 8 KB look like binary (NUL bytes outside a UTF-16 BOM file). */
export function looksBinary(buf: Buffer): boolean {
  if ((buf[0] === 0xff && buf[1] === 0xfe) || (buf[0] === 0xfe && buf[1] === 0xff)) return false
  const n = Math.min(buf.length, 8192)
  let ctrl = 0
  for (let i = 0; i < n; i++) {
    const c = buf[i]
    if (c === 0) return true
    if (c < 9 || (c > 13 && c < 32)) ctrl++
  }
  return n > 0 && ctrl / n > 0.1
}

export function readText(file: string): string {
  return decode(readFileSync(file)).replace(/\r\n?/g, '\n')
}

/** CSVs can be huge per-slice exports: keep the header, a few rows and the row count. */
export function summarizeCsv(text: string, maxRows = 6): string {
  const lines = text.split('\n').filter((l) => l.trim())
  if (lines.length <= maxRows + 1) return text
  return [...lines.slice(0, maxRows + 1), `… (${lines.length - 1} data rows total)`].join('\n')
}

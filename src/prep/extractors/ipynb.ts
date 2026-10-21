// Jupyter notebooks: markdown + code cells, short text outputs (they often hold real numbers).
import { readText } from './text'

interface Cell {
  cell_type: string
  source: string | string[]
  outputs?: { output_type: string; text?: string | string[]; data?: Record<string, string | string[]> }[]
}

const join = (s: string | string[] | undefined) => (Array.isArray(s) ? s.join('') : (s ?? ''))

export function notebookText(file: string): string {
  const nb = JSON.parse(readText(file)) as { cells?: Cell[] }
  const parts: string[] = []
  for (const [i, c] of (nb.cells ?? []).entries()) {
    const src = join(c.source).trim()
    if (!src) continue
    if (c.cell_type === 'markdown') parts.push(src)
    else if (c.cell_type === 'code') {
      parts.push('```python\n' + src + '\n```')
      for (const o of c.outputs ?? []) {
        const txt = join(o.text ?? o.data?.['text/plain']).trim()
        if (txt) parts.push(`[cell ${i + 1} output] ${txt.length > 400 ? txt.slice(0, 400) + ' …' : txt}`)
      }
    }
  }
  return parts.join('\n\n')
}

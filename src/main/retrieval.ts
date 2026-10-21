// Local retrieval: BM25 over knowledge chunks, plus fuzzy matching of a question against the
// prepared Q&A bank. Runs entirely on your PC with no API calls, which matters on the free tier.

export type ChunkKind = 'code' | 'doc' | 'deck' | 'chat' | 'data' | 'notebook' | 'brief'

export interface Chunk {
  id: string
  /** Citation tag shown to the model and in cards, e.g. "scale-microct/src/segment.py:1-120". */
  source: string
  /** Absolute path of the original file. */
  path: string
  kind: ChunkKind
  title?: string
  /** ISO date for chat messages and dated notes. */
  date?: string
  text: string
  tokens: number
}

export interface QaEntry {
  question: string
  category: string
  lead: string
  bullets: string[]
  deeper: string
  sources: string[]
  verified: boolean
}

/** ≈ tokens for English/code text (Gemini averages ~4 characters per token). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.8)
}

const STOP = new Set(
  'a an the and or but if then else of to in on at by for with from as is are was were be been being it its this that these those i you he she we they me my your our their do does did done have has had having can could would should will shall may might must not no so than too very just about into over under again further once here there when where why how what which who whom all any both each few more most other some such only own same s t don now also via per vs us let lets yeah okay ok um uh like really get got use used using uses before after did make made thing things kind sort against between through during without within per take takes taking long much many way ways know'.split(
    ' '
  )
)

/** Lowercase word tokens; splits camelCase / snake_case identifiers and keeps the whole too. */
export function tokenize(text: string): string[] {
  const out: string[] = []
  const raw = text.match(/[A-Za-z][A-Za-z0-9_]*|\d+(?:\.\d+)?/g) ?? []
  for (const w of raw) {
    const lower = w.toLowerCase()
    const parts = w
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .split(/[_\s]+/)
      .map((p) => p.toLowerCase())
      .filter(Boolean)
    if (!STOP.has(lower) && lower.length > 1) out.push(stem(lower))
    if (parts.length > 1) for (const p of parts) if (!STOP.has(p) && p.length > 1) out.push(stem(p))
  }
  return out
}

/** Very light suffix stripping so "segmenting" ≈ "segmentation" ≈ "segment". */
export function stem(w: string): string {
  if (w.length <= 4 || /\d/.test(w)) return w
  for (const suf of ['ations', 'ation', 'ings', 'ing', 'ies', 'ied', 'ed', 'es', 's']) {
    if (w.endsWith(suf) && w.length - suf.length >= 4) {
      const base = w.slice(0, -suf.length)
      return suf === 'ies' || suf === 'ied' ? base + 'y' : base
    }
  }
  return w
}

export interface Hit<T> {
  item: T
  score: number
}

export class Bm25<T> {
  private docs: { item: T; tf: Map<string, number>; len: number }[] = []
  private df = new Map<string, number>()
  private avgLen = 1
  constructor(
    items: T[],
    text: (item: T) => string,
    private k1 = 1.2,
    private b = 0.75
  ) {
    let total = 0
    for (const item of items) {
      const toks = tokenize(text(item))
      const tf = new Map<string, number>()
      for (const t of toks) tf.set(t, (tf.get(t) ?? 0) + 1)
      for (const t of tf.keys()) this.df.set(t, (this.df.get(t) ?? 0) + 1)
      this.docs.push({ item, tf, len: toks.length })
      total += toks.length
    }
    this.avgLen = this.docs.length ? total / this.docs.length : 1
  }

  get size(): number {
    return this.docs.length
  }

  /** Number of chunks containing the (tokenized) term. */
  docFreq(term: string): number {
    return this.df.get(term) ?? 0
  }

  idf(term: string): number {
    const n = this.df.get(term) ?? 0
    return Math.log(1 + (this.docs.length - n + 0.5) / (n + 0.5))
  }

  search(query: string, k = 10): Hit<T>[] {
    const terms = [...new Set(tokenize(query))]
    if (!terms.length) return []
    const scored: Hit<T>[] = []
    for (const d of this.docs) {
      let s = 0
      for (const t of terms) {
        const f = d.tf.get(t)
        if (!f) continue
        s += (this.idf(t) * f * (this.k1 + 1)) / (f + this.k1 * (1 - this.b + (this.b * d.len) / this.avgLen))
      }
      if (s > 0) scored.push({ item: d.item, score: s })
    }
    return scored.sort((a, b) => b.score - a.score).slice(0, k)
  }

  /** Highest score any document could get for this query (all terms present once in an average doc). */
  maxScore(query: string): number {
    return [...new Set(tokenize(query))].reduce((s, t) => s + this.idf(t), 0)
  }
}

/** Reciprocal-rank fusion of several ranked lists (by id). */
export function rrf(lists: string[][], k = 60): string[] {
  const score = new Map<string, number>()
  for (const list of lists) list.forEach((id, i) => score.set(id, (score.get(id) ?? 0) + 1 / (k + i + 1)))
  return [...score.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id)
}

export function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0
}

/** Share of the question's content words found in the candidate (0..1). */
export function overlap(question: string, candidate: string): number {
  const q = new Set(tokenize(question))
  if (!q.size) return 0
  const c = new Set(tokenize(candidate))
  let hit = 0
  for (const t of q) if (c.has(t)) hit++
  return hit / q.size
}

/**
 * Finds the prepared Q&A entry for a live question. Confident only when most of the question's
 * content words match one bank question, so a prepared card never answers a different question.
 */
export function matchQa(question: string, bank: QaEntry[]): { entry: QaEntry; confidence: number } | null {
  let best: { entry: QaEntry; confidence: number } | null = null
  for (const entry of bank) {
    const a = overlap(question, entry.question)
    const b = overlap(entry.question, question)
    const confidence = (2 * a * b) / (a + b || 1) // F1 of word overlap
    if (!best || confidence > best.confidence) best = { entry, confidence }
  }
  return best
}

/** "[src: a.py:1-9] (2026-09-10)" → "a.py:1-9" */
export function cleanSource(s: string): string {
  return s
    .replace(/^\s*\[?\s*src:\s*/i, '')
    .replace(/\]\s*(?:\(\d{4}-\d{2}-\d{2}\))?\s*$/, '')
    .replace(/\s*\(\d{4}-\d{2}-\d{2}\)\s*$/, '')
    .trim()
}

const stripCites = (s: string) => s.replace(/\s*\[src:[^\]]*\]/g, '').trim()

/** A prepared Q&A entry as an answer card (inline citations moved to the sources line). */
export function renderQaCard(e: QaEntry): string {
  const lines = [`**${stripCites(e.lead)}**`, ...e.bullets.slice(0, 3).map((b) => `• ${stripCites(b)}`)]
  if (e.deeper) lines.push(`↳ If pushed: ${stripCites(e.deeper)}`)
  lines.push(`[sources: ${e.sources.length ? e.sources.join(', ') : 'none'}]`)
  return lines.join('\n')
}

/**
 * The 1–2 most relevant sentences from the top chunks, as an instant "from your notes" card while
 * the live answer is on its way. Pure local search.
 */
export function quickNotes(question: string, chunks: Chunk[], idf: (t: string) => number = () => 1, maxLines = 2): { text: string; sources: string[] } | null {
  const q = [...new Set(tokenize(question))]
  if (q.length < 2) return null
  const total = q.reduce((s, t) => s + idf(t), 0)
  const cands: { s: string; src: string; score: number }[] = []
  for (const c of chunks.slice(0, 6)) {
    if (c.kind === 'data') continue
    const body = c.text.replace(/^File: .*\n/, '').replace(/^Chat ".*\n/, '')
    for (const raw of body.split(/(?<=[.!?])\s+|\n+/)) {
      let s = raw.replace(/^\[[^\]]+\]\s*/, '').replace(/^[-*#>\s]+/, '').replace(/\s+/g, ' ').trim()
      // Chat lines: an AI suggestion is weaker evidence than something you said.
      const fromAi = /^AI:\s*/.test(s)
      s = s.replace(/^(?:AI|[A-Z][A-Z]+ \(user\)):\s*/, '')
      // Skip code plumbing, bare titles, and questions (a question isn't an answer).
      if (s.length < 20 || s.length > 220 || /^(?:(?:import|from|def|class|return)\b|slide \d+:|")/i.test(s) || /\?$/.test(s)) continue
      const toks = new Set(tokenize(s))
      let hit = 0
      let weight = 0
      for (const t of q)
        if (toks.has(t)) {
          hit++
          weight += idf(t)
        }
      const score = weight / (total || 1) - (fromAi ? 0.15 : 0)
      // One matching word is enough only if it's a rare, specific one.
      if (hit >= 2 || score >= 0.45) cands.push({ s, src: c.source, score })
    }
  }
  const sorted = cands.sort((a, b) => b.score - a.score).filter((c, i, arr) => arr.findIndex((x) => x.s === c.s) === i)
  // A second line only if it's nearly as relevant as the first.
  const best = sorted.filter((c, i) => i === 0 || c.score >= sorted[0].score * 0.7).slice(0, maxLines)
  if (!best.length || best[0].score < 0.4) return null
  const sources = [...new Set(best.map((b) => b.src))]
  return { text: [`**From your notes**`, ...best.map((b) => `• ${b.s}`), `[sources: ${sources.join(', ')}]`].join('\n'), sources }
}

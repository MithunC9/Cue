// The knowledge folder written by `npm run prep`, and live retrieval over it.
// Electron-free so prep and the app share it.
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { Bm25, cosine, estimateTokens, matchQa, quickNotes, rrf, type Chunk, type QaEntry } from './retrieval'

export interface SlideInfo {
  index: number
  title: string
  text: string
  notes: string
}

export interface SlidePrep {
  index: number
  talking_points: string[]
  likely_question: string
  answer: string
  sources: string[]
}

export interface EmbeddingIndex {
  model: string
  dims: number
  ids: string[]
  vectors: Float32Array[]
}

export const FILES = {
  chunks: 'chunks.jsonl',
  manifest: 'manifest.json',
  brief: 'brief.md',
  qaJson: 'qa.json',
  qaMd: 'qa_bank.md',
  gaps: 'gaps.md',
  slides: 'slides.json',
  slidePrep: 'slides_prep.json',
  embeddings: 'embeddings.bin',
  embeddingsMeta: 'embeddings.json',
  cache: 'cache.json'
}

export function writeChunks(dir: string, chunks: Chunk[]): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, FILES.chunks), chunks.map((c) => JSON.stringify(c)).join('\n') + '\n')
}

export function readChunks(dir: string): Chunk[] {
  const f = path.join(dir, FILES.chunks)
  if (!existsSync(f)) return []
  return readFileSync(f, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Chunk)
}

export function writeEmbeddings(dir: string, idx: EmbeddingIndex): void {
  const buf = Buffer.alloc(idx.ids.length * idx.dims * 4)
  idx.vectors.forEach((v, i) => Buffer.from(v.buffer, v.byteOffset, v.byteLength).copy(buf, i * idx.dims * 4))
  writeFileSync(path.join(dir, FILES.embeddings), buf)
  writeFileSync(path.join(dir, FILES.embeddingsMeta), JSON.stringify({ model: idx.model, dims: idx.dims, ids: idx.ids }))
}

export function readEmbeddings(dir: string): EmbeddingIndex | null {
  const metaFile = path.join(dir, FILES.embeddingsMeta)
  const binFile = path.join(dir, FILES.embeddings)
  if (!existsSync(metaFile) || !existsSync(binFile)) return null
  const meta = JSON.parse(readFileSync(metaFile, 'utf8')) as { model: string; dims: number; ids: string[] }
  const buf = readFileSync(binFile)
  const all = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4)
  const vectors = meta.ids.map((_, i) => all.subarray(i * meta.dims, (i + 1) * meta.dims))
  return { ...meta, vectors }
}

const readIf = (f: string) => (existsSync(f) ? readFileSync(f, 'utf8') : '')
const readJson = <T>(f: string, fallback: T): T => {
  try {
    return existsSync(f) ? (JSON.parse(readFileSync(f, 'utf8')) as T) : fallback
  } catch {
    return fallback
  }
}

export interface ContextResult {
  text: string
  sources: string[]
  tokens: number
}

export class KnowledgeBase {
  readonly chunks: Chunk[]
  readonly byId: Map<string, Chunk>
  readonly bm25: Bm25<Chunk>
  readonly brief: string
  readonly qa: QaEntry[]
  readonly slides: SlideInfo[]
  readonly slidePrep: SlidePrep[]
  readonly embeddings: EmbeddingIndex | null
  readonly loadedAt = Date.now()
  /** Changes whenever prep rewrites the chunks (used to invalidate the paid-tier cache). */
  readonly loadedStamp: number

  constructor(readonly dir: string) {
    this.chunks = readChunks(dir)
    this.byId = new Map(this.chunks.map((c) => [c.id, c]))
    this.bm25 = new Bm25(this.chunks, (c) => `${c.source} ${c.title ?? ''} ${c.text}`)
    this.brief = readIf(path.join(dir, FILES.brief))
    this.qa = readJson<QaEntry[]>(path.join(dir, FILES.qaJson), [])
    this.slides = readJson<SlideInfo[]>(path.join(dir, FILES.slides), [])
    this.slidePrep = readJson<SlidePrep[]>(path.join(dir, FILES.slidePrep), [])
    this.embeddings = readEmbeddings(dir)
    const f = path.join(dir, FILES.chunks)
    this.loadedStamp = existsSync(f) ? Math.round(statSync(f).mtimeMs) : 0
  }

  static exists(dir: string): boolean {
    return existsSync(path.join(dir, FILES.chunks))
  }

  get empty(): boolean {
    return !this.chunks.length && !this.brief
  }

  /** Ranked chunk ids: BM25, fused with embedding similarity when a query vector is available. */
  rank(query: string, queryVector?: Float32Array | null, k = 30): Chunk[] {
    const lexical = this.bm25.search(query, k).map((h) => h.item.id)
    if (!queryVector || !this.embeddings) return lexical.map((id) => this.byId.get(id)!).filter(Boolean)
    const sims = this.embeddings.ids
      .map((id, i) => ({ id, s: id.startsWith('qa:') ? -1 : cosine(queryVector, this.embeddings!.vectors[i]) }))
      .sort((a, b) => b.s - a.s)
      .slice(0, k)
      .map((x) => x.id)
    return rrf([lexical, sims])
      .slice(0, k)
      .map((id) => this.byId.get(id)!)
      .filter(Boolean)
  }

  /**
   * Context for one live question: brief.md always, then the best chunks (current slide's deck chunk
   * first) until the token budget is used.
   */
  contextFor(question: string, budget: number, queryVector?: Float32Array | null, slideIndex?: number): ContextResult {
    const parts: string[] = []
    const sources: string[] = []
    let used = 0
    if (this.brief) {
      parts.push(`### SOURCE: brief.md (prep summary, cites the original sources)\n${this.brief}`)
      used += estimateTokens(this.brief)
    }
    const qaHits = this.qa
      .map((e) => ({ e, m: matchQa(question, [e])!.confidence }))
      .filter((x) => x.m >= 0.35)
      .sort((a, b) => b.m - a.m)
      .slice(0, 2)
    for (const { e } of qaHits) {
      const t = `### SOURCE: qa_bank.md (prepared answer${e.verified ? '' : ', UNVERIFIED'})\nQ: ${e.question}\nA: ${e.lead}\n${e.bullets.map((b) => `- ${b}`).join('\n')}\nCites: ${e.sources.join(', ') || 'none'}`
      parts.push(t)
      used += estimateTokens(t)
    }
    const ranked = this.rank(question, queryVector)
    if (slideIndex) {
      const slide = this.chunks.find((c) => c.kind === 'deck' && new RegExp(`slide ${slideIndex}$`).test(c.source))
      if (slide) ranked.unshift(slide)
    }
    const seen = new Set<string>()
    for (const c of ranked) {
      if (seen.has(c.id)) continue
      seen.add(c.id)
      if (used + c.tokens > budget) continue
      parts.push(`### SOURCE: ${c.source}${c.date ? ` (${c.date.slice(0, 10)})` : ''}\n${c.text}`)
      sources.push(c.source)
      used += c.tokens
    }
    return { text: parts.join('\n\n'), sources, tokens: used }
  }

  instantAnswer(question: string, minConfidence = 0.6): { entry: QaEntry; confidence: number } | null {
    const m = matchQa(question, this.qa)
    return m && m.confidence >= minConfidence ? m : null
  }

  /** Embedding match against the prepared questions (ids "qa:<n>" in the embedding index). */
  semanticQa(vector: Float32Array, minCosine: number): { entry: QaEntry; confidence: number } | null {
    if (!this.embeddings) return null
    let best: { entry: QaEntry; confidence: number } | null = null
    this.embeddings.ids.forEach((id, i) => {
      if (!id.startsWith('qa:')) return
      const entry = this.qa[Number(id.slice(3))]
      if (!entry) return
      const c = cosine(vector, this.embeddings!.vectors[i])
      if (!best || c > best.confidence) best = { entry, confidence: c }
    })
    return best && (best as { confidence: number }).confidence >= minCosine ? best : null
  }

  notesFor(question: string): { text: string; sources: string[] } | null {
    // Words that appear nowhere in your notes can't be matched, so they don't count against a line.
    return quickNotes(question, this.rank(question, null, 8), (t) => (this.bm25.docFreq(t) ? this.bm25.idf(t) : 0))
  }
}

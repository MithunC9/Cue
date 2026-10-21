// Walks the configured sources and turns them into tagged chunks + manifest.json.
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import type { CueConfig } from '../main/config'
import { estimateTokens, type Chunk, type ChunkKind } from '../main/retrieval'
import { claudeCodeSessions, codexSessions, exportSessions, isRelevant, type ChatSession } from './extractors/chats'
import { CODE_EXT, DOC_BINARY_EXT, RAW_DATA_EXT, TEXT_EXT, outline } from './extractors/code'
import { notebookText } from './extractors/ipynb'
import { docxText, pptxSlides, type Slide } from './extractors/office'
import { pdfPages } from './extractors/pdf'
import { decode, looksBinary, summarizeCsv } from './extractors/text'

const SKIP_DIRS = new Set([
  '.git', '.hg', '.svn', 'node_modules', '.venv', 'venv', 'env', '.env', '__pycache__', '.mypy_cache', '.pytest_cache', '.ruff_cache', '.tox',
  '.eggs', 'build', 'dist', 'out', 'target', '.idea', '.vscode', '.ipynb_checkpoints', 'site-packages', '.cache', '.next', 'coverage', '.gradle'
])
const SKIP_FILES = new Set(['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'poetry.lock', 'pipfile.lock', 'uv.lock', 'cargo.lock', '.ds_store', 'thumbs.db'])
const MAX_TEXT_BYTES = 2 * 1024 * 1024
const CHUNK_TOKENS = 900
const MAX_FILES = 25_000

export interface RawDataGroup {
  folder: string
  count: number
  bytes: number
  exts: Record<string, number>
  examples: string[]
}

export interface Manifest {
  created: string
  meeting: CueConfig['meeting']
  sources: CueConfig['sources']
  missing: string[]
  totals: { files: number; chunks: number; tokens: number; byKind: Record<string, number> }
  included: { path: string; kind: ChunkKind; tokens: number; mode: 'full' | 'outline' | 'summary' }[]
  skipped: { path: string; reason: string }[]
  rawData: RawDataGroup[]
  chats: { origin: string; id: string; title: string; started?: string; messages: number; kept: boolean; why: string }[]
}

export interface IngestResult {
  chunks: Chunk[]
  manifest: Manifest
  slides: Slide[]
  log: string[]
}

const hash = (s: string) => createHash('sha1').update(s).digest('hex').slice(0, 12)
const fmtBytes = (n: number) => (n > 1e9 ? `${(n / 1e9).toFixed(1)} GB` : n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.ceil(n / 1e3)} KB`)
const slash = (p: string) => p.split(path.sep).join('/')

/** Splits text into ~CHUNK_TOKENS pieces on blank-line / declaration boundaries, tracking line numbers. */
export function splitLines(text: string, maxTokens = CHUNK_TOKENS): { text: string; start: number; end: number }[] {
  const lines = text.split('\n')
  const out: { text: string; start: number; end: number }[] = []
  let buf: string[] = []
  let start = 1
  let size = 0
  const maxChars = maxTokens * 3.8
  const push = (endLine: number) => {
    const t = buf.join('\n').trim()
    if (t) out.push({ text: t, start, end: endLine })
    buf = []
    size = 0
    start = endLine + 1
  }
  lines.forEach((line, i) => {
    const boundary = !line.trim() || /^(?:def |class |async def |function |export |#{1,3} )/.test(line)
    if (size > maxChars * 0.6 && boundary) push(i)
    buf.push(line)
    size += line.length + 1
    if (size > maxChars) push(i + 1)
  })
  push(lines.length)
  return out
}

class Builder {
  chunks: Chunk[] = []
  included: Manifest['included'] = []
  skipped: Manifest['skipped'] = []
  raw = new Map<string, RawDataGroup>()
  log: string[] = []

  add(kind: ChunkKind, file: string, source: string, text: string, extra: Partial<Chunk> = {}): void {
    const t = text.trim()
    if (!t) return
    this.chunks.push({ id: hash(source + t.slice(0, 200)), source, path: file, kind, text: t, tokens: estimateTokens(t), ...extra })
  }

  addRaw(root: string, file: string, size: number): void {
    const folder = slash(path.relative(root, path.dirname(file))) || '.'
    const key = `${path.basename(root)}/${folder}`
    const g = this.raw.get(key) ?? { folder: key, count: 0, bytes: 0, exts: {}, examples: [] }
    const ext = path.extname(file).toLowerCase() || '(none)'
    g.count++
    g.bytes += size
    g.exts[ext] = (g.exts[ext] ?? 0) + 1
    if (g.examples.length < 3) g.examples.push(path.basename(file))
    this.raw.set(key, g)
  }
}

function* walk(root: string, b: Builder): Generator<{ file: string; size: number }> {
  const stack = [root]
  let n = 0
  while (stack.length) {
    const dir = stack.pop()!
    let names: string[]
    try {
      names = readdirSync(dir)
    } catch (err) {
      b.skipped.push({ path: dir, reason: `unreadable: ${(err as Error).message}` })
      continue
    }
    for (const name of names.sort()) {
      const p = path.join(dir, name)
      let st
      try {
        st = statSync(p)
      } catch {
        continue
      }
      if (st.isDirectory()) {
        if (SKIP_DIRS.has(name.toLowerCase()) || name.endsWith('.egg-info')) b.skipped.push({ path: p, reason: 'skipped folder' })
        else stack.push(p)
      } else if (st.isFile()) {
        if (++n > MAX_FILES) {
          b.log.push(`⚠ stopped after ${MAX_FILES} files in ${root}; point sources at a narrower folder`)
          return
        }
        yield { file: p, size: st.size }
      }
    }
  }
}

async function addFile(b: Builder, root: string, label: string, file: string, size: number, kindHint: ChunkKind): Promise<void> {
  const name = path.basename(file)
  const ext = path.extname(name).toLowerCase()
  const rel = `${label}/${slash(path.relative(root, file)) || name}`
  if (SKIP_FILES.has(name.toLowerCase())) return void b.skipped.push({ path: file, reason: 'lockfile' })
  if (RAW_DATA_EXT.has(ext) || name.toLowerCase().endsWith('.nii.gz')) return b.addRaw(root, file, size)
  if (size > MAX_TEXT_BYTES && !['.pdf', '.pptx', '.docx'].includes(ext)) return b.addRaw(root, file, size)
  try {
    if (ext === '.pdf') {
      const pages = await pdfPages(file)
      let buf = ''
      let from = 1
      pages.forEach((pg, i) => {
        buf += (buf ? '\n\n' : '') + pg
        if (estimateTokens(buf) > CHUNK_TOKENS || i === pages.length - 1) {
          b.add(kindHint, file, `${rel} p${from === i + 1 ? from : `${from}-${i + 1}`}`, buf)
          buf = ''
          from = i + 2
        }
      })
      b.included.push({ path: file, kind: kindHint, tokens: estimateTokens(pages.join('\n')), mode: 'full' })
      if (!pages.join('').trim()) b.log.push(`⚠ ${rel}: no text layer (scanned PDF?). Not searchable.`)
      return
    }
    if (ext === '.pptx') {
      const slides = await pptxSlides(file)
      for (const s of slides) b.add(kindHint, file, `${rel} slide ${s.index}`, `# ${s.title}\n${s.text}${s.notes ? `\nSpeaker notes: ${s.notes}` : ''}`)
      b.included.push({ path: file, kind: kindHint, tokens: slides.reduce((t, s) => t + estimateTokens(s.title + s.text + s.notes), 0), mode: 'full' })
      return
    }
    if (ext === '.docx') {
      const text = await docxText(file)
      for (const c of splitLines(text)) b.add(kindHint, file, `${rel}:${c.start}-${c.end}`, c.text)
      b.included.push({ path: file, kind: kindHint, tokens: estimateTokens(text), mode: 'full' })
      return
    }
    if (ext === '.ipynb') {
      const text = notebookText(file)
      for (const c of splitLines(text)) b.add('notebook', file, `${rel} §${c.start}-${c.end}`, c.text)
      b.included.push({ path: file, kind: 'notebook', tokens: estimateTokens(text), mode: 'full' })
      return
    }
    const isCode = CODE_EXT.has(ext)
    if (!isCode && !TEXT_EXT.has(ext) && !DOC_BINARY_EXT.has(ext) && ext !== '' && !/^(readme|license|makefile|dockerfile|notes?)/i.test(name)) {
      // Unknown extension: read it if it's text, else inventory it.
      const head = readFileSync(file).subarray(0, 8192)
      if (looksBinary(head)) return b.addRaw(root, file, size)
    }
    const buf = readFileSync(file)
    if (looksBinary(buf)) return b.addRaw(root, file, size)
    let text = decode(buf).replace(/\r\n?/g, '\n')
    let mode: 'full' | 'summary' = 'full'
    if (ext === '.csv' || ext === '.tsv') {
      text = summarizeCsv(text)
      mode = 'summary'
    }
    const kind: ChunkKind = isCode ? 'code' : kindHint
    for (const c of splitLines(text)) b.add(kind, file, `${rel}:${c.start}-${c.end}`, `File: ${rel}\n${c.text}`)
    b.included.push({ path: file, kind, tokens: estimateTokens(text), mode })
  } catch (err) {
    b.skipped.push({ path: file, reason: `failed to read: ${(err as Error).message.slice(0, 120)}` })
  }
}

function chatChunks(b: Builder, s: ChatSession, me: string): void {
  const day = (s.started ?? s.messages[0]?.at ?? '').slice(0, 10) || 'undated'
  const source = `chat:${s.origin}/${day}/${s.id.replace(/^rollout-/, '').replace(/^\d{4}-\d{2}-\d{2}(?:T[\d-]+)?-?/, '').slice(0, 8) || hash(s.id).slice(0, 8)}`
  let buf: string[] = []
  let tokens = 0
  let first: string | undefined
  const flush = () => {
    if (buf.length) b.add('chat', s.file, source, `Chat "${s.title.replace(/\s+/g, ' ').slice(0, 90)}" (${s.origin}, ${day})\n` + buf.join('\n'), { date: first, title: s.title })
    buf = []
    tokens = 0
    first = undefined
  }
  for (const m of s.messages) {
    const stamp = m.at ? m.at.replace('T', ' ').slice(0, 16) : day
    const line = `[${stamp}] ${m.role === 'user' ? `${me.toUpperCase()} (user)` : 'AI'}: ${m.text}`
    const t = estimateTokens(line)
    if (tokens + t > CHUNK_TOKENS * 1.5 && buf.length) flush()
    first ??= m.at
    buf.push(t > CHUNK_TOKENS * 2 ? line.slice(0, CHUNK_TOKENS * 2 * 3.8) + ' …' : line)
    tokens += t
  }
  flush()
}

export async function ingest(cfg: CueConfig, corpusBudget = 700_000): Promise<IngestResult> {
  const b = new Builder()
  const missing: string[] = []
  const exists = (p: string) => {
    if (p && existsSync(p)) return true
    if (p) missing.push(p)
    return false
  }
  const slides: Slide[] = []

  for (const repo of cfg.sources.repos) {
    if (!exists(repo)) continue
    const label = path.basename(repo)
    for (const { file, size } of walk(repo, b)) await addFile(b, repo, label, file, size, 'doc')
    b.log.push(`repo ${label}: done`)
  }
  for (const dir of cfg.sources.docs) {
    if (!exists(dir)) continue
    if (statSync(dir).isFile()) {
      await addFile(b, path.dirname(dir), path.basename(path.dirname(dir)), dir, statSync(dir).size, 'doc')
      continue
    }
    const label = path.basename(dir)
    for (const { file, size } of walk(dir, b)) await addFile(b, dir, label, file, size, 'doc')
  }
  if (cfg.sources.deck && exists(cfg.sources.deck)) {
    const deck = cfg.sources.deck
    const ext = path.extname(deck).toLowerCase()
    const name = path.basename(deck)
    if (ext === '.pptx') slides.push(...(await pptxSlides(deck)))
    else if (ext === '.pdf')
      (await pdfPages(deck)).forEach((t, i) => {
        const lines = t.split('\n').filter((l) => l.trim())
        slides.push({ index: i + 1, title: lines[0] ?? `Page ${i + 1}`, text: lines.slice(1).join('\n'), notes: '' })
      })
    else b.log.push(`⚠ deck must be .pptx or .pdf: ${deck}`)
    for (const s of slides) b.add('deck', deck, `${name} slide ${s.index}`, `Slide ${s.index}: ${s.title}\n${s.text}${s.notes ? `\nSpeaker notes: ${s.notes}` : ''}`)
    if (slides.length) b.included.push({ path: deck, kind: 'deck', tokens: slides.reduce((t, s) => t + estimateTokens(s.title + s.text + s.notes), 0), mode: 'full' })
  }

  const chats: Manifest['chats'] = []
  const sessions: ChatSession[] = []
  if (cfg.sources.claude_code && exists(cfg.sources.claude_code)) sessions.push(...claudeCodeSessions(cfg.sources.claude_code))
  if (cfg.sources.codex && existsSync(cfg.sources.codex)) sessions.push(...codexSessions(cfg.sources.codex))
  for (const e of cfg.sources.chat_exports) if (exists(e)) sessions.push(...exportSessions(e))
  for (const s of sessions.sort((a, b2) => (a.started ?? '').localeCompare(b2.started ?? ''))) {
    const rel = isRelevant(s, cfg.sources.repos, cfg.keywords)
    chats.push({ origin: s.origin, id: s.id, title: s.title.slice(0, 100), started: s.started, messages: s.messages.length, kept: rel.keep, why: rel.why })
    if (rel.keep) chatChunks(b, s, cfg.meeting.me)
  }

  // Raw data inventory becomes a chunk too, so answers know what data exists and how it's organized.
  const rawData = [...b.raw.values()].sort((x, y) => y.bytes - x.bytes)
  if (rawData.length) {
    const lines = rawData.map(
      (g) =>
        `- ${g.folder}: ${g.count} files, ${fmtBytes(g.bytes)} (${Object.entries(g.exts)
          .map(([e, n]) => `${n}× ${e}`)
          .join(', ')}; e.g. ${g.examples.join(', ')})`
    )
    for (let i = 0; i < lines.length; i += 40)
      b.add('data', '', `data-inventory${i ? `#${i / 40 + 1}` : ''}`, `Raw data / binary files found (names and sizes only, contents not read):\n${lines.slice(i, i + 40).join('\n')}`)
  }

  // Over budget: replace the biggest code files' bodies with their outline until it fits.
  let total = b.chunks.reduce((t, c) => t + c.tokens, 0)
  if (total > corpusBudget) {
    const byFile = new Map<string, Chunk[]>()
    for (const c of b.chunks) if (c.kind === 'code') byFile.set(c.path, [...(byFile.get(c.path) ?? []), c])
    const big = [...byFile.entries()].sort((x, y) => y[1].reduce((t, c) => t + c.tokens, 0) - x[1].reduce((t, c) => t + c.tokens, 0))
    for (const [file, chunks] of big) {
      if (total <= corpusBudget) break
      const before = chunks.reduce((t, c) => t + c.tokens, 0)
      const label = chunks[0].source.split(':')[0]
      const out = outline(decode(readFileSync(file)).replace(/\r\n?/g, '\n'))
      b.chunks = b.chunks.filter((c) => c.path !== file || c.kind !== 'code')
      for (const c of splitLines(out)) b.add('code', file, `${label} (outline):${c.start}-${c.end}`, `File: ${label} (signatures, docstrings, comments only)\n${c.text}`)
      const after = estimateTokens(out)
      total += after - before
      const inc = b.included.find((x) => x.path === file)
      if (inc) Object.assign(inc, { mode: 'outline', tokens: after })
    }
  }

  const byKind: Record<string, number> = {}
  for (const c of b.chunks) byKind[c.kind] = (byKind[c.kind] ?? 0) + c.tokens
  const manifest: Manifest = {
    created: new Date().toISOString(),
    meeting: cfg.meeting,
    sources: cfg.sources,
    missing,
    totals: { files: b.included.length, chunks: b.chunks.length, tokens: b.chunks.reduce((t, c) => t + c.tokens, 0), byKind },
    included: b.included,
    skipped: b.skipped.slice(0, 2000),
    rawData,
    chats
  }
  return { chunks: b.chunks, manifest, slides, log: b.log }
}

import assert from 'node:assert/strict'
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { DEFAULT_CONFIG, type CueConfig } from '../src/main/config'
import { Bm25, matchQa, quickNotes, renderQaCard, tokenize, type Chunk, type QaEntry } from '../src/main/retrieval'
import { checkCitations, selectDigest } from '../src/prep/brief'
import { cleanChatText, isRelevant } from '../src/prep/extractors/chats'
import { outline } from '../src/prep/extractors/code'
import { docxText, pptxSlides } from '../src/prep/extractors/office'
import { decode } from '../src/prep/extractors/text'
import { ingest, splitLines } from '../src/prep/ingest'

const FIX = path.join(__dirname, 'fixtures', 'sample')

/** Copies the committed fixture and adds the things git can't hold (.git, node_modules, a 3 MB blob). */
function workspace(): { root: string; cfg: CueConfig } {
  const root = mkdtempSync(path.join(tmpdir(), 'cue-prep-'))
  cpSync(FIX, root, { recursive: true })
  const repo = path.join(root, 'scale-microct')
  for (const d of ['.git', 'node_modules/x', 'venv/lib']) mkdirSync(path.join(repo, d), { recursive: true })
  writeFileSync(path.join(repo, '.git', 'config'), '[core]')
  writeFileSync(path.join(repo, 'node_modules', 'x', 'index.js'), 'module.exports = 1')
  writeFileSync(path.join(repo, 'data', 'big_unknown.bin2'), Buffer.alloc(3 * 1024 * 1024, 7))
  const cfg = structuredClone(DEFAULT_CONFIG)
  cfg.sources = {
    repos: [repo],
    docs: [path.join(root, 'lab notes')],
    deck: path.join(root, 'progress_update.pptx'),
    claude_code: path.join(root, 'claude-projects', 'C--Users-Mithun-code-scale-microct'),
    codex: path.join(root, 'codex-sessions'),
    chat_exports: [path.join(root, 'chatgpt-export'), path.join(root, 'claude-export.json')]
  }
  cfg.keywords = ['microCT', 'SCANCO', 'segmentation', 'DICOM', 'TD-309', 'Abaqus', 'FEM', 'voxel', 'compression']
  cfg.meeting.me = 'Mithun'
  return { root, cfg }
}

test('ingest: skips junk, inventories raw data, keeps relevant chats, reads every format', async () => {
  const { cfg } = workspace()
  const { chunks, manifest, slides } = await ingest(cfg)
  const sources = chunks.map((c) => c.source).join('\n')
  // skipped
  assert.ok(manifest.skipped.some((s) => s.path.endsWith('.git')))
  assert.ok(manifest.skipped.some((s) => s.path.endsWith('node_modules')))
  assert.ok(manifest.skipped.some((s) => s.path.endsWith('venv')))
  assert.ok(manifest.skipped.some((s) => s.path.endsWith('package-lock.json')))
  assert.ok(!sources.includes('node_modules'))
  // raw data inventoried, not read
  const raw = manifest.rawData.map((g) => `${g.folder}:${Object.keys(g.exts).join(',')}:${g.count}`)
  assert.ok(raw.some((r) => r.endsWith('sample01:.dcm:12')), raw.join(' | '))
  assert.ok(raw.some((r) => r.includes('.aim')))
  assert.ok(raw.some((r) => r.includes('.bin2')), 'files over 2 MB go to the inventory')
  assert.ok(chunks.some((c) => c.kind === 'data' && /12 files/.test(c.text)))
  // formats
  assert.ok(sources.includes('lab notebook.docx') || sources.includes('lab_notebook.docx'))
  assert.match(chunks.find((c) => c.source.includes('lab_notebook.docx'))!.text, /Dice score of 0\.91/)
  assert.match(chunks.find((c) => c.source.includes('background_paper.pdf'))!.text, /C3D4/)
  assert.match(chunks.find((c) => c.source.includes('old_notes_utf16'))!.text, /rigid ICP/)
  assert.match(chunks.find((c) => c.kind === 'notebook')!.text, /Wall time: 5min 52s/)
  assert.match(chunks.find((c) => c.source.includes('per_slice.csv'))!.text, /2048 data rows total/)
  assert.equal(slides.length, 5)
  assert.equal(slides[2].title, 'Segmentation')
  assert.match(slides[2].notes, /beam hardening/)
  // chats: 4 relevant kept, cookie recipe + history essay dropped; tool output and diffs removed
  assert.equal(manifest.chats.filter((c) => c.kept).length, 4)
  const chat = chunks.filter((c) => c.kind === 'chat').map((c) => c.text).join('\n')
  assert.match(chat, /MITHUN \(user\): That worked, I decided to keep memmap/)
  assert.doesNotMatch(chat, /300 lines of output|system-reminder|cookie|Rome/i)
  assert.match(chat, /\[diff omitted/)
  assert.ok(chunks.every((c) => c.source && c.tokens > 0), 'every chunk is tagged')
})

test('cleanChatText drops diffs, long code and harness noise but keeps short snippets', () => {
  const long = '```python\n' + Array.from({ length: 30 }, (_, i) => `x = ${i}`).join('\n') + '\n```'
  const out = cleanChatText(`<system-reminder>x</system-reminder>Use this:\n\`\`\`python\nnp.memmap(p)\n\`\`\`\n${long}\n\`\`\`diff\n-a\n+b\n\`\`\``)
  assert.match(out, /np\.memmap\(p\)/)
  assert.match(out, /\[python block omitted: 31 lines\]/)
  assert.match(out, /\[diff omitted/)
  assert.doesNotMatch(out, /system-reminder/)
})

test('isRelevant: repo cwd, renamed checkout, keywords', () => {
  const s = (cwd: string | undefined, text: string) => ({ origin: 'codex' as const, id: 'x', title: 't', file: 'f', cwd, messages: [{ role: 'user' as const, text }] })
  assert.ok(isRelevant(s('C:\\Users\\M\\code\\scale-microct\\src', 'hi'), ['C:\\Users\\M\\code\\scale-microct'], []).keep)
  assert.ok(isRelevant(s('D:\\backup\\scale-microct', 'hi'), ['C:\\Users\\M\\code\\scale-microct'], []).keep)
  assert.ok(isRelevant(s(undefined, 'DICOM voxel spacing question'), [], ['DICOM', 'voxel']).keep)
  assert.ok(!isRelevant(s(undefined, 'cookie recipe'), [], ['DICOM', 'voxel']).keep)
})

test('office extractors: slide order, notes, docx headings and lists', async () => {
  const slides = await pptxSlides(path.join(FIX, 'progress_update.pptx'))
  assert.deepEqual(
    slides.map((s) => s.index + ':' + s.title),
    ['1:microCT Pipeline Progress (FAKE)', '2:Pipeline overview', '3:Segmentation', '4:Compression states', '5:Next steps: Abaqus FEM']
  )
  const text = await docxText(path.join(FIX, 'lab notes', 'lab_notebook.docx'))
  assert.match(text, /^# Lab notebook/m)
  assert.match(text, /^## TD-309 compression/m)
  assert.match(text, /^- The TD-309 device was set up by the lab/m)
})

test('decode handles UTF-16 LE/BE and UTF-8 BOM', () => {
  assert.equal(decode(Buffer.from('\ufeffhé', 'utf8')), 'hé')
  assert.equal(decode(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('hé', 'utf16le')])), 'hé')
  const be = Buffer.from('hé', 'utf16le')
  be.swap16()
  assert.equal(decode(Buffer.concat([Buffer.from([0xfe, 0xff]), be])), 'hé')
})

test('outline keeps signatures, docstrings, comments; splitLines tracks line ranges', () => {
  const src = 'import numpy as np\nTHRESH = 3\n\ndef f(x):\n    """Doc line."""\n    y = x + 1\n    z = y * 2\n    return z\n# note\n'
  const o = outline(src)
  assert.match(o, /def f\(x\):/)
  assert.match(o, /Doc line/)
  assert.match(o, /THRESH = 3/)
  assert.match(o, /# note/)
  assert.doesNotMatch(o, /y = x \+ 1/)
  const parts = splitLines(Array.from({ length: 2000 }, (_, i) => `line ${i} with some words`).join('\n'), 300)
  assert.ok(parts.length > 3)
  assert.equal(parts[0].start, 1)
  assert.equal(parts[1].start, parts[0].end + 1)
})

const chunk = (id: string, source: string, text: string, kind: Chunk['kind'] = 'doc'): Chunk => ({ id, source, path: '', kind, text, tokens: Math.ceil(text.length / 4) })

test('tokenize + BM25 + Q&A matching', () => {
  assert.ok(tokenize('loadDicomStack segment_volume').includes('dicom'))
  assert.ok(tokenize('segment_volume').includes('volume'))
  const docs = [chunk('a', 'a.md', 'Otsu thresholding per slice because of beam hardening'), chunk('b', 'b.md', 'memory mapped loading with np.memmap'), chunk('c', 'c.md', 'cookie recipe')]
  const bm = new Bm25(docs, (c) => c.text)
  assert.equal(bm.search('why otsu threshold')[0].item.id, 'a')
  assert.equal(bm.search('how do you load big scans memmap')[0].item.id, 'b')
  const bank: QaEntry[] = [
    { question: 'Why did you use Otsu thresholding?', category: 'why-not', lead: 'Beam hardening.', bullets: ['b [src: a.md]'], deeper: '', sources: ['a.md'], verified: true },
    { question: 'How do you load large volumes?', category: 'technical', lead: 'memmap', bullets: [], deeper: '', sources: [], verified: true }
  ]
  assert.equal(matchQa('why use otsu thresholding?', bank)!.entry, bank[0])
  assert.ok(matchQa('what is your favourite colour', bank)!.confidence < 0.3)
  assert.doesNotMatch(renderQaCard(bank[0]), /\[src:/)
  assert.match(renderQaCard(bank[0]), /\[sources: a\.md\]/)
})

test('quickNotes returns relevant lines only', () => {
  const docs = [chunk('a', 'seg.py', 'SIGMA = 1.0 # Gaussian smoothing before thresholding\nunrelated filler text about other things'), chunk('b', 'notes.md', 'The TD-309 device was set up by the lab (not me).')]
  const notes = quickNotes('Who set up the TD-309 device?', docs)
  assert.ok(notes && /set up by the lab/.test(notes.text))
  assert.equal(quickNotes('Could you share your screen?', docs), null)
})

test('checkCitations drops unknown sources and unverifies answers left without any', () => {
  const chunks = [chunk('a', 'repo/src/a.py:1-40', 'x'), chunk('b', 'chat:codex/2026-09-20/cdx1', 'y', 'chat')]
  const { entries, dropped } = checkCitations(
    [
      { question: 'q1', category: 'technical', lead: 'l', bullets: [], deeper: '', sources: ['[src: repo/src/a.py:1-40]', 'made/up.py'], verified: true },
      { question: 'q2', category: 'technical', lead: 'l', bullets: [], deeper: '', sources: ['ghost.md'], verified: true },
      { question: 'q3', category: 'technical', lead: 'l', bullets: [], deeper: '', sources: ['chat:codex/2026-09-20/cdx1 (2026-09-20)'], verified: true }
    ],
    chunks
  )
  assert.equal(dropped, 2)
  assert.deepEqual(entries[0].sources, ['repo/src/a.py:1-40'])
  assert.equal(entries[1].verified, false)
  assert.equal(entries[2].verified, true)
})

test('selectDigest respects the token budget and keeps every kind represented', () => {
  const cfg = structuredClone(DEFAULT_CONFIG)
  const chunks = [
    ...Array.from({ length: 50 }, (_, i) => chunk(`c${i}`, `code${i}.py`, 'def f(): pass '.repeat(80), 'code')),
    ...Array.from({ length: 20 }, (_, i) => chunk(`h${i}`, `chat${i}`, 'I decided to use memmap '.repeat(40), 'chat')),
    chunk('d', 'deck slide 1', 'Pipeline overview', 'deck')
  ]
  const picked = selectDigest(chunks, cfg, 3000)
  const used = picked.reduce((t, c) => t + c.tokens, 0)
  assert.ok(used <= 3000, `used ${used}`)
  assert.ok(picked.some((c) => c.kind === 'deck'))
  assert.ok(picked.some((c) => c.kind === 'chat'))
  assert.ok(picked.some((c) => c.kind === 'code'))
})

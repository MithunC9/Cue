// npm run prep: build knowledge\ from the sources in config.yaml (run it the night before).
//
//   npm run prep                  everything
//   npm run prep -- --no-llm      only extract + index (no API calls); shows the token count
//   npm run prep -- --only=qa     regenerate one output (brief | qa | gaps | slides | embed)
//   npm run prep -- --force       regenerate outputs that already exist
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { ConfigError, loadConfig } from '../main/config'
import { Gemini } from '../main/gemini/client'
import { EMBED_DIMS, embedTexts } from '../main/gemini/embed'
import { AllModelsExhaustedError, parseApiError } from '../main/gemini/quota'
import { FILES, writeChunks, writeEmbeddings, type SlidePrep } from '../main/knowledge'
import { addSecret, redact } from '../main/log'
import { cleanSource, type QaEntry } from '../main/retrieval'
import { checkCitations, digestText, makeBrief, makeGaps, makeQaBank, makeSlidePrep, renderQaMarkdown, selectDigest } from './brief'
import { apiKey, userDataDir } from './env'
import { ingest, type Manifest } from './ingest'

const args = process.argv.slice(2)
const flag = (name: string) => args.includes(`--${name}`)
const only = args.find((a) => a.startsWith('--only='))?.slice(7).split(',') ?? null
const want = (step: string) => !only || only.includes(step)
/** When run from the app (Electron utility process) progress also goes over the message port. */
const port = (process as unknown as { parentPort?: { postMessage: (m: unknown) => void } }).parentPort
const say = (s: string) => {
  const line = redact(s)
  console.log(line)
  port?.postMessage({ line })
}

async function main(): Promise<void> {
  const root = process.env.CUE_HOME ? path.resolve(process.env.CUE_HOME) : process.cwd()
  const { config: cfg } = loadConfig(root)
  const out = path.join(root, 'knowledge')
  mkdirSync(out, { recursive: true })
  const write = (name: string, data: string) => writeFileSync(path.join(out, name), data)
  const t0 = Date.now()

  const configured = [...cfg.sources.repos, ...cfg.sources.docs, cfg.sources.deck, cfg.sources.claude_code, ...cfg.sources.chat_exports].filter(Boolean)
  if (!configured.length) {
    say('No sources configured. Edit config.yaml → sources (repos, docs, deck, claude_code), then run npm run prep again.')
    process.exitCode = 1
    return
  }

  say('▸ Reading sources…')
  const free = cfg.gemini.tier === 'free'
  const { chunks, manifest, slides, log } = await ingest(cfg)
  for (const l of log) say('  ' + l)
  for (const m of manifest.missing) say(`  ⚠ not found: ${m}`)
  writeChunks(out, chunks)
  write(FILES.manifest, JSON.stringify(manifest, null, 2))
  write(FILES.slides, JSON.stringify(slides, null, 2))
  writeCorpusFiles(out, chunks)

  const kept = manifest.chats.filter((c) => c.kept).length
  say(`  ${manifest.totals.files} files · ${manifest.rawData.reduce((n, g) => n + g.count, 0)} raw-data files inventoried · ${kept}/${manifest.chats.length} chat sessions kept · ${slides.length} slides`)
  say(`  Total ≈ ${manifest.totals.tokens.toLocaleString()} tokens  (${Object.entries(manifest.totals.byKind).map(([k, v]) => `${k} ${v.toLocaleString()}`).join(' · ')})`)
  const fitsCache = manifest.totals.tokens <= 700_000
  say(
    free
      ? '  Free tier: no explicit context cache; Cue retrieves the relevant chunks per question (local search' + (flag('no-embed') ? ')' : ' + embeddings)')
      : fitsCache
        ? '  Paid tier: corpus fits in one explicit context cache; the app creates it at start.'
        : '  Paid tier: corpus is over ~700k tokens, so Cue retrieves chunks per question instead of caching everything.'
  )
  if (!chunks.length) {
    say('Nothing to learn from yet. Check the paths in config.yaml.')
    process.exitCode = 1
    return
  }
  if (flag('no-llm')) {
    say(`✓ Indexed (no API calls). knowledge\\ written in ${((Date.now() - t0) / 1000).toFixed(1)} s.`)
    return
  }

  const key = apiKey(root)
  if (!key) {
    say('No GEMINI_API_KEY in .env or the environment. Add it, or run with --no-llm.')
    process.exitCode = 1
    return
  }
  addSecret(key)
  const gem = new Gemini(key, cfg, path.join(userDataDir(), 'quota.json'))
  const budget = free ? 110_000 : 600_000
  const digestChunks = selectDigest(chunks, cfg, budget)
  const digest = digestText(digestChunks)
  say(`▸ Prep digest: ${digestChunks.length} chunks, ≈${digestChunks.reduce((t, c) => t + c.tokens, 0).toLocaleString()} tokens sent per prep call`)
  const have = (f: string) => existsSync(path.join(out, f)) && !flag('force') && !only

  // 1. brief.md
  let brief = existsSync(path.join(out, FILES.brief)) ? readFileSync(path.join(out, FILES.brief), 'utf8') : ''
  if (want('brief') && !have(FILES.brief)) {
    say('▸ Writing brief.md (high thinking; can take a minute)…')
    const r = await makeBrief(gem, cfg, digest, manifest, () => {})
    brief = r.text
    write(FILES.brief, `${brief}\n\n<!-- generated ${new Date().toISOString()} by ${r.model} from ${digestChunks.length} chunks -->\n`)
    say(`  ✓ brief.md (${r.model})`)
  }

  // 2. qa_bank.md + qa.json
  let qa: QaEntry[] = existsSync(path.join(out, FILES.qaJson)) ? (JSON.parse(readFileSync(path.join(out, FILES.qaJson), 'utf8')) as QaEntry[]) : []
  if (want('qa') && !have(FILES.qaJson)) {
    say('▸ Writing qa_bank.md (~40 questions)…')
    const r = await makeQaBank(gem, cfg, digest, brief)
    const checked = checkCitations(r.entries, chunks)
    qa = checked.entries
    write(FILES.qaJson, JSON.stringify(qa, null, 2))
    write(FILES.qaMd, renderQaMarkdown(qa, cfg))
    say(`  ✓ ${qa.length} questions, ${qa.filter((e) => !e.verified).length} ⚠️ unverified${checked.dropped ? `, ${checked.dropped} bad citations removed` : ''} (${r.model})`)
  }

  // 3. gaps.md
  if (want('gaps') && !have(FILES.gaps)) {
    say('▸ Writing gaps.md…')
    const small = digestText(selectDigest(chunks, cfg, Math.round(budget * 0.6)))
    const r = await makeGaps(gem, cfg, small, brief, qa, manifest)
    write(FILES.gaps, `${r.text}\n\n<!-- generated ${new Date().toISOString()} by ${r.model} -->\n`)
    say(`  ✓ gaps.md (${r.model})`)
  }

  // 4. per-slide talking points
  if (slides.length && want('slides') && !have(FILES.slidePrep)) {
    say(`▸ Preparing talking points for ${slides.length} slides…`)
    const small = digestText(selectDigest(chunks, cfg, Math.round(budget * 0.5)))
    const r = await makeSlidePrep(gem, cfg, slides, brief, qa, small)
    const items: SlidePrep[] = r.items
      .filter((s) => slides.some((x) => x.index === s.index))
      .map((s) => ({ ...s, sources: [...new Set((s.sources ?? []).map(cleanSource))] }))
    write(FILES.slidePrep, JSON.stringify(items, null, 2))
    say(`  ✓ ${items.length} slides (${r.model})`)
  }

  // 5. embeddings (optional; makes paraphrased questions find the right notes)
  if (want('embed') && !flag('no-embed') && (!existsSync(path.join(out, FILES.embeddingsMeta)) || flag('force') || only)) {
    const batches = Math.ceil(chunks.length / 100) + Math.ceil(qa.length / 100)
    if (chunks.length > 5000) say(`▸ Skipping embeddings: ${chunks.length} chunks is too many for the free tier. Local keyword search still works.`)
    else {
      say(`▸ Embedding ${chunks.length} chunks + ${qa.length} prepared questions (${batches} request${batches > 1 ? 's' : ''})…`)
      try {
        const vectors: Float32Array[] = []
        for (let i = 0; i < chunks.length; i += 100) {
          vectors.push(...(await embedTexts(gem, chunks.slice(i, i + 100).map((c) => `${c.source}\n${c.text}`), 'RETRIEVAL_DOCUMENT')))
        }
        // Prepared questions are embedded as queries so a live question can match them by meaning.
        const qaVectors: Float32Array[] = []
        for (let i = 0; i < qa.length; i += 100) qaVectors.push(...(await embedTexts(gem, qa.slice(i, i + 100).map((e) => e.question), 'RETRIEVAL_QUERY')))
        writeEmbeddings(out, {
          model: cfg.gemini.models.embed,
          dims: EMBED_DIMS,
          ids: [...chunks.map((c) => c.id), ...qa.map((_, i) => `qa:${i}`)],
          vectors: [...vectors, ...qaVectors]
        })
        say('  ✓ embeddings')
      } catch (err) {
        say(`  ⚠ embeddings skipped (${parseApiError(err).message.slice(0, 120)}). Local keyword search still works.`)
      }
    }
  }

  const q = gem.usage()
  const seen = new Set<string>()
  const usage = [...q.brain, ...q.fast].filter((u) => !seen.has(u.model) && seen.add(u.model) && u.usedToday > 0)
  say(`✓ Done in ${((Date.now() - t0) / 1000).toFixed(0)} s. Requests used today: ${usage.map((u) => `${u.model} ${u.usedToday}/${u.rpd}`).join(' · ') || 'none'}`)
  say(`  Read knowledge\\brief.md, qa_bank.md and gaps.md before the meeting.`)
}

function writeCorpusFiles(out: string, chunks: { kind: string; source: string; text: string }[]): void {
  const dir = path.join(out, 'corpus')
  mkdirSync(dir, { recursive: true })
  const byKind = new Map<string, string[]>()
  for (const c of chunks) byKind.set(c.kind, [...(byKind.get(c.kind) ?? []), `### SOURCE: ${c.source}\n${c.text}`])
  for (const [kind, parts] of byKind) writeFileSync(path.join(dir, `${kind}.md`), parts.join('\n\n') + '\n')
}

main()
  .catch((err) => {
    if (err instanceof ConfigError) say(`⚠ ${err.message}`)
    else if (err instanceof AllModelsExhaustedError) say(`⚠ Out of free-tier budget: ${err.details.join('; ')}. Run prep again after the limits reset (midnight Pacific for daily limits).`)
    else say(`⚠ Prep failed: ${parseApiError(err).message}`)
    process.exitCode = 1
  })
  // pdf.js can leave handles open; don't hang around once the work is done.
  .finally(() => {
    // pdf.js can leave handles open inside the app's utility process; exit once the work is done.
    if (port) setTimeout(() => process.exit(typeof process.exitCode === 'number' ? process.exitCode : 0), 300)
  })

export type { Manifest }

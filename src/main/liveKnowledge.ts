// KnowledgeProvider for the running app: loads knowledge\ (and reloads it after `npm run prep`),
// retrieves per question, matches prepared answers, and manages the paid-tier cache.
import { existsSync, statSync, watch, type FSWatcher } from 'node:fs'
import path from 'node:path'
import type { Instant, KnowledgeProvider } from './answers'
import type { CueConfig } from './config'
import type { MeetingContext } from './context'
import { ensureCache, type CacheInfo } from './gemini/cache'
import type { Gemini } from './gemini/client'
import { embedTexts } from './gemini/embed'
import { FILES, KnowledgeBase } from './knowledge'
import { log } from './log'
import { renderQaCard } from './retrieval'

/** Cosine similarity above which two questions mean the same thing (gemini-embedding-001, 768 dims). */
export const SEMANTIC_MIN = 0.8

const timeout = <T>(ms: number, value: T) => new Promise<T>((r) => setTimeout(() => r(value), ms))

export class LiveKnowledge implements KnowledgeProvider {
  kb: KnowledgeBase | null = null
  private cacheInfo: CacheInfo | null = null
  private watcher: FSWatcher | null = null
  private reloadTimer: NodeJS.Timeout | null = null

  constructor(
    private dir: string,
    private gem: () => Gemini | null,
    private cfg: () => CueConfig,
    private ctx: MeetingContext,
    private onChange: () => void
  ) {}

  load(): void {
    try {
      this.kb = KnowledgeBase.exists(this.dir) ? new KnowledgeBase(this.dir) : null
      if (this.kb) log.info(`knowledge loaded: ${this.info()}`)
    } catch (err) {
      log.error('knowledge load failed', err)
      this.kb = null
    }
    this.cacheInfo = null
    void this.refreshCache()
    this.onChange()
  }

  /** Reload automatically when prep rewrites manifest.json. */
  watch(): void {
    if (this.watcher || !existsSync(this.dir)) return
    try {
      this.watcher = watch(this.dir, (_e, file) => {
        if (file !== FILES.manifest && file !== FILES.qaJson && file !== FILES.brief) return
        if (this.reloadTimer) clearTimeout(this.reloadTimer)
        this.reloadTimer = setTimeout(() => this.load(), 1500)
      })
    } catch (err) {
      log.warn('cannot watch knowledge folder', err)
    }
  }

  async refreshCache(): Promise<void> {
    const gem = this.gem()
    if (!gem || !this.kb || this.cfg().gemini.tier !== 'paid') return
    try {
      this.cacheInfo = await ensureCache(gem, this.cfg(), this.kb)
      if (this.cacheInfo) log.info(`context cache ready: ${this.cacheInfo.name} until ${this.cacheInfo.expireTime}`)
    } catch (err) {
      log.warn('context cache unavailable; using retrieval', err)
    }
  }

  info(): string {
    if (!this.kb || this.kb.empty) return ''
    const stamp = existsSync(path.join(this.dir, FILES.manifest)) ? statSync(path.join(this.dir, FILES.manifest)).mtime : null
    const age = stamp ? Math.round((Date.now() - stamp.getTime()) / 3600_000) : null
    return `${this.kb.chunks.length} chunks · ${this.kb.qa.length} Q&As${this.kb.slides.length ? ` · ${this.kb.slides.length} slides` : ''}${age !== null && age >= 24 ? ` · prep ${Math.round(age / 24)}d old` : ''}`
  }

  async forQuestion(question: string, signal: AbortSignal): Promise<{ context: string | null; instant: Instant | null }> {
    const kb = this.kb
    if (!kb || kb.empty) return { context: null, instant: null }
    const cfg = this.cfg()
    const gem = this.gem()
    let vec: Float32Array | null = null
    if (cfg.knowledge.embeddings && kb.embeddings && gem) {
      // Never let the embedding call slow the answer down by more than ~0.9 s.
      vec = await Promise.race([
        embedTexts(gem, [question], 'RETRIEVAL_QUERY', signal)
          .then((v) => v[0])
          .catch((err) => {
            log.warn('query embedding failed; keyword search only', String(err).slice(0, 120))
            return null
          }),
        timeout(900, null)
      ])
    }
    const context = kb.contextFor(question, cfg.knowledge.live_context_tokens, vec, this.ctx.currentSlide?.index).text
    const sem = vec ? kb.semanticQa(vec, SEMANTIC_MIN) : null
    const instant: Instant | null = sem ? { text: renderQaCard(sem.entry), matched: sem.entry.question, confidence: sem.confidence, source: 'qa' } : null
    return { context, instant }
  }

  instant(question: string): Instant | null {
    const kb = this.kb
    if (!kb || kb.empty) return null
    const m = kb.instantAnswer(question, this.cfg().knowledge.instant_min_confidence)
    if (m) return { text: renderQaCard(m.entry), matched: m.entry.question, confidence: m.confidence, source: 'qa' }
    const notes = kb.notesFor(question)
    return notes ? { text: notes.text, matched: notes.sources.join(', '), confidence: 0, source: 'notes' } : null
  }

  cache() {
    const c = this.cacheInfo
    if (!c || c.model !== this.cfg().gemini.models.brain || Date.parse(c.expireTime) < Date.now() + 60_000) return null
    return { model: c.model, name: c.name }
  }
}

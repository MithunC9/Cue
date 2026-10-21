// Paid tier only: one explicit context cache with the system prompt + the whole knowledge corpus.
// Free keys have a cache storage limit of 0 (verified Oct 2026), so on the free tier Cue retrieves
// relevant chunks per question instead.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { CueConfig } from '../config'
import { FILES, type KnowledgeBase } from '../knowledge'
import type { Gemini } from './client'
import { liveSystemPrompt } from './prompts'

export interface CacheInfo {
  name: string
  model: string
  expireTime: string
  knowledgeStamp: number
}

export const CACHE_MAX_TOKENS = 700_000

export function readCache(dir: string): CacheInfo | null {
  const f = path.join(dir, FILES.cache)
  if (!existsSync(f)) return null
  try {
    return JSON.parse(readFileSync(f, 'utf8')) as CacheInfo
  } catch {
    return null
  }
}

/** Returns a usable cache, creating one if the tier is paid and the corpus fits. */
export async function ensureCache(gem: Gemini, cfg: CueConfig, kb: KnowledgeBase, ttlHours = 4): Promise<CacheInfo | null> {
  if (cfg.gemini.tier !== 'paid') return null
  const tokens = kb.chunks.reduce((t, c) => t + c.tokens, 0)
  if (!tokens || tokens > CACHE_MAX_TOKENS) return null
  const model = cfg.gemini.models.brain
  const existing = readCache(kb.dir)
  if (existing && existing.model === model && existing.knowledgeStamp === kb.loadedStamp && Date.parse(existing.expireTime) - Date.now() > 20 * 60_000) return existing
  const corpus = [kb.brief && `### SOURCE: brief.md\n${kb.brief}`, ...kb.chunks.map((c) => `### SOURCE: ${c.source}\n${c.text}`)].filter(Boolean).join('\n\n')
  const c = await gem.ai.caches.create({
    model,
    config: {
      displayName: 'cue-knowledge',
      systemInstruction: liveSystemPrompt(cfg),
      contents: [{ role: 'user', parts: [{ text: `KNOWLEDGE (each chunk is tagged with its source path):\n${corpus}` }] }],
      ttl: `${ttlHours * 3600}s`
    }
  })
  const info: CacheInfo = { name: c.name!, model, expireTime: c.expireTime ?? new Date(Date.now() + ttlHours * 3600_000).toISOString(), knowledgeStamp: kb.loadedStamp }
  writeFileSync(path.join(kb.dir, FILES.cache), JSON.stringify(info, null, 2))
  return info
}

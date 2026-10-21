// Embeddings (optional): batch-embed chunks at prep time, one small query embedding per live question.
import type { Gemini } from './client'
import { withFallback } from './quota'

export const EMBED_DIMS = 768

export async function embedTexts(
  gem: Gemini,
  texts: string[],
  taskType: 'RETRIEVAL_DOCUMENT' | 'RETRIEVAL_QUERY',
  signal?: AbortSignal
): Promise<Float32Array[]> {
  const model = gem.config.gemini.models.embed
  const { value } = await withFallback(
    gem.quota,
    [model],
    (m) =>
      gem.ai.models.embedContent({
        model: m,
        // ~2,000-token input limit per text; trim long chunks.
        contents: texts.map((t) => t.slice(0, 7000)),
        config: { taskType, outputDimensionality: EMBED_DIMS, abortSignal: signal }
      }),
    { maxWaitMs: taskType === 'RETRIEVAL_QUERY' ? 0 : 65_000, signal, retrySameMs: taskType === 'RETRIEVAL_QUERY' ? 0 : 90_000 }
  )
  const out = (value.embeddings ?? []).map((e) => Float32Array.from(e.values ?? []))
  if (out.length !== texts.length) throw new Error(`embedding count mismatch: ${out.length} vs ${texts.length}`)
  return out
}

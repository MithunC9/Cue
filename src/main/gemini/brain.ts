// BRAIN: streamed answers (live, low thinking) and prep documents (high thinking).
import type { Content, GenerateContentResponse } from '@google/genai'
import { ThinkingLevel as SdkThinking } from '@google/genai'
import type { ThinkingLevel } from '../config'
import type { Gemini } from './client'
import { parseApiError, withFallback } from './quota'

const LEVELS: Record<ThinkingLevel, SdkThinking> = {
  minimal: SdkThinking.MINIMAL,
  low: SdkThinking.LOW,
  medium: SdkThinking.MEDIUM,
  high: SdkThinking.HIGH
}

export interface StreamRequest {
  system: string
  contents: Content[]
  thinking: ThinkingLevel
  chain: string[]
  signal: AbortSignal
  /** How long to wait for a per-minute slot before trying the next model. */
  maxWaitMs: number
  /** Prep: wait out a short per-minute 429 on the same model instead of falling back. */
  retrySameMs?: number
  onSkip?: (message: string) => void
  /**
   * Live answers: give up on a model that hasn't produced its first token after this long and try the
   * next one (free-tier queues can stall for 40 s+ on one model while another answers in 7 s).
   * The last model in the chain always gets unlimited time.
   */
  firstTokenTimeoutMs?: number
  /** Paid tier: an explicit cache holding the system prompt + knowledge, valid for one model. */
  cache?: { model: string; name: string; contents: Content[] }
  onText?: (fullText: string) => void
}

export interface StreamResult {
  model: string
  text: string
  firstTokenMs: number
  totalMs: number
  inputTokens: number
  outputTokens: number
}

/** Models that rejected thinkingLevel once; we stop sending it to them. */
const noThinking = new Set<string>()

function requestFor(model: string, req: Pick<StreamRequest, 'system' | 'contents' | 'thinking' | 'signal' | 'cache'>) {
  const cached = req.cache && req.cache.model === model
  const config = {
    // With an explicit cache the system prompt lives in the cache.
    ...(cached ? { cachedContent: req.cache!.name } : { systemInstruction: req.system }),
    abortSignal: req.signal,
    ...(noThinking.has(model) ? {} : { thinkingConfig: { thinkingLevel: LEVELS[req.thinking] } })
  }
  return { model, contents: cached ? req.cache!.contents : req.contents, config }
}

export class FirstTokenTimeout extends Error {}

async function open(gem: Gemini, model: string, req: StreamRequest, timeoutMs: number) {
  // Per-attempt abort so a stalled model can be abandoned without cancelling the whole answer.
  const attempt = new AbortController()
  const onOuter = () => attempt.abort(req.signal.reason)
  req.signal.addEventListener('abort', onOuter, { once: true })
  let timer: NodeJS.Timeout | undefined
  try {
    const stream = await gem.ai.models.generateContentStream(requestFor(model, { ...req, signal: attempt.signal }))
    const it = stream[Symbol.asyncIterator]()
    // Pull the first chunk here so quota/overload errors (and stalls) surface inside withFallback.
    const firstChunk = it.next()
    const first = timeoutMs
      ? await Promise.race([
          firstChunk,
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              attempt.abort(new FirstTokenTimeout('first token timeout'))
              reject(new FirstTokenTimeout(`no first token after ${Math.round(timeoutMs / 1000)} s`))
            }, timeoutMs)
          })
        ])
      : await firstChunk
    return { it, first }
  } catch (err) {
    if (err instanceof FirstTokenTimeout) throw err
    const e = parseApiError(err)
    if (e.status === 400 && /thinking/i.test(e.message) && !noThinking.has(model)) {
      noThinking.add(model)
      return open(gem, model, req, timeoutMs)
    }
    throw err
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export async function streamBrain(gem: Gemini, req: StreamRequest): Promise<StreamResult> {
  const t0 = performance.now()
  const chain = [...new Set(req.chain)]
  const lastModel = chain[chain.length - 1]
  const { model, value } = await withFallback(gem.quota, chain, (m) => open(gem, m, req, m === lastModel ? 0 : (req.firstTokenTimeoutMs ?? 0)), {
    maxWaitMs: req.maxWaitMs,
    signal: req.signal,
    retrySameMs: req.retrySameMs,
    onSkip: req.onSkip
  })
  let firstTokenMs = -1
  let text = ''
  let last: GenerateContentResponse | undefined
  const take = (chunk: GenerateContentResponse) => {
    last = chunk
    const piece = chunk.text ?? ''
    if (!piece) return
    if (firstTokenMs < 0) firstTokenMs = performance.now() - t0
    text += piece
    req.onText?.(text)
  }
  if (!value.first.done) take(value.first.value)
  for (;;) {
    const r = await value.it.next()
    if (r.done) break
    take(r.value)
  }
  const u = last?.usageMetadata
  const inputTokens = u?.promptTokenCount ?? 0
  const outputTokens = (u?.candidatesTokenCount ?? 0) + (u?.thoughtsTokenCount ?? 0)
  gem.addUsage(model, inputTokens, outputTokens)
  return {
    model,
    text,
    firstTokenMs: firstTokenMs < 0 ? performance.now() - t0 : firstTokenMs,
    totalMs: performance.now() - t0,
    inputTokens,
    outputTokens
  }
}

export interface JsonRequest {
  system: string
  contents: Content[]
  /** JSON Schema for the response. */
  schema: Record<string, unknown>
  thinking: ThinkingLevel
  chain: string[]
  signal?: AbortSignal
  maxWaitMs: number
  retrySameMs?: number
  onSkip?: (message: string) => void
}

/** Non-streamed call that returns parsed JSON matching `schema` (structured output). */
export async function generateJson<T>(gem: Gemini, req: JsonRequest): Promise<{ model: string; value: T; inputTokens: number; outputTokens: number }> {
  const signal = req.signal ?? new AbortController().signal
  const call = async (model: string) => {
    const base = requestFor(model, { ...req, signal })
    const config = { ...base.config, responseMimeType: 'application/json', responseJsonSchema: req.schema }
    try {
      return await gem.ai.models.generateContent({ model, contents: req.contents, config })
    } catch (err) {
      const e = parseApiError(err)
      if (e.status === 400 && /thinking/i.test(e.message) && !noThinking.has(model)) {
        noThinking.add(model)
        return gem.ai.models.generateContent({ model, contents: req.contents, config: { ...config, thinkingConfig: undefined } })
      }
      throw err
    }
  }
  const { model, value: res } = await withFallback(gem.quota, req.chain, call, {
    maxWaitMs: req.maxWaitMs,
    signal,
    retrySameMs: req.retrySameMs,
    onSkip: req.onSkip
  })
  const text = (res.text ?? '').trim().replace(/^```(?:json)?\s*|\s*```$/g, '')
  const u = res.usageMetadata
  const inputTokens = u?.promptTokenCount ?? 0
  const outputTokens = (u?.candidatesTokenCount ?? 0) + (u?.thoughtsTokenCount ?? 0)
  gem.addUsage(model, inputTokens, outputTokens)
  return { model, value: JSON.parse(text) as T, inputTokens, outputTokens }
}

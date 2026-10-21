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

async function open(gem: Gemini, model: string, req: StreamRequest) {
  const config = {
    systemInstruction: req.system,
    abortSignal: req.signal,
    ...(noThinking.has(model) ? {} : { thinkingConfig: { thinkingLevel: LEVELS[req.thinking] } })
  }
  try {
    const stream = await gem.ai.models.generateContentStream({ model, contents: req.contents, config })
    const it = stream[Symbol.asyncIterator]()
    // Pull the first chunk here so quota/overload errors surface inside withFallback.
    const first = await it.next()
    return { it, first }
  } catch (err) {
    const e = parseApiError(err)
    if (e.status === 400 && /thinking/i.test(e.message) && !noThinking.has(model)) {
      noThinking.add(model)
      return open(gem, model, req)
    }
    throw err
  }
}

export async function streamBrain(gem: Gemini, req: StreamRequest): Promise<StreamResult> {
  const t0 = performance.now()
  const { model, value } = await withFallback(gem.quota, req.chain, (m) => open(gem, m, req), {
    maxWaitMs: req.maxWaitMs,
    signal: req.signal
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

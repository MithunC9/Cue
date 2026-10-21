// Turns a trigger (typed question, hotkey, screenshot, auto-detected question) into one streamed card.
// A new trigger cancels the card in flight, so one question gives one card.
import type { Content, Part } from '@google/genai'
import type { AnswerEvent, AnswerTrigger } from '../shared/types'
import type { CueConfig } from './config'
import type { MeetingContext } from './context'
import { streamBrain } from './gemini/brain'
import type { Gemini } from './gemini/client'
import { knowledgeBlock, liveSystemPrompt } from './gemini/prompts'
import { AllModelsExhaustedError, parseApiError } from './gemini/quota'
import { log } from './log'

export interface AskInput {
  trigger: AnswerTrigger
  question?: string
  image?: { data: Buffer; mimeType: string }
}

export interface Instant {
  text: string
  matched: string
  confidence: number
  source: 'qa' | 'notes'
}

export interface KnowledgeProvider {
  /**
   * Notes for this question (brief + retrieved chunks; null when prep hasn't run), plus a prepared
   * answer found by meaning (embeddings) if the instant word match missed it.
   */
  forQuestion(question: string, signal: AbortSignal): Promise<{ context: string | null; instant: Instant | null }>
  /** Immediate card: a prepared qa_bank answer that clearly matches, else the best lines from your notes. */
  instant(question: string): Instant | null
  /** Paid tier: explicit cache for the BRAIN model (system prompt + all knowledge inside). */
  cache(): { model: string; name: string } | null
}

export interface AnswerRecord {
  id: number
  trigger: AnswerTrigger
  question: string
  text: string
  model: string
  firstTokenMs: number
  prepared: boolean
  error?: string
  at: number
}

export class AnswerEngine {
  private seq = 0
  private inflight: AbortController | null = null
  lastLatencyMs: number | null = null

  constructor(
    private gem: () => Gemini | null,
    private cfg: () => CueConfig,
    private ctx: MeetingContext,
    private knowledge: KnowledgeProvider,
    private emit: (e: AnswerEvent) => void,
    private onUsage: () => void,
    private onRecord: (r: AnswerRecord) => void = () => {}
  ) {}

  cancel(): void {
    this.inflight?.abort(new Error('superseded'))
    this.inflight = null
  }

  async ask(input: AskInput): Promise<void> {
    this.cancel()
    const id = ++this.seq
    const ac = new AbortController()
    this.inflight = ac
    const at = Date.now()
    const recent = this.ctx.transcriptText(3 * 60_000)
    const fromTranscript = !input.question && input.trigger !== 'screenshot'
    const question =
      input.question?.trim() ||
      (input.trigger === 'screenshot'
        ? "What's on my screen right now, and what should I say about it?"
        : this.ctx.lastQuestionText(45_000) || '(no recent transcript)')
    this.emit({ kind: 'start', id, trigger: input.trigger, question, at })
    const record = (r: Partial<AnswerRecord>) =>
      this.onRecord({ id, trigger: input.trigger, question, text: '', model: '', firstTokenMs: 0, prepared: false, at, ...r })

    if (fromTranscript && !this.ctx.transcriptText(45_000)) {
      // Don't spend a free-tier request on an empty prompt.
      this.emit({ kind: 'error', id, message: 'Nothing heard in the last 45 s. Ctrl+Alt+T to type a question instead.' })
      return
    }
    const cfg = this.cfg()
    let instant = cfg.knowledge.instant_answers && input.trigger !== 'screenshot' ? this.knowledge.instant(question) : null
    if (instant) this.emit({ kind: 'prepared', id, ...instant })

    const gem = this.gem()
    if (!gem) {
      this.emit({ kind: 'error', id, message: 'No Gemini API key yet. Use the tray icon → Set API key, or put it in .env.' })
      return
    }
    try {
      const found = await this.knowledge.forQuestion(question, ac.signal)
      const knowledge = found.context
      if (found.instant && cfg.knowledge.instant_answers && input.trigger !== 'screenshot' && instant?.source !== 'qa' && !ac.signal.aborted) {
        instant = found.instant
        this.emit({ kind: 'prepared', id, ...instant })
      }
      const slide = this.ctx.currentSlide
      const live: Part[] = [
        ...(slide
          ? [{ text: `CURRENT SLIDE ${slide.index}: ${slide.title}\n${slide.text}\nSpeaker notes: ${slide.notes || '(none)'}` }]
          : []),
        { text: `RECENT TRANSCRIPT (last ~3 min, ME = ${cfg.meeting.me}, THEM = the other side):\n${recent || '(none)'}` },
        ...(input.image ? [{ inlineData: { data: input.image.data.toString('base64'), mimeType: input.image.mimeType } }] : []),
        {
          text:
            input.trigger === 'screenshot'
              ? `The image is ${cfg.meeting.me}'s screen right now. ${input.question ? `QUESTION: ${input.question}` : `If a question was just asked in the transcript, answer it using what's on screen; otherwise give ${cfg.meeting.me} talking points about what's on screen.`}`
              : fromTranscript
                ? `Answer the most recent question or request directed at ${cfg.meeting.me} in the transcript.`
                : `QUESTION: ${question}`
        }
      ]
      const contents: Content[] = [{ role: 'user', parts: [{ text: knowledgeBlock(knowledge) }, ...live] }]
      const cache = this.knowledge.cache()
      let lastEmit = 0
      const res = await streamBrain(gem, {
        system: liveSystemPrompt(cfg),
        contents,
        cache: cache ? { ...cache, contents: [{ role: 'user', parts: live }] } : undefined,
        thinking: cfg.gemini.thinking.live,
        chain: gem.brainChain,
        signal: ac.signal,
        maxWaitMs: 1500,
        onSkip: (m) => log.warn(`answer #${id}: skipped ${m}`),
        onText: (text) => {
          const now = performance.now()
          if (now - lastEmit > 40) {
            lastEmit = now
            this.emit({ kind: 'delta', id, text })
          }
        }
      })
      if (ac.signal.aborted) return
      this.lastLatencyMs = Math.round(res.firstTokenMs)
      log.info(
        `answer #${id} ${input.trigger} model=${res.model} first=${Math.round(res.firstTokenMs)}ms total=${Math.round(res.totalMs)}ms in=${res.inputTokens} out=${res.outputTokens}${instant ? ' (prepared shown first)' : ''}`
      )
      this.emit({
        kind: 'done',
        id,
        text: res.text,
        model: res.model,
        firstTokenMs: res.firstTokenMs,
        totalMs: res.totalMs,
        inputTokens: res.inputTokens,
        outputTokens: res.outputTokens
      })
      record({ text: res.text, model: res.model, firstTokenMs: res.firstTokenMs, prepared: Boolean(instant) })
    } catch (err) {
      if (ac.signal.aborted) return
      const message =
        err instanceof AllModelsExhaustedError
          ? `Out of free-tier budget for now. ${err.details.join(' · ')}`
          : `Gemini error: ${parseApiError(err).message.slice(0, 240)}`
      log.warn(`answer #${id} failed`, message)
      this.emit({ kind: 'error', id, message: instant ? `Live answer failed (showing prepared answer): ${message}` : message })
      record({ text: instant?.text ?? '', prepared: Boolean(instant), error: message })
    } finally {
      if (this.inflight === ac) this.inflight = null
      this.onUsage()
    }
  }
}

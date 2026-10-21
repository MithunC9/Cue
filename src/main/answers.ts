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

export interface KnowledgeProvider {
  /** Text block (brief + retrieved chunks) for this question, or null when prep hasn't run. */
  forQuestion(question: string): Promise<string | null>
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
    private onUsage: () => void
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
    const recent = this.ctx.transcriptText(3 * 60_000)
    const question =
      input.question?.trim() ||
      (input.trigger === 'screenshot'
        ? 'What is on my screen right now, and what should I say about it?'
        : this.ctx.transcriptText(45_000).split('\n').slice(-6).join(' / ') || '(no recent transcript)')
    this.emit({ kind: 'start', id, trigger: input.trigger, question, at: Date.now() })

    if (input.trigger === 'hotkey' && !input.question && !this.ctx.transcriptText(45_000)) {
      // Don't spend a free-tier request on an empty prompt.
      this.emit({ kind: 'error', id, message: 'Nothing heard in the last 45 s. Ctrl+Alt+T to type a question instead.' })
      return
    }
    const gem = this.gem()
    if (!gem) {
      this.emit({ kind: 'error', id, message: 'No Gemini API key yet. Use the tray icon → Set API key, or put it in .env.' })
      return
    }
    const cfg = this.cfg()
    try {
      const knowledge = await this.knowledge.forQuestion(question)
      const slide = this.ctx.currentSlide
      const parts: Part[] = [
        { text: knowledgeBlock(knowledge) },
        ...(slide
          ? [{ text: `CURRENT SLIDE ${slide.index}: ${slide.title}\n${slide.text}\nSpeaker notes: ${slide.notes || '(none)'}` }]
          : []),
        { text: `RECENT TRANSCRIPT (last ~3 min, ME = ${cfg.meeting.me}, THEM = the other side):\n${recent || '(none)'}` },
        ...(input.image ? [{ inlineData: { data: input.image.data.toString('base64'), mimeType: input.image.mimeType } }] : []),
        {
          text:
            input.trigger === 'auto' || (input.trigger === 'hotkey' && !input.question)
              ? `Answer the most recent question or request directed at ${cfg.meeting.me} in the transcript.`
              : `QUESTION: ${question}`
        }
      ]
      const contents: Content[] = [{ role: 'user', parts }]
      let lastEmit = 0
      const res = await streamBrain(gem, {
        system: liveSystemPrompt(cfg),
        contents,
        thinking: cfg.gemini.thinking.live,
        chain: gem.brainChain,
        signal: ac.signal,
        maxWaitMs: 1500,
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
      log.info(`answer #${id} ${input.trigger} model=${res.model} first=${Math.round(res.firstTokenMs)}ms total=${Math.round(res.totalMs)}ms in=${res.inputTokens} out=${res.outputTokens}`)
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
    } catch (err) {
      if (ac.signal.aborted) return
      const message =
        err instanceof AllModelsExhaustedError
          ? `Out of free-tier budget for now. ${err.details.join(' · ')}`
          : `Gemini error: ${parseApiError(err).message.slice(0, 240)}`
      log.warn(`answer #${id} failed`, message)
      this.emit({ kind: 'error', id, message })
    } finally {
      if (this.inflight === ac) this.inflight = null
      this.onUsage()
    }
  }
}

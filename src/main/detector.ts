// Auto question detection: when the other side finishes an utterance, decide whether it's a question
// or request directed at you, and if so trigger one answer card.
//
// Free-tier note: FAST calls can take seconds when Google is busy, so a local check runs first.
// Clear questions trigger straight away; only ambiguous lines go to FAST; chit-chat is ignored.
import { generateJson } from './gemini/brain'
import type { Gemini } from './gemini/client'
import type { CueConfig } from './config'
import type { MeetingContext } from './context'
import { log } from './log'
import { overlap } from './retrieval'

const WH = /\b(what|what's|whats|why|how|when|where|which|who|whose|whom)\b/i
const AUX_START = /^(?:so,?\s+|and\s+|but\s+|okay,?\s+|ok,?\s+|um,?\s+|uh,?\s+)*(can|could|would|will|do|does|did|is|are|was|were|have|has|had|should|shall|may|might)\s+(you|your|it|this|that|these|those|there|the|we|i)\b/i
const REQUEST = /\b(tell me|walk me through|walk us through|explain|talk about|talk me through|describe|go over|go through|show me|show us|say more|elaborate|clarify|remind me|give me|give us|help me understand|i'm curious|i am curious|i was wondering|i wonder)\b/i
/** Meeting logistics: requests to you, but not ones a card can help with. */
const LOGISTICS = /\b(go back (?:one|a|to the)?\s*slide|next slide|previous slide|back a slide|share (?:your|the) screen|stop sharing|(?:can|could) you (?:hear|see) (?:me|my|it)|you'?re (?:on )?mute|unmute|you'?re muted|scroll (?:up|down)|zoom in|zoom out|bigger|full ?screen|one sec(?:ond)?|hold on)\b/i
const BACKCHANNEL = /^(?:(?:ok(?:ay)?|yeah|yes|yep|right|sure|mm+-?hmm+|uh-?huh|got it|i see|nice|great|cool|good|perfect|awesome|interesting|makes sense|sounds good|thanks?(?: you)?|alright|all right)[\s,.!]*)+$/i

export interface Heuristic {
  score: number
  reasons: string[]
}

/** Local, instant question score for an utterance from the other side. */
export function questionScore(text: string, myName = ''): Heuristic {
  const t = text.trim()
  const reasons: string[] = []
  let score = 0
  const words = t.split(/\s+/).filter(Boolean).length
  if (!t || BACKCHANNEL.test(t)) return { score: -5, reasons: ['backchannel'] }
  if (LOGISTICS.test(t) && t.split(/\s+/).length < 14) return { score: -3, reasons: ['logistics'] }
  if (words < 3) {
    score -= 2
    reasons.push('short')
  }
  if (/\?/.test(t)) {
    score += 2
    reasons.push('?')
  }
  // Look at the last sentence or two: that's where the question usually is.
  const tail = t.split(/(?<=[.!?])\s+/).slice(-2).join(' ')
  if (WH.test(tail)) {
    score += 1.5
    reasons.push('wh-word')
  }
  if (AUX_START.test(tail.split(/(?<=[.!?])\s+/).pop() ?? '') || AUX_START.test(tail)) {
    score += 1.5
    reasons.push('aux-question')
  }
  if (REQUEST.test(tail)) {
    score += 1.5
    reasons.push('request')
  }
  if (/\b(you|your|you're|you've)\b/i.test(tail)) {
    score += 0.5
    reasons.push('you')
  }
  // Your name, as a proper noun (case-sensitive), and only if it isn't an everyday word.
  if (myName.length > 2 && !/^(me|you|i)$/i.test(myName) && new RegExp(`\\b${myName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(t)) {
    score += 1
    reasons.push('name')
  }
  return { score, reasons }
}

/**
 * Just the asking part of an utterance: "Okay, thanks Mithun, that looks good. Quick question though,
 * how did you validate X? And why Y?" → "how did you validate X? And why Y?"
 */
export function extractQuestion(text: string): string {
  const sentences = text.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean)
  const asking = (s: string) => /\?/.test(s) || WH.test(s) || AUX_START.test(s) || REQUEST.test(s)
  const first = sentences.findIndex(asking)
  if (first < 0) return text.trim()
  let q = sentences.slice(first).join(' ')
  // Drop a lead-in inside the first asking sentence ("Quick question though, how did you…").
  q = q.replace(/^(?:(?:ok(?:ay)?|so|and|alright|right|um|uh|quick question(?: though| for you)?|one (?:more )?question|question)[,:]?\s+)+/i, '')
  return q.charAt(0).toUpperCase() + q.slice(1)
}

export interface Classification {
  is_question_for_me: boolean
  question: string
  confidence: number
}

const SCHEMA = {
  type: 'object',
  properties: {
    is_question_for_me: { type: 'boolean', description: 'true if the last THEM utterance asks ME a question or makes a request ME should answer' },
    question: { type: 'string', description: 'The question as one standalone sentence (resolve "it"/"that" from context); empty if none' },
    confidence: { type: 'number' }
  },
  required: ['is_question_for_me', 'question', 'confidence']
}

export interface DetectorDeps {
  gem: () => Gemini | null
  cfg: () => CueConfig
  ctx: MeetingContext
  ask: (question: string) => void
  /** Is the other side talking right now (VAD)? Used to merge multi-sentence questions. */
  themSpeaking: () => boolean
}

export class QuestionDetector {
  private pending: { text: string; at: number }[] = []
  private timer: NodeJS.Timeout | null = null
  private lastAsked: { text: string; at: number } | null = null
  enabled = true

  constructor(private d: DetectorDeps) {}

  /** Called for each final THEM utterance. */
  onThemUtterance(text: string, at = Date.now()): void {
    if (!this.enabled || !this.d.cfg().auto_answer.enabled) return
    this.pending.push({ text, at })
    this.schedule()
  }

  /** Called when the other side starts talking again: hold off so a follow-up sentence is merged in. */
  onThemSpeechStart(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  /** The other side stopped talking; if nothing arrives the pending text is evaluated. */
  onThemSpeechEnd(): void {
    if (this.pending.length) this.schedule()
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = null
      if (this.d.themSpeaking()) return // a follow-up is coming; its final will reschedule
      void this.evaluate()
    }, this.d.cfg().auto_answer.merge_ms)
  }

  async evaluate(): Promise<void> {
    const parts = this.pending.splice(0)
    if (!parts.length) return
    const text = parts.map((p) => p.text).join(' ')
    const cfg = this.d.cfg()
    const h = questionScore(text, cfg.meeting.me)
    if (h.score < 1.5) {
      log.info(`auto: ignored (${h.score}: ${h.reasons.join(',') || 'statement'}) "${text.slice(0, 80)}"`)
      return
    }
    const mode = cfg.auto_answer.fast
    const clear = h.score >= 3
    let question = extractQuestion(text)
    if (mode === 'always' || (mode === 'ambiguous' && !clear)) {
      const c = await this.classify(text)
      if (c === null) {
        // FAST unavailable (quota/slow): fall back to the local verdict.
        if (h.score < 2.5) return void log.info(`auto: FAST unavailable, not sure enough (${h.score}) "${text.slice(0, 80)}"`)
      } else if (!c.is_question_for_me || c.confidence < 0.5) {
        return void log.info(`auto: FAST says not a question for me (${c.confidence}) "${text.slice(0, 80)}"`)
      } else if (c.question.trim()) question = c.question.trim()
    }
    const now = Date.now()
    if (this.lastAsked && now - this.lastAsked.at < 30_000 && overlap(question, this.lastAsked.text) >= 0.7) {
      return void log.info(`auto: duplicate of the last question, skipped`)
    }
    this.lastAsked = { text: question, at: now }
    log.info(`auto: answering (${h.score}: ${h.reasons.join(',')}) "${question.slice(0, 100)}"`)
    this.d.ask(question)
  }

  private async classify(text: string): Promise<Classification | null> {
    const gem = this.d.gem()
    if (!gem) return null
    const cfg = this.d.cfg()
    const context = this.d.ctx.transcriptText(90_000).split('\n').slice(-8).join('\n')
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(new Error('FAST timeout')), cfg.auto_answer.fast_timeout_ms)
    try {
      const r = await generateJson<Classification>(gem, {
        system: `You watch a live Zoom meeting transcript. ME is ${cfg.meeting.me} (a student presenting research); THEM is ${cfg.meeting.with}. Decide if THEM's last utterance asks ME a question or makes a request ME should answer now. Rhetorical remarks, small talk, instructions to someone else, and "okay"/"sounds good" are not.`,
        contents: [{ role: 'user', parts: [{ text: `Recent transcript:\n${context}\n\nTHEM's last utterance: "${text}"` }] }],
        schema: SCHEMA,
        thinking: cfg.gemini.thinking.fast,
        chain: gem.fastChain,
        signal: ac.signal,
        maxWaitMs: 0
      })
      log.info(`auto: FAST (${r.model}) → ${JSON.stringify(r.value)}`)
      return r.value
    } catch (err) {
      log.warn('auto: FAST classify failed', String((err as Error).message ?? err).slice(0, 160))
      return null
    } finally {
      clearTimeout(timer)
    }
  }
}

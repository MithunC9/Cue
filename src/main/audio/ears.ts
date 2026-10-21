// EARS: real-time transcription of one speaker's audio over the Gemini Live API.
//
// What the server does (measured Oct 2026 with gemini-3.5-transcribe-live):
// - interim transcripts every ~0.5 s while someone talks; the final ~0.4 s after we send
//   audioStreamEnd at the end of an utterance (our VAD decides when that is),
// - it closes a connection after ~60 s without audio (code 1008), and connections are capped at
//   ~10 min (goAway first).
// So: connect when speech starts, keep the current utterance's audio so a dropped connection can be
// replayed into a fresh one, and rotate old connections between utterances. A 45-minute meeting is
// just a series of short connections and never loses the transcript.
import { EventEmitter } from 'node:events'
import { Modality, type Session } from '@google/genai'
import type { CueConfig } from '../config'
import type { Gemini } from '../gemini/client'
import { parseApiError, withFallback } from '../gemini/quota'
import { log } from '../log'
import type { Speaker } from '../../shared/types'

export type EarsState = 'idle' | 'connecting' | 'open' | 'error'

export interface EarsEvents {
  interim: [text: string]
  final: [text: string]
  state: [state: EarsState, detail: string]
}

const MAX_CONNECTION_AGE_MS = 8 * 60_000
const FINAL_TIMEOUT_MS = 4000
const MAX_UTTERANCE_BYTES = 16000 * 2 * 90 // 90 s of audio kept for replay

/** WAV header for 16 kHz mono int16 PCM (used by the chunked fallback). */
export function wav(pcm: Buffer, rate = 16000): Buffer {
  const h = Buffer.alloc(44)
  h.write('RIFF', 0)
  h.writeUInt32LE(36 + pcm.length, 4)
  h.write('WAVEfmt ', 8)
  h.writeUInt32LE(16, 16)
  h.writeUInt16LE(1, 20)
  h.writeUInt16LE(1, 22)
  h.writeUInt32LE(rate, 24)
  h.writeUInt32LE(rate * 2, 28)
  h.writeUInt16LE(2, 32)
  h.writeUInt16LE(16, 34)
  h.write('data', 36)
  h.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([h, pcm])
}

export class Ears extends EventEmitter<EarsEvents> {
  private session: Session | null = null
  private connecting: Promise<void> | null = null
  private openedAt = 0
  private retire = false // goAway received or too old: close after the current utterance
  private utterance: Buffer[] = []
  private utteranceBytes = 0
  private inUtterance = false
  private sentEnd = false
  private lastInterim = ''
  private finalTimer: NodeJS.Timeout | null = null
  private failures = 0
  private stopped = true
  mode: 'live' | 'chunked'

  constructor(
    readonly speaker: Speaker,
    private gem: () => Gemini | null,
    private cfg: () => CueConfig
  ) {
    super()
    this.mode = cfg().audio.transcription
  }

  start(): void {
    this.stopped = false
    this.mode = this.cfg().audio.transcription
    this.emit('state', 'idle', '')
  }

  stop(): void {
    this.stopped = true
    if (this.inUtterance) this.endUtterance()
    this.closeSession('stopped')
  }

  // ---------- audio in ----------

  utteranceStart(): void {
    if (this.stopped) return
    this.inUtterance = true
    this.sentEnd = false
    this.utterance = []
    this.utteranceBytes = 0
    this.lastInterim = ''
    if (this.mode === 'live') void this.ensureOpen()
  }

  audio(pcm: Buffer): void {
    if (this.stopped) return
    if (!this.inUtterance) this.utteranceStart()
    if (this.utteranceBytes + pcm.length <= MAX_UTTERANCE_BYTES) {
      this.utterance.push(pcm)
      this.utteranceBytes += pcm.length
    }
    if (this.mode === 'live' && this.session) this.send(pcm)
  }

  endUtterance(): void {
    if (!this.inUtterance) return
    this.inUtterance = false
    if (this.mode === 'chunked') {
      void this.transcribeChunk(Buffer.concat(this.utterance))
      this.utterance = []
      this.utteranceBytes = 0
      return
    }
    if (this.session) this.sendEnd()
    // If the connection is still opening, ensureOpen() replays the audio and sends the end.
    this.armFinalTimeout()
  }

  // ---------- live session ----------

  private send(pcm: Buffer): void {
    try {
      this.session!.sendRealtimeInput({ audio: { data: pcm.toString('base64'), mimeType: 'audio/pcm;rate=16000' } })
    } catch (err) {
      log.warn(`ears ${this.speaker}: send failed`, String(err))
    }
  }

  private sendEnd(): void {
    if (this.sentEnd) return
    this.sentEnd = true
    try {
      this.session!.sendRealtimeInput({ audioStreamEnd: true })
    } catch {
      /* the close handler will replay */
    }
  }

  private armFinalTimeout(): void {
    if (this.finalTimer) clearTimeout(this.finalTimer)
    this.finalTimer = setTimeout(() => {
      // No final from the server: keep what we heard rather than lose it.
      if (this.lastInterim) this.deliverFinal(this.lastInterim)
    }, FINAL_TIMEOUT_MS)
  }

  private deliverFinal(text: string): void {
    if (this.finalTimer) clearTimeout(this.finalTimer)
    this.finalTimer = null
    const t = text.trim()
    this.lastInterim = ''
    if (t) this.emit('final', t)
    // Everything sent so far is transcribed; a later reconnect must not replay it.
    this.utterance = []
    this.utteranceBytes = 0
    if (!this.inUtterance && (this.retire || Date.now() - this.openedAt > MAX_CONNECTION_AGE_MS)) this.closeSession('rotating connection')
  }

  private async ensureOpen(): Promise<void> {
    if (this.session || this.stopped) return
    if (this.connecting) return this.connecting
    this.connecting = this.connect().finally(() => (this.connecting = null))
    return this.connecting
  }

  private async connect(): Promise<void> {
    const gem = this.gem()
    if (!gem) {
      this.emit('state', 'error', 'No API key')
      return
    }
    const cfg = this.cfg()
    const model = cfg.gemini.models.ears
    const transcribeOnly = /transcribe/.test(model)
    this.emit('state', 'connecting', model)
    const vocab = this.vocabulary()
    let ref: Session | null = null
    try {
      const session = await gem.ai.live.connect({
        model,
        config: {
          // Transcription-only model: text out, never audio. A dialog model would answer out loud, so
          // in that legacy mode its audio is discarded and only the input transcription is used.
          responseModalities: [transcribeOnly ? Modality.TEXT : Modality.AUDIO],
          inputAudioTranscription: { customVocabulary: vocab, ...(cfg.audio.language ? { languageCodes: [cfg.audio.language] } : {}) },
          ...(transcribeOnly ? {} : { systemInstruction: 'You are a silent relay. Never respond.' }),
          contextWindowCompression: { slidingWindow: {} }
        },
        callbacks: {
          onmessage: (m) => {
            const c = m.serverContent
            if (c?.interimInputTranscription?.text) {
              this.lastInterim = c.interimInputTranscription.text
              this.emit('interim', this.lastInterim)
            }
            if (c?.inputTranscription?.text !== undefined) this.deliverFinal(c.inputTranscription.text ?? '')
            if (m.goAway) {
              log.info(`ears ${this.speaker}: goAway (${m.goAway.timeLeft ?? '?'} left)`)
              this.retire = true
              if (!this.inUtterance && !this.finalTimer) this.closeSession('goAway')
            }
          },
          onerror: (e) => log.warn(`ears ${this.speaker}: socket error`, (e as { message?: string }).message ?? ''),
          onclose: (e) => this.onClose(ref, e.code, e.reason)
        }
      })
      ref = session
      this.session = session
      this.openedAt = Date.now()
      this.retire = false
      this.failures = 0
      this.emit('state', 'open', model)
      // Replay what was said while connecting (or what a dropped connection lost).
      for (const pcm of this.utterance) this.send(pcm)
      if (!this.inUtterance && this.utterance.length) {
        this.sendEnd()
        this.armFinalTimeout()
      }
    } catch (err) {
      this.failures++
      const e = parseApiError(err)
      log.warn(`ears ${this.speaker}: connect failed (${this.failures})`, e.message)
      this.emit('state', 'error', e.message.slice(0, 160))
      if (this.failures >= 3 && this.cfg().audio.chunked_fallback) {
        this.mode = 'chunked'
        this.emit('state', 'error', 'Live transcription unavailable; switched to per-utterance transcription (slower).')
        if (!this.inUtterance && this.utterance.length) void this.transcribeChunk(Buffer.concat(this.utterance))
      } else if (!this.stopped) {
        setTimeout(() => void this.ensureOpen(), Math.min(8000, 500 * 2 ** this.failures))
      }
    }
  }

  private onClose(session: Session | null, code: number, reason: string): void {
    if (!session || this.session !== session) return
    this.session = null
    this.sentEnd = false
    const idle = code === 1008 && /abort/i.test(reason) && !this.inUtterance && !this.finalTimer
    if (idle || this.stopped) {
      this.emit('state', 'idle', '')
      return
    }
    log.warn(`ears ${this.speaker}: connection closed mid-utterance (${code} ${reason}); reconnecting and replaying`)
    if (this.utterance.length || this.inUtterance) void this.ensureOpen()
    else this.emit('state', 'idle', '')
  }

  private closeSession(why: string): void {
    const s = this.session
    this.session = null
    this.sentEnd = false
    if (s) {
      log.info(`ears ${this.speaker}: closing connection (${why})`)
      try {
        s.close()
      } catch {
        /* ignore */
      }
    }
    if (!this.stopped) this.emit('state', 'idle', '')
  }

  /** Words the recognizer should expect: your name, config keywords and audio.vocabulary. */
  private vocabulary(): string[] {
    const cfg = this.cfg()
    return [...new Set([cfg.meeting.me, ...cfg.keywords, ...cfg.audio.vocabulary])].filter(Boolean).slice(0, 100)
  }

  // ---------- chunked fallback ----------

  /** One generateContent request per utterance. Slower (~1–3 s after you stop talking) but robust. */
  private async transcribeChunk(pcm: Buffer): Promise<void> {
    const gem = this.gem()
    if (!gem || pcm.length < 16000 * 2 * 0.3) return
    const cfg = this.cfg()
    try {
      const { value } = await withFallback(
        gem.quota,
        [cfg.audio.chunked_model],
        (model) =>
          gem.ai.models.generateContent({
            model,
            // gemini-3.5-transcribe takes the audio alone and answers with an audioTranscription part.
            contents: [{ role: 'user', parts: [{ inlineData: { data: wav(pcm).toString('base64'), mimeType: 'audio/wav' } }] }],
            config: { audioTranscriptionConfig: { customVocabulary: this.vocabulary(), ...(cfg.audio.language ? { languageCodes: [cfg.audio.language] } : {}) } }
          }),
        { maxWaitMs: 5000 }
      )
      const parts = value.candidates?.[0]?.content?.parts ?? []
      const text = parts
        .map((p) => p.audioTranscription?.text ?? p.text ?? '')
        .join(' ')
        .trim()
      if (text) this.emit('final', text)
    } catch (err) {
      log.warn(`ears ${this.speaker}: chunked transcription failed`, parseApiError(err).message)
      this.emit('state', 'error', 'Transcription failed for one utterance (quota?).')
    }
  }
}

// Mic (ME) + Zoom audio (THEM) → two EARS sessions → the rolling transcript.
import { EventEmitter } from 'node:events'
import type { CueConfig } from '../config'
import type { MeetingContext } from '../context'
import type { Gemini } from '../gemini/client'
import { log } from '../log'
import { overlap } from '../retrieval'
import type { Speaker, TranscriptLine } from '../../shared/types'
import type { AudioCapture } from './capture'
import { Ears, type EarsState } from './ears'

export interface ListenerEvents {
  transcript: [lines: TranscriptLine[]]
  /** A finished utterance (final transcript). Phase 5 listens for THEM ones. */
  utterance: [speaker: Speaker, text: string, at: number]
  state: [listening: boolean, detail: string]
  levels: [me: number, them: number]
  warn: [text: string]
  ears: [state: Record<Speaker, EarsState>]
}

export class Listener extends EventEmitter<ListenerEvents> {
  readonly me: Ears
  readonly them: Ears
  listening = false
  earsState: Record<Speaker, EarsState> = { ME: 'idle', THEM: 'idle' }
  /** Debug/testing: WAVs to play instead of the real mic / Zoom audio. */
  testFiles: { me?: string; them?: string } = {}

  constructor(
    private capture: AudioCapture,
    gem: () => Gemini | null,
    private cfg: () => CueConfig,
    private ctx: MeetingContext,
    private micDevice: () => string
  ) {
    super()
    this.me = new Ears('ME', gem, cfg)
    this.them = new Ears('THEM', gem, cfg)
    for (const ears of [this.me, this.them]) {
      ears.on('interim', (text) => this.line(ears.speaker, text, false))
      ears.on('final', (text) => this.line(ears.speaker, text, true))
      ears.on('state', (state, detail) => {
        this.earsState[ears.speaker] = state
        this.emit('ears', { ...this.earsState })
        if (state === 'error' && detail) this.emit('warn', `${ears.speaker === 'ME' ? 'Mic' : 'Zoom audio'} transcription: ${detail}`)
      })
    }
    capture.on('frames', (speaker, pcm) => this.listening && this.ears(speaker).audio(pcm))
    capture.on('utteranceStart', (speaker) => this.listening && this.ears(speaker).utteranceStart())
    capture.on('utteranceEnd', (speaker) => this.ears(speaker).endUtterance())
    capture.on('levels', (me, them) => this.emit('levels', me, them))
    capture.on('status', (state, detail) => {
      if (state === 'error') {
        this.emit('warn', detail)
        if (!/mic only/i.test(detail)) this.stop()
      }
    })
  }

  private ears(s: Speaker): Ears {
    return s === 'ME' ? this.me : this.them
  }

  private line(speaker: Speaker, text: string, final: boolean): void {
    const cfg = this.cfg()
    if (speaker === 'ME' && !cfg.audio.headphones) {
      // On speakers the mic also hears the professor: drop mic lines that repeat what THEM just said.
      const recentThem = this.ctx.since(10_000).filter((l) => l.speaker === 'THEM')
      if (recentThem.some((l) => overlap(text, l.text) >= 0.6)) {
        if (final) {
          this.ctx.dropOpen('ME')
          log.info('dropped mic echo of the other side')
          this.emit('transcript', this.ctx.lastLines(20))
        }
        return
      }
    }
    const l = this.ctx.upsert(speaker, text, final)
    this.emit('transcript', this.ctx.lastLines(20))
    if (final) this.emit('utterance', speaker, l.text, l.at)
  }

  async start(): Promise<void> {
    if (this.listening) return
    const cfg = this.cfg()
    this.listening = true
    this.me.start()
    this.them.start()
    await this.capture.start({
      micDeviceId: this.micDevice(),
      them: cfg.audio.them_source,
      micProcessing: cfg.audio.mic_processing,
      testMe: this.testFiles.me,
      testThem: this.testFiles.them
    })
    this.emit('state', true, '')
  }

  stop(): void {
    if (!this.listening) return
    this.listening = false
    this.capture.stop()
    this.me.stop()
    this.them.stop()
    this.emit('state', false, '')
  }

  toggle(): void {
    if (this.listening) this.stop()
    else void this.start()
  }
}

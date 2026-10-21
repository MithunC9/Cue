// Energy-based voice activity detection with an adaptive noise floor. Pure TypeScript (no DOM), so
// it runs in the audio window and in unit tests. Frames are 20 ms of 16 kHz mono int16.

export interface VadOptions {
  frameMs: number
  /** Speech when the level is this many times the noise floor (3.2 ≈ +10 dB). */
  ratio: number
  /** Absolute minimum RMS (0..1) counted as speech; digital silence from Zoom sits far below it. */
  minLevel: number
  /** Loud frames needed before speech starts (filters clicks and keyboard taps). */
  minSpeechMs: number
  /** Keep sending this long after the last loud frame (natural pauses between words). */
  hangoverMs: number
  /** Audio kept from just before speech started, so first syllables aren't clipped. */
  prerollMs: number
}

export const DEFAULT_VAD: VadOptions = { frameMs: 20, ratio: 3.2, minLevel: 0.004, minSpeechMs: 80, hangoverMs: 700, prerollMs: 320 }

export interface VadResult {
  /** Frames to send now (pre-roll on speech start, then live frames). */
  send: Int16Array[]
  started: boolean
  /** True on the frame where an utterance ends (after the hangover). */
  ended: boolean
}

export function rms(frame: Int16Array): number {
  let s = 0
  for (let i = 0; i < frame.length; i++) {
    const v = frame[i] / 32768
    s += v * v
  }
  return Math.sqrt(s / (frame.length || 1))
}

export class Vad {
  floor = 0.002
  speaking = false
  private loudMs = 0
  private quietMs = 0
  private preroll: Int16Array[] = []

  constructor(private o: VadOptions = DEFAULT_VAD) {}

  push(frame: Int16Array, level = rms(frame)): VadResult {
    const o = this.o
    const loud = level > Math.max(this.floor * o.ratio, o.minLevel)
    // Noise floor: follows quiet levels down quickly and up slowly, frozen while someone speaks.
    if (!this.speaking && !loud) this.floor = level < this.floor ? this.floor * 0.8 + level * 0.2 : this.floor * 0.995 + level * 0.005
    if (!this.speaking) {
      this.preroll.push(frame)
      const keep = Math.ceil(o.prerollMs / o.frameMs) + Math.ceil(o.minSpeechMs / o.frameMs)
      if (this.preroll.length > keep) this.preroll.shift()
      this.loudMs = loud ? this.loudMs + o.frameMs : 0
      if (this.loudMs >= o.minSpeechMs) {
        this.speaking = true
        this.quietMs = 0
        const send = this.preroll
        this.preroll = []
        return { send, started: true, ended: false }
      }
      return { send: [], started: false, ended: false }
    }
    this.quietMs = loud ? 0 : this.quietMs + o.frameMs
    if (this.quietMs >= o.hangoverMs) {
      this.speaking = false
      this.loudMs = 0
      return { send: [frame], started: false, ended: true }
    }
    return { send: [frame], started: false, ended: false }
  }

  /** Force the end of an utterance (e.g. listening paused mid-sentence). */
  flush(): boolean {
    const was = this.speaking
    this.speaking = false
    this.loudMs = 0
    this.quietMs = 0
    this.preroll = []
    return was
  }
}

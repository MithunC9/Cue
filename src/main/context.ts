// What BRAIN gets to see: rolling transcript, current slide, and knowledge.
// Phase 1 only has the transcript store (empty until audio lands in Phase 4) and no knowledge.
import type { Speaker, TranscriptLine } from '../shared/types'

export interface SlideInfo {
  index: number // 1-based
  title: string
  text: string
  notes: string
}

export class MeetingContext {
  private lines: TranscriptLine[] = []
  private seq = 0
  currentSlide: SlideInfo | null = null

  /** Adds or updates the in-progress line for a speaker; returns the line. */
  upsert(speaker: Speaker, text: string, final: boolean, at = Date.now()): TranscriptLine {
    const open = [...this.lines].reverse().find((l) => l.speaker === speaker && !l.final)
    if (open) {
      open.text = text
      open.final = final
      return open
    }
    const line = { id: ++this.seq, speaker, text, final, at }
    this.lines.push(line)
    if (this.lines.length > 2000) this.lines.splice(0, this.lines.length - 2000)
    return line
  }

  lastLines(n: number): TranscriptLine[] {
    return this.lines.slice(-n)
  }

  since(ms: number, now = Date.now()): TranscriptLine[] {
    return this.lines.filter((l) => now - l.at <= ms)
  }

  /** What "answer now" should answer: the other side's last few lines, else anything recent. */
  lastQuestionText(ms: number, now = Date.now()): string {
    const recent = this.since(ms, now).filter((l) => l.text.trim())
    const them = recent.filter((l) => l.speaker === 'THEM').slice(-3)
    return (them.length ? them : recent.slice(-3)).map((l) => l.text.trim()).join(' ')
  }

  transcriptText(ms: number): string {
    return this.since(ms)
      .filter((l) => l.text.trim())
      .map((l) => `${l.speaker}: ${l.text.trim()}`)
      .join('\n')
  }

  clear(): void {
    this.lines = []
  }
}

// Per-meeting logs: sessions\YYYY-MM-DD_HHMM\transcript.md, answers.md, optional screenshots.
// The folder is created on the first thing worth logging, so idle app runs leave nothing behind.
import { appendFileSync, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { AnswerRecord } from './answers'
import type { CueConfig } from './config'
import type { TranscriptLine } from '../shared/types'

const pad = (n: number) => String(n).padStart(2, '0')
export const stamp = (t: number) => {
  const d = new Date(t)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}
export function folderName(t: number): string {
  const d = new Date(t)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}`
}

const TRIGGER: Record<string, string> = { typed: 'TYPED', hotkey: 'ANSWER NOW', auto: 'HEARD', screenshot: 'SCREENSHOT' }

export class SessionLog {
  dir: string | null = null
  private started = 0
  private answers = 0
  private lastSlide = 0

  constructor(
    private root: string,
    private cfg: () => CueConfig
  ) {}

  private ensure(): string {
    if (this.dir) return this.dir
    this.started = Date.now()
    let dir = path.join(this.root, folderName(this.started))
    for (let i = 2; existsSync(dir); i++) dir = path.join(this.root, `${folderName(this.started)}_${i}`)
    mkdirSync(dir, { recursive: true })
    const { meeting } = this.cfg()
    const head = `${meeting.topic}: ${meeting.me} with ${meeting.with}, ${new Date(this.started).toLocaleString()}`
    writeFileSync(path.join(dir, 'transcript.md'), `# Transcript\n\n${head}\n\nME = ${meeting.me} (mic) · THEM = Zoom audio\n\n`)
    writeFileSync(path.join(dir, 'answers.md'), `# Answer cards\n\n${head}\n\n`)
    this.dir = dir
    this.writeMeta()
    return dir
  }

  private writeMeta(): void {
    if (!this.dir) return
    const c = this.cfg()
    writeFileSync(
      path.join(this.dir, 'meta.json'),
      JSON.stringify({ started: new Date(this.started).toISOString(), updated: new Date().toISOString(), meeting: c.meeting, answers: this.answers, models: c.gemini.models }, null, 2)
    )
  }

  transcript(line: TranscriptLine): void {
    if (!line.final || !line.text.trim()) return
    const dir = this.ensure()
    appendFileSync(path.join(dir, 'transcript.md'), `**[${stamp(line.at)}] ${line.speaker}:** ${line.text.trim()}\n\n`)
  }

  slide(index: number, title: string): void {
    if (index === this.lastSlide) return
    this.lastSlide = index
    const dir = this.ensure()
    appendFileSync(path.join(dir, 'transcript.md'), `_[${stamp(Date.now())}] slide ${index}: ${title}_\n\n`)
  }

  answer(r: AnswerRecord): void {
    const dir = this.ensure()
    this.answers++
    const meta = [r.model || 'no model', r.firstTokenMs ? `first token ${(r.firstTokenMs / 1000).toFixed(1)} s` : '', r.prepared ? 'prepared answer shown first' : '']
      .filter(Boolean)
      .join(' · ')
    const body = r.error ? `> ⚠ ${r.error}\n\n${r.text ? r.text + '\n' : ''}` : `${r.text.trim()}\n`
    appendFileSync(path.join(dir, 'answers.md'), `## [${stamp(r.at)}] ${TRIGGER[r.trigger] ?? r.trigger}: ${r.question.replace(/\s+/g, ' ').trim()}\n\n_${meta}_\n\n${body}\n`)
    this.writeMeta()
  }

  screenshot(jpeg: Buffer): string | null {
    if (!this.cfg().sessions.save_screenshots) return null
    const dir = path.join(this.ensure(), 'screenshots')
    mkdirSync(dir, { recursive: true })
    const f = path.join(dir, `${stamp(Date.now()).replace(/:/g, '')}.jpg`)
    writeFileSync(f, jpeg)
    return f
  }
}

/** Most recent session folder that has a transcript. */
export function latestSession(root: string): string | null {
  if (!existsSync(root)) return null
  const dirs = readdirSync(root)
    .map((n) => path.join(root, n))
    .filter((p) => existsSync(path.join(p, 'transcript.md')))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
  return dirs[0] ?? null
}

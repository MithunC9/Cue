// Presentation mode: follows which slide is on screen and serves its talking points.
//
// Every few seconds: capture the presenting monitor (the overlay is excluded from captures on
// Windows) → 64-bit perceptual hash → if the picture changed, read it with local OCR (tesseract.js,
// WebAssembly, bundled English model) and match the words to the deck. FAST looks at the image only
// when OCR can't decide. Slides already seen are recognized from the hash cache.
import { app, type NativeImage } from 'electron'
import { EventEmitter } from 'node:events'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import type { CueConfig } from './config'
import { generateJson } from './gemini/brain'
import type { Gemini } from './gemini/client'
import type { KnowledgeBase, SlideInfo, SlidePrep } from './knowledge'
import { log } from './log'
import { tokenize } from './retrieval'
import { captureDisplay, pickDisplay } from './screen'

export interface SlideState {
  index: number
  total: number
  title: string
  talkingPoints: string[]
  likelyQuestion: string
  answer: string
  sources: string[]
  confidence: number
  method: 'ocr' | 'fast' | 'cache'
}

/** dHash: 9×8 grayscale, one bit per horizontal neighbour comparison. */
export function dhash(img: NativeImage): bigint {
  const bmp = img.resize({ width: 9, height: 8, quality: 'good' }).toBitmap() // BGRA
  let h = 0n
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      const i = (y * 9 + x) * 4
      const j = i + 4
      const a = bmp[i + 2] * 0.299 + bmp[i + 1] * 0.587 + bmp[i] * 0.114
      const b = bmp[j + 2] * 0.299 + bmp[j + 1] * 0.587 + bmp[j] * 0.114
      h = (h << 1n) | (a > b ? 1n : 0n)
    }
  }
  return h
}

export function hamming(a: bigint, b: bigint): number {
  let x = a ^ b
  let n = 0
  while (x) {
    n += Number(x & 1n)
    x >>= 1n
  }
  return n
}

/**
 * Matches OCR'd screen text to a slide: share of the slide's words visible on screen (title words
 * count double), with a small bonus for "next slide" and "same slide".
 */
export function matchSlide(text: string, slides: SlideInfo[], current: number | null): { index: number; score: number; runnerUp: number } | null {
  const seen = new Set(tokenize(text))
  if (seen.size < 2 || !slides.length) return null
  const scored = slides.map((s) => {
    const title = [...new Set(tokenize(s.title))]
    const body = [...new Set(tokenize(s.text))].filter((t) => !title.includes(t))
    const total = title.length * 2 + body.length
    if (!total) return { index: s.index, score: 0 }
    const hit = title.filter((t) => seen.has(t)).length * 2 + body.filter((t) => seen.has(t)).length
    let score = hit / total
    if (current !== null && s.index === current + 1) score += 0.06
    if (current !== null && s.index === current) score += 0.03
    return { index: s.index, score }
  })
  scored.sort((a, b) => b.score - a.score)
  return { index: scored[0].index, score: scored[0].score, runnerUp: scored[1]?.score ?? 0 }
}

type OcrWorker = { recognize: (img: Buffer) => Promise<{ data: { text: string } }>; terminate: () => Promise<unknown> }

export class SlideTracker extends EventEmitter<{ slide: [SlideState]; warn: [string] }> {
  private timer: NodeJS.Timeout | null = null
  private busy = false
  private lastHash: bigint | null = null
  private cache: { hash: bigint; index: number }[] = []
  private ocr: Promise<OcrWorker> | null = null
  current: SlideState | null = null

  constructor(
    private cfg: () => CueConfig,
    private kb: () => KnowledgeBase | null,
    private gem: () => Gemini | null
  ) {
    super()
  }

  get running(): boolean {
    return this.timer !== null
  }

  start(): boolean {
    const kb = this.kb()
    if (!kb?.slides.length) return false
    this.lastHash = null
    this.timer = setInterval(() => void this.tick(), this.cfg().presentation.interval_ms)
    void this.tick()
    return true
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    const w = this.ocr
    this.ocr = null
    void w?.then((x) => x.terminate()).catch(() => {})
  }

  /** Jump to a slide by number (also used when the screen can't be read). */
  show(index: number, method: SlideState['method'], confidence: number): void {
    const kb = this.kb()
    const slide = kb?.slides.find((s) => s.index === index)
    if (!kb || !slide) return
    const prep: SlidePrep | undefined = kb.slidePrep.find((p) => p.index === index)
    this.current = {
      index,
      total: kb.slides.length,
      title: slide.title,
      talkingPoints: prep?.talking_points?.slice(0, 3) ?? slide.text.split('\n').filter(Boolean).slice(0, 3),
      likelyQuestion: prep?.likely_question ?? '',
      answer: prep?.answer ?? '',
      sources: prep?.sources ?? [],
      confidence,
      method
    }
    this.emit('slide', this.current)
  }

  private worker(): Promise<OcrWorker> {
    if (!this.ocr) {
      this.ocr = (async () => {
        const { createWorker } = await import('tesseract.js')
        const base = app.isPackaged ? path.join(process.resourcesPath, 'app.asar.unpacked') : app.getAppPath()
        const cachePath = path.join(app.getPath('userData'), 'tessdata')
        mkdirSync(cachePath, { recursive: true })
        return (await createWorker('eng', 1, {
          langPath: path.join(base, 'node_modules', '@tesseract.js-data', 'eng', '4.0.0_best_int'),
          cachePath,
          gzip: true
        })) as unknown as OcrWorker
      })()
    }
    return this.ocr
  }

  private async tick(): Promise<void> {
    if (this.busy) return
    this.busy = true
    try {
      const cfg = this.cfg()
      const display = pickDisplay(cfg.presentation.display)
      const small = await captureDisplay(display, 320)
      const hash = dhash(small)
      if (this.lastHash !== null && hamming(hash, this.lastHash) <= 5) return
      // Wait out slide transitions: the picture must hold still for a moment.
      await new Promise((r) => setTimeout(r, 450))
      const again = dhash(await captureDisplay(display, 320))
      if (hamming(hash, again) > 5) return
      this.lastHash = again
      const known = this.cache.find((c) => hamming(c.hash, again) <= 4)
      if (known) {
        if (known.index !== this.current?.index) this.show(known.index, 'cache', 1)
        return
      }
      await this.identify(display, again)
    } catch (err) {
      log.warn('slide tracking:', String((err as Error).message ?? err))
    } finally {
      this.busy = false
    }
  }

  private async identify(display: Electron.Display, hash: bigint): Promise<void> {
    const kb = this.kb()
    if (!kb) return
    const img = await captureDisplay(display, 1400)
    const png = img.toPNG()
    const text = (await (await this.worker()).recognize(png)).data.text
    const m = matchSlide(text, kb.slides, this.current?.index ?? null)
    log.info(`slide OCR: best ${m ? `${m.index} (${m.score.toFixed(2)} vs ${m.runnerUp.toFixed(2)})` : 'none'} from "${text.replace(/\s+/g, ' ').slice(0, 80)}"`)
    if (m && m.score >= 0.45 && m.score - m.runnerUp >= 0.12) {
      this.cache.push({ hash, index: m.index })
      if (m.index !== this.current?.index) this.show(m.index, 'ocr', m.score)
      return
    }
    // Not clearly a slide from the deck (Zoom gallery, an editor…): only ask FAST if OCR saw a plausible slide.
    if (!m || m.score < 0.2 || !this.cfg().presentation.use_fast) return
    const fast = await this.askFast(img, kb.slides)
    if (fast && fast.confidence >= 0.6) {
      this.cache.push({ hash, index: fast.index })
      if (fast.index !== this.current?.index) this.show(fast.index, 'fast', fast.confidence)
    }
  }

  private async askFast(img: NativeImage, slides: SlideInfo[]): Promise<{ index: number; confidence: number } | null> {
    const gem = this.gem()
    if (!gem) return null
    const list = slides.map((s) => `${s.index}. ${s.title} | ${s.text.replace(/\s+/g, ' ').slice(0, 120)}`).join('\n')
    try {
      const r = await generateJson<{ index: number; confidence: number }>(gem, {
        system: 'You match a screenshot of a presentation to the slide it shows. Answer index 0 if no slide from the list is on screen.',
        contents: [
          {
            role: 'user',
            parts: [
              { inlineData: { data: img.resize({ width: 960 }).toJPEG(75).toString('base64'), mimeType: 'image/jpeg' } },
              { text: `Slides:\n${list}\n\nWhich slide number is on screen?` }
            ]
          }
        ],
        schema: { type: 'object', properties: { index: { type: 'integer' }, confidence: { type: 'number' } }, required: ['index', 'confidence'] },
        thinking: this.cfg().gemini.thinking.fast,
        chain: gem.fastChain,
        maxWaitMs: 0
      })
      log.info(`slide FAST (${r.model}): ${JSON.stringify(r.value)}`)
      return r.value.index > 0 ? r.value : null
    } catch (err) {
      log.warn('slide FAST failed', String((err as Error).message ?? err).slice(0, 120))
      return null
    }
  }
}

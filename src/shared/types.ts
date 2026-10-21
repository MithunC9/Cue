// Types shared by the main process, preload and renderer.

export type Speaker = 'ME' | 'THEM'

export interface TranscriptLine {
  id: number
  speaker: Speaker
  text: string
  final: boolean
  at: number // epoch ms
}

export type AnswerTrigger = 'typed' | 'hotkey' | 'auto' | 'screenshot'

export interface AnswerStart {
  id: number
  trigger: AnswerTrigger
  question: string
  at: number
}

export interface AnswerDelta {
  id: number
  text: string // full text so far, not just the new chunk
}

export interface AnswerDone {
  id: number
  text: string
  model: string
  firstTokenMs: number
  totalMs: number
  inputTokens: number
  outputTokens: number
}

export interface AnswerError {
  id: number
  message: string
}

export interface AnswerPrepared {
  id: number
  text: string // card text from qa_bank, shown instantly while the live answer streams
  matched: string // the prepared question it matched
  confidence: number
  source: 'qa' | 'notes' // prepared Q&A answer, or the most relevant lines from your notes
}

export type AnswerEvent =
  | ({ kind: 'start' } & AnswerStart)
  | ({ kind: 'prepared' } & AnswerPrepared)
  | ({ kind: 'delta' } & AnswerDelta)
  | ({ kind: 'done' } & AnswerDone)
  | ({ kind: 'error' } & AnswerError)
  | { kind: 'clear' }

export interface QuotaUsage {
  model: string
  usedToday: number
  rpd: number
  blockedUntil: number | null // epoch ms, set after a 429
}

export interface Notice {
  id: number
  level: 'info' | 'warn' | 'error'
  text: string
}

export type InputMode = 'none' | 'type' | 'apikey'

export interface SlideView {
  index: number
  total: number
  title: string
  talkingPoints: string[]
  likelyQuestion: string
  answer: string
  confidence: number
  method: 'ocr' | 'fast' | 'cache'
}

export interface UiState {
  clickThrough: boolean
  inputMode: InputMode
  presentation: boolean
  slide: SlideView | null
  listening: boolean
  listeningAvailable: boolean
  hotkeyFailures: string[]
  quota: { brain: QuotaUsage[]; fast: QuotaUsage[] }
  tier: 'free' | 'paid'
  sessionTokens: { input: number; output: number }
  sessionCostUsd: number | null
  lastLatencyMs: number | null
  knowledgeLoaded: boolean
  knowledgeInfo: string
  notices: Notice[]
  fontSize: number
  material: 'acrylic' | 'mica' | 'translucent'
  selfTestPattern: boolean
}

// Preload bridge exposed as window.cue
export interface CueBridge {
  onState(cb: (s: UiState) => void): () => void
  onAnswer(cb: (e: AnswerEvent) => void): () => void
  onTranscript(cb: (lines: TranscriptLine[]) => void): () => void
  onLevels(cb: (me: number, them: number) => void): () => void
  ready(): void
  ask(text: string): void
  submitApiKey(key: string): void
  exitInput(): void
  dismissNotice(id: number): void
  dragStart(): void
  dragEnd(): void
  handleHover(over: boolean): void
  resize(height: number): void
}

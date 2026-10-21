// Loads config.yaml. Kept free of Electron imports so `npm run prep` can use it too.
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { parse } from 'yaml'

export type ThinkingLevel = 'minimal' | 'low' | 'medium' | 'high'

export interface ModelQuota {
  rpm: number
  rpd: number
}

export interface CueConfig {
  meeting: { me: string; with: string; topic: string }
  sources: {
    repos: string[]
    docs: string[]
    deck: string
    claude_code: string
    codex: string
    chat_exports: string[]
  }
  keywords: string[]
  gemini: {
    tier: 'free' | 'paid'
    models: {
      brain: string
      brain_fallbacks: string[]
      fast: string
      fast_fallbacks: string[]
      ears: string
      embed: string
    }
    thinking: { live: ThinkingLevel; prep: ThinkingLevel; fast: ThinkingLevel }
    quotas: Record<string, ModelQuota>
    prices: Record<string, { input: number; output: number }>
  }
  knowledge: {
    /** Tokens of notes sent with each live question (brief + best chunks). Smaller = faster. */
    live_context_tokens: number
    /** Show the prepared qa_bank answer instantly when a question matches it. */
    instant_answers: boolean
    instant_min_confidence: number
    /** Use embeddings (one tiny API call per question) in addition to local keyword search. */
    embeddings: boolean
  }
  auto_answer: {
    enabled: boolean
    /** When to ask FAST "is this a question for me?": only for unclear lines (fast), always, or never. */
    fast: 'ambiguous' | 'always' | 'never'
    /** Wait this long after the other side stops before deciding, so follow-up sentences merge in. */
    merge_ms: number
    fast_timeout_ms: number
  }
  audio: {
    /** live = Gemini Live API (fast); chunked = one request per utterance (slower, fallback). */
    transcription: 'live' | 'chunked'
    chunked_fallback: boolean
    chunked_model: string
    /** BCP-47 hint, e.g. en-US. Empty = auto-detect. */
    language: string
    /** Extra words to recognize (your name and `keywords` are always included). */
    vocabulary: string[]
    mic_device: string
    /** loopback = Windows system audio (set Zoom's speaker to "Same as System"); none = mic only. */
    them_source: 'loopback' | 'none'
    /** Noise suppression + auto gain on the mic. */
    mic_processing: boolean
    /** false = you're on speakers: mic lines that just repeat the other side are dropped. */
    headphones: boolean
  }
  sessions: {
    /** Save Ctrl+Alt+S screenshots into the session folder. */
    save_screenshots: boolean
  }
  presentation: {
    /** The monitor showing your slides (the one you share in Zoom). */
    display: 'primary' | 'cursor' | number
    interval_ms: number
    /** Let FAST look at the screen when OCR can't tell which slide it is. */
    use_fast: boolean
  }
  screenshot: {
    /** Which monitor Ctrl+Alt+S captures: the one under the mouse, the primary, or a number. */
    display: 'cursor' | 'primary' | number
    max_width: number
  }
  ui: {
    width: number
    position: 'top-right' | 'top-left' | 'bottom-right' | 'bottom-left'
    display: 'primary' | 'cursor' | number
    margin: number
    material: 'auto' | 'acrylic' | 'mica' | 'translucent'
    font_size: number
    start_click_through: boolean
  }
  hotkeys: Record<HotkeyAction, string>
}

export type HotkeyAction =
  | 'answer_now'
  | 'screenshot_answer'
  | 'toggle_overlay'
  | 'toggle_listening'
  | 'move_up'
  | 'move_down'
  | 'move_left'
  | 'move_right'
  | 'clear'
  | 'type_mode'
  | 'presentation_mode'
  | 'click_through'

export const DEFAULT_CONFIG: CueConfig = {
  meeting: { me: 'Me', with: 'my professor', topic: 'research progress update' },
  sources: { repos: [], docs: [], deck: '', claude_code: '', codex: '', chat_exports: [] },
  keywords: [],
  gemini: {
    tier: 'free',
    models: {
      brain: 'gemini-3.6-flash',
      brain_fallbacks: ['gemini-3.8-flash', 'gemini-3.5-flash-lite'],
      fast: 'gemini-3.5-flash-lite',
      fast_fallbacks: ['gemini-3.1-flash-lite'],
      ears: 'gemini-3.5-transcribe-live',
      embed: 'gemini-embedding-001'
    },
    thinking: { live: 'low', prep: 'high', fast: 'minimal' },
    quotas: {
      'gemini-3.6-flash': { rpm: 5, rpd: 20 },
      'gemini-3.8-flash': { rpm: 5, rpd: 20 },
      'gemini-3.7-flash': { rpm: 5, rpd: 20 },
      'gemini-3.5-flash': { rpm: 5, rpd: 20 },
      'gemini-3.5-flash-lite': { rpm: 15, rpd: 500 },
      'gemini-3.1-flash-lite': { rpm: 15, rpd: 500 },
      'gemini-embedding-001': { rpm: 100, rpd: 1000 }
    },
    prices: {}
  },
  auto_answer: { enabled: true, fast: 'ambiguous', merge_ms: 900, fast_timeout_ms: 6000 },
  audio: {
    transcription: 'live',
    chunked_fallback: true,
    chunked_model: 'gemini-3.5-transcribe',
    language: 'en-US',
    vocabulary: ['Otsu', 'Dice', 'microCT', 'SCANCO', 'TD-309', 'Abaqus', 'DICOM', 'voxel', 'ROI', 'porosity', 'memmap'],
    mic_device: 'default',
    them_source: 'loopback',
    mic_processing: true,
    headphones: true
  },
  sessions: { save_screenshots: false },
  presentation: { display: 'primary', interval_ms: 3000, use_fast: true },
  screenshot: { display: 'cursor', max_width: 1600 },
  knowledge: { live_context_tokens: 6000, instant_answers: true, instant_min_confidence: 0.6, embeddings: true },
  ui: {
    width: 420,
    position: 'top-right',
    display: 'primary',
    margin: 16,
    material: 'auto',
    font_size: 17,
    start_click_through: true
  },
  hotkeys: {
    answer_now: 'Ctrl+Alt+Enter',
    screenshot_answer: 'Ctrl+Alt+S',
    toggle_overlay: 'Ctrl+Alt+H',
    toggle_listening: 'Ctrl+Alt+L',
    move_up: 'Ctrl+Alt+Shift+Up',
    move_down: 'Ctrl+Alt+Shift+Down',
    move_left: 'Ctrl+Alt+Shift+Left',
    move_right: 'Ctrl+Alt+Shift+Right',
    clear: 'Ctrl+Alt+K',
    type_mode: 'Ctrl+Alt+T',
    presentation_mode: 'Ctrl+Alt+P',
    click_through: 'Ctrl+Alt+M'
  }
}

/** Requests-per-minute/day assumed for a model that isn't listed in `gemini.quotas`. */
export const FALLBACK_QUOTA: ModelQuota = { rpm: 5, rpd: 20 }

/**
 * Expands %VARS% (case-insensitive, like cmd.exe) and a leading ~, then normalizes.
 * Unknown %VARS% are left as-is so the error message shows what was wrong.
 */
export function expandPath(p: string, env: NodeJS.ProcessEnv = process.env, platform = process.platform): string {
  if (!p) return p
  const lookup = (name: string): string | undefined => {
    if (env[name] !== undefined) return env[name]
    const key = Object.keys(env).find((k) => k.toLowerCase() === name.toLowerCase())
    return key ? env[key] : undefined
  }
  let out = p.trim().replace(/%([^%\s]+)%/g, (m, name: string) => lookup(name) ?? m)
  if (out === '~' || out.startsWith('~/') || out.startsWith('~\\')) {
    out = (lookup(platform === 'win32' ? 'USERPROFILE' : 'HOME') ?? homedir()) + out.slice(1)
  }
  const impl = platform === 'win32' ? path.win32 : path.posix
  // Keep a trailing separator off so path.join / readdir behave the same either way.
  let norm = impl.normalize(out)
  if (norm.length > 3 && /[\\/]$/.test(norm)) norm = norm.slice(0, -1)
  return norm
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function merge<T>(base: T, over: unknown): T {
  if (!isObject(base) || !isObject(over)) return (over === undefined || over === null ? base : over) as T
  const out: Record<string, unknown> = { ...base }
  for (const [k, v] of Object.entries(over)) {
    out[k] = k in out ? merge(out[k], v) : v
  }
  return out as T
}

const asList = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x.trim()).map(String) : typeof v === 'string' && v.trim() ? [v] : []

export class ConfigError extends Error {}

export function loadConfig(root: string): { config: CueConfig; file: string } {
  const file = path.join(root, 'config.yaml')
  if (!existsSync(file)) return { config: structuredClone(DEFAULT_CONFIG), file }
  let raw: unknown
  try {
    raw = parse(readFileSync(file, 'utf8'))
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    const hint = /escape/i.test(msg)
      ? ' Windows paths inside "double quotes" need \\\\ for every backslash. Use single quotes instead.'
      : ''
    throw new ConfigError(`config.yaml: ${msg.split('\n')[0]}.${hint}`)
  }
  const config = merge(structuredClone(DEFAULT_CONFIG), raw ?? {})

  config.sources.repos = asList(config.sources.repos).map((p) => expandPath(p))
  config.sources.docs = asList(config.sources.docs).map((p) => expandPath(p))
  config.sources.chat_exports = asList(config.sources.chat_exports).map((p) => expandPath(p))
  config.sources.deck = expandPath(config.sources.deck ?? '')
  config.sources.claude_code = expandPath(config.sources.claude_code ?? '')
  config.sources.codex = expandPath(config.sources.codex ?? '')
  config.keywords = asList(config.keywords)
  config.audio.vocabulary = asList(config.audio.vocabulary)
  if (config.audio.transcription !== 'chunked') config.audio.transcription = 'live'
  config.gemini.models.brain_fallbacks = asList(config.gemini.models.brain_fallbacks)
  config.gemini.models.fast_fallbacks = asList(config.gemini.models.fast_fallbacks)
  if (config.gemini.tier !== 'paid') config.gemini.tier = 'free'

  const presDisplay = config.presentation.display as unknown
  if (typeof presDisplay === 'string' && /^\d+$/.test(presDisplay)) config.presentation.display = Number(presDisplay)
  const shotDisplay = config.screenshot.display as unknown
  if (typeof shotDisplay === 'string' && /^\d+$/.test(shotDisplay)) config.screenshot.display = Number(shotDisplay)
  const display = config.ui.display as unknown
  if (typeof display === 'string' && /^\d+$/.test(display)) config.ui.display = Number(display)
  return { config, file }
}

export function quotaFor(config: CueConfig, model: string): ModelQuota {
  return config.gemini.quotas[model] ?? FALLBACK_QUOTA
}

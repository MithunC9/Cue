// Free-tier request budgeting.
//
// Google enforces per-model requests-per-minute and requests-per-day limits on free keys, with the
// daily counter resetting at midnight Pacific. Cue tracks its own usage so it can (a) avoid sending a
// request that would be rejected, (b) fall back to the next model in the chain when one runs dry, and
// (c) show what's left in the status bar. A 429 from Google always wins over the local estimate.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { ModelQuota } from '../config'
import type { QuotaUsage } from '../../shared/types'

interface PersistedState {
  day: string
  used: Record<string, number>
  blockedUntil: Record<string, number>
}

export function pacificDay(now = Date.now()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(new Date(now))
}

/** Epoch ms of the next midnight in America/Los_Angeles. */
export function nextPacificMidnight(now = Date.now()): number {
  const today = pacificDay(now)
  // Step forward in 15-minute increments until the Pacific date changes; DST-safe and cheap.
  let t = now - (now % (15 * 60_000)) + 15 * 60_000
  while (pacificDay(t) === today) t += 15 * 60_000
  // Back up to the exact minute the date flipped.
  let lo = t - 15 * 60_000
  while (t - lo > 60_000) {
    const mid = lo + Math.floor((t - lo) / 2)
    if (pacificDay(mid) === today) lo = mid
    else t = mid
  }
  return t - (t % 60_000)
}

export interface QuotaCheck {
  ok: boolean
  waitMs: number // >0 when only the per-minute window is full
  reason?: string
}

export class QuotaManager {
  private state: PersistedState
  private minute = new Map<string, number[]>()

  constructor(
    private quotaFor: (model: string) => ModelQuota,
    private file: string | null,
    private now: () => number = Date.now
  ) {
    this.state = this.load()
  }

  private load(): PersistedState {
    const fresh: PersistedState = { day: pacificDay(this.now()), used: {}, blockedUntil: {} }
    if (!this.file || !existsSync(this.file)) return fresh
    try {
      const s = JSON.parse(readFileSync(this.file, 'utf8')) as PersistedState
      return s.day === fresh.day ? { ...fresh, ...s } : { ...fresh, blockedUntil: s.blockedUntil ?? {} }
    } catch {
      return fresh
    }
  }

  private save(): void {
    if (!this.file) return
    try {
      mkdirSync(path.dirname(this.file), { recursive: true })
      writeFileSync(this.file, JSON.stringify(this.state))
    } catch {
      // non-fatal
    }
  }

  private rollDay(): void {
    const day = pacificDay(this.now())
    if (day !== this.state.day) {
      this.state = { day, used: {}, blockedUntil: this.state.blockedUntil }
      this.save()
    }
  }

  check(model: string): QuotaCheck {
    this.rollDay()
    const t = this.now()
    const blocked = this.state.blockedUntil[model]
    if (blocked && blocked > t) return { ok: false, waitMs: blocked - t, reason: 'rate-limited by Google' }
    const q = this.quotaFor(model)
    const used = this.state.used[model] ?? 0
    if (used >= q.rpd) return { ok: false, waitMs: nextPacificMidnight(t) - t, reason: `daily budget used (${used}/${q.rpd})` }
    const recent = (this.minute.get(model) ?? []).filter((x) => t - x < 60_000)
    this.minute.set(model, recent)
    if (recent.length >= q.rpm) return { ok: false, waitMs: 60_000 - (t - recent[0]), reason: `per-minute budget (${q.rpm}/min)` }
    return { ok: true, waitMs: 0 }
  }

  record(model: string): void {
    this.rollDay()
    this.state.used[model] = (this.state.used[model] ?? 0) + 1
    const recent = this.minute.get(model) ?? []
    recent.push(this.now())
    this.minute.set(model, recent)
    this.save()
  }

  /** Called after Google returns 429/503 for this model. */
  block(model: string, untilMs: number): void {
    this.state.blockedUntil[model] = untilMs
    this.save()
  }

  usage(models: string[]): QuotaUsage[] {
    this.rollDay()
    const t = this.now()
    return [...new Set(models)].map((model) => {
      const b = this.state.blockedUntil[model]
      return {
        model,
        usedToday: this.state.used[model] ?? 0,
        rpd: this.quotaFor(model).rpd,
        blockedUntil: b && b > t ? b : null
      }
    })
  }
}

export interface ParsedApiError {
  status: number | null
  retryAfterMs: number | null
  daily: boolean
  message: string
}

/** Pulls status, RetryInfo.retryDelay and "PerDay" quota ids out of an SDK ApiError. */
export function parseApiError(err: unknown): ParsedApiError {
  const anyErr = err as { status?: number; message?: string }
  const message = anyErr?.message ?? String(err)
  let status = typeof anyErr?.status === 'number' ? anyErr.status : null
  if (status === null) {
    const m = /"code"\s*:\s*(\d{3})|status:\s*(\d{3})/.exec(message)
    if (m) status = Number(m[1] ?? m[2])
  }
  let retryAfterMs: number | null = null
  // Quotes may be escaped when Google nests one error JSON inside another's "message".
  const delay = /\\?"retryDelay\\?"\s*:\s*\\?"(\d+(?:\.\d+)?)s/.exec(message)
  if (delay) retryAfterMs = Math.ceil(Number(delay[1]) * 1000)
  const daily = /PerDay/i.test(message)
  let human = message
  for (let depth = 0; depth < 3; depth++) {
    const inner = /"message"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(human)
    if (!inner) break
    try {
      human = JSON.parse(`"${inner[1]}"`)
    } catch {
      human = inner[1]
      break
    }
    if (!human.trimStart().startsWith('{')) break
  }
  return { status, retryAfterMs, daily, message: human.trim() }
}

export class AllModelsExhaustedError extends Error {
  constructor(public details: string[]) {
    super(`No model available: ${details.join('; ')}`)
  }
}

export interface FallbackOptions {
  /** Wait up to this long for a per-minute slot before moving on to the next model. */
  maxWaitMs: number
  signal?: AbortSignal
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms)
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t)
        reject(signal.reason ?? new Error('aborted'))
      },
      { once: true }
    )
  })

/**
 * Runs `fn` with the first model in `chain` that has budget. On 429 (quota) or 503 (overloaded)
 * the model is blocked for the period Google asks for and the next model is tried.
 */
export async function withFallback<T>(
  quota: QuotaManager,
  chain: string[],
  fn: (model: string) => Promise<T>,
  opts: FallbackOptions
): Promise<{ model: string; value: T }> {
  const skipped: string[] = []
  for (const model of [...new Set(chain)]) {
    let c = quota.check(model)
    if (!c.ok && c.waitMs <= opts.maxWaitMs && c.reason?.startsWith('per-minute')) {
      await sleep(c.waitMs + 50, opts.signal)
      c = quota.check(model)
    }
    if (!c.ok) {
      skipped.push(`${model}: ${c.reason}`)
      continue
    }
    quota.record(model)
    try {
      return { model, value: await fn(model) }
    } catch (err) {
      if (opts.signal?.aborted) throw err
      const e = parseApiError(err)
      const now = Date.now()
      if (e.status === 429 || e.status === 500 || e.status === 503 || e.status === 504) {
        const until = e.status === 429 && e.daily ? nextPacificMidnight(now) : now + (e.retryAfterMs ?? (e.status === 429 ? 60_000 : 15_000))
        quota.block(model, until)
        skipped.push(`${model}: ${e.status === 429 ? 'quota' : 'overloaded'} (HTTP ${e.status})`)
        continue
      }
      if (e.status === null) {
        // Network drop or a stream cut off before its first token: try the next model.
        skipped.push(`${model}: ${e.message.slice(0, 80)}`)
        continue
      }
      throw err
    }
  }
  throw new AllModelsExhaustedError(skipped)
}

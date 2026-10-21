import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { expandPath, loadConfig } from '../src/main/config'
import { streamBrain } from '../src/main/gemini/brain'
import type { Gemini } from '../src/main/gemini/client'
import {
  AllModelsExhaustedError,
  QuotaManager,
  nextPacificMidnight,
  pacificDay,
  parseApiError,
  withFallback
} from '../src/main/gemini/quota'

const quota429Daily = Object.assign(
  new Error(
    'got status: 429 Too Many Requests. {"error":{"code":429,"message":"You exceeded your current quota.","status":"RESOURCE_EXHAUSTED","details":[{"@type":"type.googleapis.com/google.rpc.QuotaFailure","violations":[{"quotaMetric":"generativelanguage.googleapis.com/generate_content_free_tier_requests","quotaId":"GenerateRequestsPerDayPerProjectPerModel-FreeTier"}]},{"@type":"type.googleapis.com/google.rpc.RetryInfo","retryDelay":"37s"}]}}'
  ),
  { status: 429 }
)

test('expandPath handles %USERPROFILE%, spaces and trailing backslashes (Windows rules)', () => {
  const env = { userprofile: 'C:\\Users\\Mithun Test' }
  assert.equal(
    expandPath('%USERPROFILE%\\.claude\\projects\\My Repo\\', env, 'win32'),
    'C:\\Users\\Mithun Test\\.claude\\projects\\My Repo'
  )
  assert.equal(expandPath('~\\.codex\\sessions', { USERPROFILE: 'C:\\Users\\M' }, 'win32'), 'C:\\Users\\M\\.codex\\sessions')
  assert.equal(expandPath('%NOPE%\\x', {}, 'win32'), '%NOPE%\\x')
  assert.equal(expandPath('C:/Users/M/repo', {}, 'win32'), 'C:\\Users\\M\\repo')
})

test('loadConfig merges defaults and reports bad Windows escapes helpfully', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'cue-'))
  writeFileSync(path.join(dir, 'config.yaml'), "gemini:\n  tier: free\nsources:\n  repos: 'C:\\code\\repo'\n")
  const { config } = loadConfig(dir)
  assert.equal(config.gemini.models.brain, 'gemini-3.6-flash')
  assert.equal(config.sources.repos.length, 1)
  assert.equal(config.hotkeys.answer_now, 'Ctrl+Alt+Enter')

  writeFileSync(path.join(dir, 'config.yaml'), 'sources:\n  deck: "C:\\Users\\x.pptx"\n')
  assert.throws(() => loadConfig(dir), /single quotes/)
})

test('pacific day and next midnight', () => {
  // 2026-10-21 06:59 UTC = 23:59 PDT on Oct 20
  const t = Date.UTC(2026, 9, 21, 6, 59)
  assert.equal(pacificDay(t), '2026-10-20')
  assert.equal(nextPacificMidnight(t), Date.UTC(2026, 9, 21, 7, 0))
  // across the November DST change (PST = UTC-8)
  assert.equal(nextPacificMidnight(Date.UTC(2026, 10, 5, 12)), Date.UTC(2026, 10, 6, 8, 0))
})

test('QuotaManager enforces rpm and rpd', () => {
  let now = Date.UTC(2026, 9, 21, 18)
  const q = new QuotaManager(() => ({ rpm: 2, rpd: 3 }), null, () => now)
  assert.ok(q.check('m').ok)
  q.record('m')
  q.record('m')
  const c = q.check('m')
  assert.equal(c.ok, false)
  assert.match(c.reason ?? '', /per-minute/)
  now += 61_000
  assert.ok(q.check('m').ok)
  q.record('m')
  assert.match(q.check('m').reason ?? '', /daily/)
  now += 24 * 3600_000
  assert.ok(q.check('m').ok, 'resets the next Pacific day')
})

test('parseApiError reads status, retry delay and daily quota', () => {
  const e = parseApiError(quota429Daily)
  assert.equal(e.status, 429)
  assert.equal(e.retryAfterMs, 37_000)
  assert.equal(e.daily, true)
  assert.equal(e.message, 'You exceeded your current quota.')
})

test('withFallback moves to the next model on 429 and blocks the exhausted one', async () => {
  const q = new QuotaManager(() => ({ rpm: 10, rpd: 100 }), null)
  const calls: string[] = []
  const r = await withFallback(
    q,
    ['a', 'b'],
    async (m) => {
      calls.push(m)
      if (m === 'a') throw quota429Daily
      return 'ok'
    },
    { maxWaitMs: 0 }
  )
  assert.deepEqual(calls, ['a', 'b'])
  assert.equal(r.model, 'b')
  assert.equal(q.check('a').ok, false)
  await assert.rejects(
    withFallback(q, ['a'], async () => 'x', { maxWaitMs: 0 }),
    (err: unknown) => err instanceof AllModelsExhaustedError
  )
})

function fakeGem(handler: (model: string, config: Record<string, unknown>) => AsyncGenerator<{ text?: string; usageMetadata?: object }>) {
  const usage: number[] = []
  const gem = {
    ai: {
      models: {
        generateContentStream: async ({ model, config }: { model: string; config: Record<string, unknown> }) => handler(model, config)
      }
    },
    quota: new QuotaManager(() => ({ rpm: 10, rpd: 100 }), null),
    addUsage: (_m: string, i: number, o: number) => usage.push(i, o)
  }
  return { gem: gem as unknown as Gemini, usage }
}

test('streamBrain streams text, falls back on 429 at first chunk, retries without thinking on 400', async () => {
  const seen: string[] = []
  const { gem, usage } = fakeGem(async function* (model, config) {
    seen.push(`${model}:${config.thinkingConfig ? 'think' : 'plain'}`)
    if (model === 'primary') throw quota429Daily
    if (config.thinkingConfig) throw Object.assign(new Error('{"error":{"code":400,"message":"thinking_level is not supported"}}'), { status: 400 })
    yield { text: '**Yes**\n' }
    yield { text: '• 12 µm voxels', usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20, thoughtsTokenCount: 5 } }
  })
  const deltas: string[] = []
  const r = await streamBrain(gem, {
    system: 's',
    contents: [{ role: 'user', parts: [{ text: 'q' }] }],
    thinking: 'low',
    chain: ['primary', 'backup'],
    signal: new AbortController().signal,
    maxWaitMs: 0,
    onText: (t) => deltas.push(t)
  })
  assert.deepEqual(seen, ['primary:think', 'backup:think', 'backup:plain'])
  assert.equal(r.model, 'backup')
  assert.equal(r.text, '**Yes**\n• 12 µm voxels')
  assert.deepEqual(deltas, ['**Yes**\n', '**Yes**\n• 12 µm voxels'])
  assert.deepEqual(usage, [100, 25])
})

test('parseApiError unwraps nested error JSON and escaped retry delays', () => {
  const inner = JSON.stringify({ error: { code: 503, message: 'This model is currently experiencing high demand.', status: 'UNAVAILABLE', details: [{ retryDelay: '12s' }] } }, null, 2)
  const outer = Object.assign(new Error(JSON.stringify({ error: { message: inner, code: 503, status: 'Service Unavailable' } })), { status: 503 })
  const e = parseApiError(outer)
  assert.equal(e.status, 503)
  assert.equal(e.message, 'This model is currently experiencing high demand.')
  assert.equal(e.retryAfterMs, 12_000)
})

test('withFallback treats a stream cut off before the first token as retryable', async () => {
  const q = new QuotaManager(() => ({ rpm: 10, rpd: 100 }), null)
  const r = await withFallback(
    q,
    ['a', 'b'],
    async (m) => {
      if (m === 'a') throw new Error('Incomplete JSON segment at the end')
      return 'ok'
    },
    { maxWaitMs: 0 }
  )
  assert.equal(r.model, 'b')
  assert.ok(q.check('a').ok, 'a network/parse failure does not block the model')
})

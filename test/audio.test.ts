import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { test } from 'node:test'
import { Ears, wav } from '../src/main/audio/ears'
import { Listener } from '../src/main/audio/listener'
import { DEFAULT_CONFIG } from '../src/main/config'
import { MeetingContext } from '../src/main/context'
import type { Gemini } from '../src/main/gemini/client'
import { QuotaManager } from '../src/main/gemini/quota'
import { Vad, rms } from '../src/shared/vad'

const frame = (amp: number) => Int16Array.from({ length: 320 }, (_, i) => Math.round(amp * 32767 * Math.sin(i / 3)))

test('VAD: ignores silence and clicks, catches speech with pre-roll, ends after the hangover', () => {
  const vad = new Vad()
  for (let i = 0; i < 50; i++) assert.equal(vad.push(frame(0.0005)).started, false)
  // a single click is not speech
  assert.equal(vad.push(frame(0.3)).started, false)
  for (let i = 0; i < 10; i++) vad.push(frame(0.0005))
  let started = null
  for (let i = 0; i < 10 && !started; i++) {
    const r = vad.push(frame(0.1))
    if (r.started) started = r
  }
  assert.ok(started, 'speech starts')
  assert.ok(started!.send.length >= 16, `pre-roll included (${started!.send.length} frames)`)
  let ended = false
  let quietFrames = 0
  for (let i = 0; i < 100 && !ended; i++) {
    ended = vad.push(frame(0.0005)).ended
    quietFrames++
  }
  assert.ok(ended)
  assert.equal(quietFrames, 35, '700 ms hangover = 35 frames of 20 ms')
  assert.ok(Math.abs(rms(frame(0.1)) - 0.0707) < 0.01)
})

test('wav header is a valid 16 kHz mono PCM RIFF', () => {
  const w = wav(Buffer.alloc(3200))
  assert.equal(w.toString('ascii', 0, 4), 'RIFF')
  assert.equal(w.readUInt32LE(24), 16000)
  assert.equal(w.readUInt16LE(22), 1)
  assert.equal(w.length, 44 + 3200)
})

interface FakeSession {
  sent: unknown[]
  closed: boolean
  callbacks: { onmessage: (m: unknown) => void; onclose: (e: { code: number; reason: string }) => void }
}

function fakeGem(opts: { failConnect?: number } = {}) {
  const sessions: FakeSession[] = []
  let fails = opts.failConnect ?? 0
  const chunked: string[] = []
  const gem = {
    quota: new QuotaManager(() => ({ rpm: 100, rpd: 1000 }), null),
    ai: {
      live: {
        connect: async ({ callbacks }: { callbacks: FakeSession['callbacks'] }) => {
          await new Promise((r) => setTimeout(r, 5))
          if (fails > 0) {
            fails--
            throw Object.assign(new Error('{"error":{"code":503,"message":"unavailable"}}'), { status: 503 })
          }
          const s: FakeSession = { sent: [], closed: false, callbacks }
          sessions.push(s)
          return {
            sendRealtimeInput: (m: unknown) => s.sent.push(m),
            close: () => {
              s.closed = true
            }
          }
        }
      },
      models: {
        generateContent: async () => {
          chunked.push('call')
          return { candidates: [{ content: { parts: [{ audioTranscription: { text: 'chunked transcript' } }] } }] }
        }
      }
    }
  }
  return { gem: gem as unknown as Gemini, sessions, chunked }
}

const cfg = () => structuredClone(DEFAULT_CONFIG)
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms))
const pcm = (n = 640) => Buffer.alloc(n, 1)

test('Ears: connects on speech, replays audio sent while connecting, ends the utterance, emits the final', async () => {
  const { gem, sessions } = fakeGem()
  const ears = new Ears('THEM', () => gem, cfg)
  const finals: string[] = []
  ears.on('final', (t) => finals.push(t))
  ears.start()
  ears.utteranceStart()
  ears.audio(pcm())
  ears.audio(pcm())
  await tick()
  assert.equal(sessions.length, 1)
  assert.equal(sessions[0].sent.length, 2, 'audio buffered during connect is replayed')
  ears.audio(pcm())
  ears.endUtterance()
  assert.deepEqual(sessions[0].sent.at(-1), { audioStreamEnd: true })
  sessions[0].callbacks.onmessage({ serverContent: { inputTranscription: { text: 'How did you validate it?' } } })
  assert.deepEqual(finals, ['How did you validate it?'])
  // idle close from the server (~60 s without audio) is normal: no reconnect
  sessions[0].callbacks.onclose({ code: 1008, reason: 'The operation was aborted.' })
  await tick()
  assert.equal(sessions.length, 1)
  // next utterance opens a fresh connection
  ears.utteranceStart()
  ears.audio(pcm())
  await tick()
  assert.equal(sessions.length, 2)
  ears.stop()
})

test('Ears: a connection dropped mid-utterance is replaced and the utterance replayed', async () => {
  const { gem, sessions } = fakeGem()
  const ears = new Ears('ME', () => gem, cfg)
  ears.start()
  ears.utteranceStart()
  ears.audio(pcm())
  await tick()
  ears.audio(pcm())
  ears.audio(pcm())
  sessions[0].callbacks.onclose({ code: 1011, reason: 'internal error' })
  await tick()
  assert.equal(sessions.length, 2)
  assert.equal(sessions[1].sent.length, 3, 'all audio of the utterance replayed into the new connection')
  ears.stop()
})

test('Ears: interim text becomes the final if the server never finalizes', async () => {
  const { gem, sessions } = fakeGem()
  const ears = new Ears('THEM', () => gem, cfg)
  const finals: string[] = []
  ears.on('final', (t) => finals.push(t))
  ears.start()
  ears.utteranceStart()
  ears.audio(pcm())
  await tick()
  sessions[0].callbacks.onmessage({ serverContent: { interimInputTranscription: { text: 'what about the' } } })
  ears.endUtterance()
  await tick(4200)
  assert.deepEqual(finals, ['what about the'])
  ears.stop()
})

test('Ears: goAway closes the connection after the current utterance', async () => {
  const { gem, sessions } = fakeGem()
  const ears = new Ears('THEM', () => gem, cfg)
  ears.start()
  ears.utteranceStart()
  ears.audio(pcm())
  await tick()
  sessions[0].callbacks.onmessage({ goAway: { timeLeft: '10s' } })
  assert.equal(sessions[0].closed, false, 'not while someone is talking')
  ears.endUtterance()
  sessions[0].callbacks.onmessage({ serverContent: { inputTranscription: { text: 'done' } } })
  assert.equal(sessions[0].closed, true)
  ears.stop()
})

test('Ears: falls back to per-utterance transcription after repeated connect failures', async () => {
  const { gem, chunked } = fakeGem({ failConnect: 10 })
  const ears = new Ears('THEM', () => gem, cfg)
  const finals: string[] = []
  const states: string[] = []
  ears.on('final', (t) => finals.push(t))
  ears.on('state', (s, d) => states.push(`${s}:${d}`))
  ears.start()
  ears.utteranceStart()
  ears.audio(pcm(16000 * 2))
  await tick(50)
  for (let i = 0; i < 3 && ears.mode === 'live'; i++) await tick(i === 0 ? 1100 : 2100)
  assert.equal(ears.mode, 'chunked')
  ears.endUtterance()
  await tick(30)
  assert.equal(chunked.length, 1)
  assert.deepEqual(finals, ['chunked transcript'])
  assert.ok(states.some((s) => /per-utterance/.test(s)))
  ears.stop()
})

test('Listener: on speakers, mic lines that repeat the other side are dropped', async () => {
  const capture = new EventEmitter() as unknown as ConstructorParameters<typeof Listener>[0]
  const ctx = new MeetingContext()
  const c = cfg()
  c.audio.headphones = false
  const { gem } = fakeGem()
  const l = new Listener(capture, () => gem, () => c, ctx, () => 'default')
  const utterances: string[] = []
  l.on('utterance', (s, t) => utterances.push(`${s}:${t}`))
  l.them.emit('final', 'How did you validate the segmentation against ground truth?')
  l.me.emit('interim', 'how did you validate the segmentation')
  l.me.emit('final', 'How did you validate the segmentation against ground truth')
  l.me.emit('final', 'I compared against manual tracings from the lab tech.')
  assert.deepEqual(
    ctx.lastLines(10).map((x) => `${x.speaker}:${x.text}`),
    ['THEM:How did you validate the segmentation against ground truth?', 'ME:I compared against manual tracings from the lab tech.']
  )
  assert.equal(utterances.length, 2)
})

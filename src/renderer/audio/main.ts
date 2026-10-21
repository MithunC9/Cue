// Hidden audio window: captures the mic (ME) and Windows system-audio loopback (THEM = Zoom's
// output), resamples both to 16 kHz mono int16, runs VAD, and streams only speech to the main process.
import type { AudioBridge, AudioStartOptions } from '../../shared/audio'
import type { Speaker } from '../../shared/types'
import { Vad, rms } from '../../shared/vad'

declare global {
  interface Window {
    cueAudio: AudioBridge
  }
}

const bridge = window.cueAudio
const FRAME = 320 // 20 ms at 16 kHz

// AudioWorklet: Float32 → 20 ms int16 frames. Loaded from a blob so it works in dev and packaged builds.
const WORKLET = `
class PcmCapture extends AudioWorkletProcessor {
  constructor() { super(); this.buf = new Int16Array(${FRAME}); this.n = 0 }
  process(inputs) {
    // No input (source ended or device gone) counts as silence, so VAD can close the utterance.
    const ch = (inputs[0] && inputs[0][0]) || this.silence || (this.silence = new Float32Array(128))
    for (let i = 0; i < ch.length; i++) {
      const s = Math.max(-1, Math.min(1, ch[i]))
      this.buf[this.n++] = s < 0 ? s * 0x8000 : s * 0x7fff
      if (this.n === ${FRAME}) { this.port.postMessage(this.buf.buffer, [this.buf.buffer]); this.buf = new Int16Array(${FRAME}); this.n = 0 }
    }
    return true
  }
}
registerProcessor('pcm-capture', PcmCapture)`

interface Pipe {
  speaker: Speaker
  vad: Vad
  pending: Int16Array[]
  level: number
  stop: () => void
}

let ctx: AudioContext | null = null
const pipes: Pipe[] = []
let flushTimer: number | undefined
let levelTimer: number | undefined

async function ensureContext(): Promise<AudioContext> {
  if (ctx) return ctx
  // A 16 kHz context: Chromium resamples the 44.1/48 kHz devices for us.
  ctx = new AudioContext({ sampleRate: 16000, latencyHint: 'interactive' })
  await ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' })))
  return ctx
}

function attach(speaker: Speaker, source: AudioNode, stop: () => void): void {
  const c = ctx!
  const node = new AudioWorkletNode(c, 'pcm-capture', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1, channelCountMode: 'explicit', channelInterpretation: 'speakers' })
  const pipe: Pipe = { speaker, vad: new Vad(), pending: [], level: 0, stop: () => {} }
  node.port.onmessage = (e: MessageEvent<ArrayBuffer>) => {
    const frame = new Int16Array(e.data)
    const level = rms(frame)
    pipe.level = Math.max(level, pipe.level * 0.85)
    const r = pipe.vad.push(frame, level)
    if (r.started) bridge.utteranceStart(speaker)
    if (r.send.length) pipe.pending.push(...r.send)
    if (r.ended) {
      flush(pipe)
      bridge.utteranceEnd(speaker)
    }
  }
  source.connect(node)
  // The worklet must be pulled by the graph; route it into a muted gain so nothing is audible.
  const mute = c.createGain()
  mute.gain.value = 0
  node.connect(mute).connect(c.destination)
  pipe.stop = () => {
    stop()
    try {
      source.disconnect()
      node.disconnect()
    } catch {
      /* already gone */
    }
  }
  pipes.push(pipe)
}

function flush(pipe: Pipe): void {
  if (!pipe.pending.length) return
  const total = pipe.pending.reduce((n, f) => n + f.length, 0)
  const out = new Int16Array(total)
  let o = 0
  for (const f of pipe.pending) {
    out.set(f, o)
    o += f.length
  }
  pipe.pending = []
  bridge.frames(pipe.speaker, out.buffer)
}

async function micSource(opts: AudioStartOptions): Promise<{ node: AudioNode; stop: () => void }> {
  const proc = opts.micProcessing
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      deviceId: opts.micDeviceId && opts.micDeviceId !== 'default' ? { exact: opts.micDeviceId } : undefined,
      channelCount: 1,
      echoCancellation: false, // Chromium AEC can't see Zoom's playback anyway; it only adds artifacts
      noiseSuppression: proc,
      autoGainControl: proc
    }
  })
  const node = ctx!.createMediaStreamSource(stream)
  return { node, stop: () => stream.getTracks().forEach((t) => t.stop()) }
}

async function loopbackSource(): Promise<{ node: AudioNode; stop: () => void }> {
  // The main process answers getDisplayMedia with { audio: 'loopback' }: WASAPI loopback of the
  // default output device on Windows. The video track is required by the API; drop it at once.
  const stream = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: { width: 1, height: 1, frameRate: 1 } })
  stream.getVideoTracks().forEach((t) => t.stop())
  if (!stream.getAudioTracks().length) throw new Error('System audio capture returned no audio track')
  const node = ctx!.createMediaStreamSource(new MediaStream(stream.getAudioTracks()))
  return { node, stop: () => stream.getTracks().forEach((t) => t.stop()) }
}

/** Testing aid: "<path>@<seconds>" plays a WAV into the pipeline after a delay, once. */
async function fileSource(spec: string): Promise<{ node: AudioNode; stop: () => void }> {
  const [file, at] = spec.split('@')
  const buf = await ctx!.decodeAudioData(await bridge.readTestFile(file))
  const src = ctx!.createBufferSource()
  src.buffer = buf
  src.start(ctx!.currentTime + Number(at || 0))
  return { node: src, stop: () => src.stop() }
}

async function start(opts: AudioStartOptions): Promise<void> {
  await stop()
  try {
    const c = await ensureContext()
    if (c.state === 'suspended') await c.resume()
    const me = opts.testMe ? await fileSource(opts.testMe) : await micSource(opts)
    attach('ME', me.node, me.stop)
    if (opts.testThem) {
      const them = await fileSource(opts.testThem)
      attach('THEM', them.node, them.stop)
    } else if (opts.them === 'loopback') {
      try {
        const them = await loopbackSource()
        attach('THEM', them.node, them.stop)
      } catch (err) {
        bridge.status('error', `Zoom audio (system loopback) unavailable: ${(err as Error).message}. Transcribing your mic only.`)
      }
    }
    flushTimer = window.setInterval(() => pipes.forEach(flush), 100)
    levelTimer = window.setInterval(() => {
      const me = pipes.find((p) => p.speaker === 'ME')?.level ?? 0
      const them = pipes.find((p) => p.speaker === 'THEM')?.level ?? 0
      bridge.levels(me, them)
    }, 150)
    bridge.status('started', pipes.map((p) => p.speaker).join('+'))
  } catch (err) {
    await stop()
    const e = err as DOMException
    const hint =
      e.name === 'NotAllowedError'
        ? 'Microphone blocked. Windows Settings → Privacy & security → Microphone → allow desktop apps.'
        : e.name === 'NotFoundError' || e.name === 'OverconstrainedError'
          ? 'Selected microphone not found. Pick another one from the tray menu.'
          : e.message
    bridge.status('error', hint)
  }
}

async function stop(): Promise<void> {
  window.clearInterval(flushTimer)
  window.clearInterval(levelTimer)
  for (const p of pipes.splice(0)) {
    if (p.vad.flush()) {
      flush(p)
      bridge.utteranceEnd(p.speaker)
    }
    p.stop()
  }
  bridge.status('stopped', '')
}

async function listDevices(): Promise<void> {
  try {
    const all = await navigator.mediaDevices.enumerateDevices()
    bridge.devices(all.filter((d) => d.kind === 'audioinput').map((d) => ({ deviceId: d.deviceId, label: d.label || 'Microphone' })))
  } catch {
    bridge.devices([])
  }
}

navigator.mediaDevices.addEventListener('devicechange', () => void listDevices())
bridge.onCommand((cmd) => {
  if (cmd.type === 'start') void start(cmd.options)
  else if (cmd.type === 'stop') void stop()
  else void listDevices()
})
void listDevices()

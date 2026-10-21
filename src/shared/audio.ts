// Messages between the hidden audio window and the main process.
import type { Speaker } from './types'

export interface AudioStartOptions {
  micDeviceId: string // 'default' or a deviceId
  /** THEM source: Windows system-audio loopback (Zoom's output), nothing, or a WAV for testing. */
  them: 'loopback' | 'none'
  /** Debug/testing: play these WAVs into the pipeline instead of real devices. "<path>@<startSeconds>" */
  testMe?: string
  testThem?: string
  micProcessing: boolean
}

export interface AudioDevice {
  deviceId: string
  label: string
}

export interface AudioBridge {
  onCommand(cb: (cmd: { type: 'start'; options: AudioStartOptions } | { type: 'stop' } | { type: 'devices' }) => void): void
  frames(speaker: Speaker, pcm: ArrayBuffer): void
  utteranceStart(speaker: Speaker): void
  utteranceEnd(speaker: Speaker): void
  levels(me: number, them: number): void
  status(state: 'started' | 'stopped' | 'error', detail: string): void
  devices(list: AudioDevice[]): void
  readTestFile(path: string): Promise<ArrayBuffer>
}

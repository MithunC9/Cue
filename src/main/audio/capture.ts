// Owns the hidden audio window (src/renderer/audio) and relays its IPC.
import { BrowserWindow, desktopCapturer, ipcMain, session } from 'electron'
import { EventEmitter } from 'node:events'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import type { AudioDevice, AudioStartOptions } from '../../shared/audio'
import type { Speaker } from '../../shared/types'
import { log } from '../log'

export interface CaptureEvents {
  frames: [speaker: Speaker, pcm: Buffer]
  utteranceStart: [speaker: Speaker]
  utteranceEnd: [speaker: Speaker]
  levels: [me: number, them: number]
  status: [state: 'started' | 'stopped' | 'error', detail: string]
  devices: [list: AudioDevice[]]
}

const PARTITION = 'cue-audio'

export class AudioCapture extends EventEmitter<CaptureEvents> {
  private win: BrowserWindow | null = null
  private ready: Promise<void> | null = null
  devices: AudioDevice[] = []
  /** Test WAVs the window may read (only set from CUE_TEST_* environment variables). */
  private allowedFiles = new Set<string>()

  constructor(private preload: string, private page: () => Promise<void> | void) {
    super()
    ipcMain.on('audio:frames', (e, speaker: Speaker, pcm: ArrayBuffer) => this.fromAudio(e) && this.emit('frames', speaker, Buffer.from(pcm)))
    ipcMain.on('audio:utterance-start', (e, speaker: Speaker) => this.fromAudio(e) && this.emit('utteranceStart', speaker))
    ipcMain.on('audio:utterance-end', (e, speaker: Speaker) => this.fromAudio(e) && this.emit('utteranceEnd', speaker))
    ipcMain.on('audio:levels', (e, me: number, them: number) => this.fromAudio(e) && this.emit('levels', me, them))
    ipcMain.on('audio:status', (e, state: 'started' | 'stopped' | 'error', detail: string) => {
      if (!this.fromAudio(e)) return
      if (state === 'error') log.warn('audio:', detail)
      this.emit('status', state, detail)
    })
    ipcMain.on('audio:devices', (e, list: AudioDevice[]) => {
      if (!this.fromAudio(e)) return
      this.devices = list
      this.emit('devices', list)
    })
    ipcMain.handle('audio:read-test-file', async (e, file: string) => {
      if (!this.fromAudio(e) || !this.allowedFiles.has(path.resolve(file))) throw new Error('not allowed')
      const b = await readFile(file)
      return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)
    })
  }

  private fromAudio(e: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent): boolean {
    return !!this.win && !this.win.isDestroyed() && e.sender === this.win.webContents
  }

  private ensureWindow(): Promise<void> {
    if (this.ready && this.win && !this.win.isDestroyed()) return this.ready
    const ses = session.fromPartition(PARTITION)
    ses.setPermissionRequestHandler((_wc, permission, cb) => cb(permission === 'media' || permission === 'display-capture'))
    ses.setPermissionCheckHandler((_wc, permission) => permission === 'media' || permission === 'display-capture')
    // getDisplayMedia in the audio window → Windows system-audio loopback (what Zoom plays).
    ses.setDisplayMediaRequestHandler((_req, cb) => {
      desktopCapturer
        .getSources({ types: ['screen'] })
        .then((sources) => cb({ video: sources[0], audio: 'loopback' }))
        .catch((err) => {
          log.warn('display media request failed', err)
          cb({})
        })
    })
    this.win = new BrowserWindow({
      show: false,
      width: 200,
      height: 100,
      skipTaskbar: true,
      focusable: false,
      webPreferences: { preload: this.preload, partition: PARTITION, contextIsolation: true, sandbox: true, backgroundThrottling: false }
    })
    this.win.on('closed', () => {
      this.win = null
      this.ready = null
    })
    this.ready = new Promise<void>((resolve) => {
      this.win!.webContents.once('did-finish-load', () => resolve())
      void this.page()
    })
    return this.ready
  }

  get window(): BrowserWindow | null {
    return this.win
  }

  async start(options: AudioStartOptions): Promise<void> {
    for (const f of [options.testMe, options.testThem]) if (f) this.allowedFiles.add(path.resolve(f.split('@')[0]))
    await this.ensureWindow()
    this.win?.webContents.send('audio:command', { type: 'start', options })
  }

  stop(): void {
    this.win?.webContents.send('audio:command', { type: 'stop' })
  }

  async refreshDevices(): Promise<void> {
    await this.ensureWindow()
    this.win?.webContents.send('audio:command', { type: 'devices' })
  }

  destroy(): void {
    if (this.win && !this.win.isDestroyed()) this.win.destroy()
  }
}

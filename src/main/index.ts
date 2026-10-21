// Cue main process: app lifecycle, overlay, global hotkeys, tray, IPC.
import { app, globalShortcut, ipcMain, shell } from 'electron'
import path from 'node:path'
import type { AnswerEvent, InputMode, Notice, UiState } from '../shared/types'
import { AnswerEngine } from './answers'
import { AudioCapture } from './audio/capture'
import { Listener } from './audio/listener'
import { ConfigError, DEFAULT_CONFIG, loadConfig, type CueConfig, type HotkeyAction } from './config'
import { MeetingContext } from './context'
import { Gemini } from './gemini/client'
import { registerHotkeys } from './hotkeys'
import { log, setLogDir } from './log'
import { Overlay, windowsBuild } from './overlay'
import { resolvePaths, type CuePaths } from './paths'
import { loadApiKey, saveEncryptedKey } from './secrets'
import { screenshotJpeg } from './screen'
import { runCaptureSelfTest } from './selftest'
import { WDA_EXCLUDEFROMCAPTURE } from './win32'
import { LiveKnowledge } from './liveKnowledge'
import { Settings } from './settings'
import { CueTray } from './tray'

if (!app.requestSingleInstanceLock()) {
  app.quit()
  process.exit(0)
}

let paths: CuePaths
let config: CueConfig = DEFAULT_CONFIG
let gem: Gemini | null = null
let overlay: Overlay
let tray: CueTray
let engine: AnswerEngine
const ctx = new MeetingContext()

let inputMode: InputMode = 'none'
let presentation = false
let listening = false
let hotkeyFailures: string[] = []
let selfTestPattern = false
const notices: Notice[] = []
let noticeSeq = 0

let knowledge: LiveKnowledge
let capture: AudioCapture
let listener: Listener
let settings: Settings

function rendererUrl(page: string): { url?: string; file: string } {
  const dev = process.env.ELECTRON_RENDERER_URL
  return !app.isPackaged && dev ? { url: `${dev}/${page}`, file: '' } : { file: path.join(__dirname, `../renderer/${page}`) }
}

function notify(level: Notice['level'], text: string): void {
  notices.push({ id: ++noticeSeq, level, text })
  if (notices.length > 4) notices.shift()
  pushState()
}

function uiState(): UiState {
  return {
    clickThrough: overlay?.clickThrough ?? true,
    inputMode,
    presentation,
    listening,
    listeningAvailable: true,
    hotkeyFailures,
    quota: gem?.usage() ?? { brain: [], fast: [] },
    tier: config.gemini.tier,
    sessionTokens: gem ? { ...gem.tokens } : { input: 0, output: 0 },
    sessionCostUsd: config.gemini.tier === 'paid' && gem ? gem.costUsd : null,
    lastLatencyMs: engine?.lastLatencyMs ?? null,
    knowledgeLoaded: Boolean(knowledge?.kb && !knowledge.kb.empty),
    knowledgeInfo: knowledge?.info() ?? '',
    notices: [...notices],
    fontSize: config.ui.font_size,
    material: overlay?.material ?? 'translucent',
    selfTestPattern
  }
}

function pushState(): void {
  if (overlay && !overlay.win.isDestroyed()) overlay.win.webContents.send('cue:state', uiState())
}

function emitAnswer(e: AnswerEvent): void {
  if (!overlay.win.isDestroyed()) overlay.win.webContents.send('cue:answer', e)
  if (e.kind === 'start' && !overlay.win.isVisible()) overlay.show()
}

function setupGemini(): void {
  const k = loadApiKey(paths.env, paths.userData)
  if (!k.key) {
    gem = null
    notify('warn', 'No Gemini API key. Put GEMINI_API_KEY in .env, or tray icon → Set API key.')
    return
  }
  gem = new Gemini(k.key, config, path.join(paths.userData, 'quota.json'))
  void knowledge?.refreshCache()
  if (k.savedEncryptedNow) notify('info', 'API key saved encrypted with Windows DPAPI. You can now delete it from .env.')
}

function setInputMode(mode: InputMode): void {
  inputMode = mode
  if (mode === 'none') overlay.exitInput()
  else overlay.enterInput()
  pushState()
}

function togglePresentation(): void {
  presentation = !presentation
  notify('info', presentation ? 'Presentation mode on (slide tracking arrives in Phase 6).' : 'Presentation mode off.')
}

function toggleListening(): void {
  if (!gem) {
    notify('warn', 'Set a Gemini API key first (tray → Set API key).')
    return
  }
  listener.toggle()
}

function setupAudio(): void {
  capture = new AudioCapture(path.join(__dirname, '../preload/audio.js'), async () => {
    const r = rendererUrl('audio.html')
    if (r.url) await capture.window?.loadURL(r.url)
    else await capture.window?.loadFile(r.file)
  })
  listener = new Listener(capture, () => gem, () => config, ctx, () => settings.data.micDeviceId ?? config.audio.mic_device)
  listener.testFiles = { me: process.env.CUE_TEST_ME_WAV, them: process.env.CUE_TEST_THEM_WAV }
  listener.on('transcript', (lines) => {
    if (!overlay.win.isDestroyed()) overlay.win.webContents.send('cue:transcript', lines.slice(-3))
  })
  let lastLevels = 0
  listener.on('levels', (me, them) => {
    const now = Date.now()
    if (now - lastLevels < 140 || overlay.win.isDestroyed()) return
    lastLevels = now
    overlay.win.webContents.send('cue:levels', [me, them])
  })
  listener.on('state', (on) => {
    listening = on
    tray.setListening(on)
    buildTrayMenu()
    pushState()
    log.info(on ? 'listening started' : 'listening stopped')
  })
  listener.on('warn', (text) => notify('warn', text))
  capture.on('devices', () => buildTrayMenu())
}

function toggleClickThrough(): void {
  overlay.setClickThrough(!overlay.clickThrough)
  buildTrayMenu()
  pushState()
}

/** True when Windows already keeps the overlay out of captures, so no need to hide it first. */
function overlayExcludedFromCapture(): boolean {
  if (process.platform !== 'win32') return false
  const a = overlay.captureAffinity()
  return a === WDA_EXCLUDEFROMCAPTURE || (a === null && windowsBuild() >= 19041)
}

let shooting = false
async function screenshotAnswer(): Promise<void> {
  if (shooting) return
  shooting = true
  const hide = !overlayExcludedFromCapture() && overlay.win.isVisible()
  try {
    if (hide) {
      overlay.win.hide()
      await new Promise((r) => setTimeout(r, 180))
    }
    const shot = await screenshotJpeg(config.screenshot.display, config.screenshot.max_width)
    if (hide) overlay.show()
    log.info(`screenshot ${shot.width}x${shot.height}, ${Math.round(shot.data.length / 1024)} KB`)
    onScreenshot?.(shot.data)
    void engine.ask({ trigger: 'screenshot', image: { data: shot.data, mimeType: shot.mimeType } })
  } catch (err) {
    if (hide) overlay.show()
    notify('error', `Screenshot failed: ${(err as Error).message}`)
  } finally {
    shooting = false
  }
}

/** Phase 7 hooks this to save screenshots into the session folder when enabled. */
let onScreenshot: ((jpeg: Buffer) => void) | null = null

async function selfTest(): Promise<void> {
  const res = await runCaptureSelfTest(overlay, (on) => {
    selfTestPattern = on
    pushState()
  })
  log.info('capture self-test:', res.summary)
  notify(res.pass === false ? 'error' : res.pass ? 'info' : 'warn', res.summary)
}

function hotkeyHandlers(): Partial<Record<HotkeyAction, () => void>> {
  return {
    answer_now: () => void engine.ask({ trigger: 'hotkey' }),
    screenshot_answer: () => void screenshotAnswer(),
    toggle_overlay: () => overlay.toggle(),
    toggle_listening: toggleListening,
    move_up: () => overlay.move(0, -1),
    move_down: () => overlay.move(0, 1),
    move_left: () => overlay.move(-1, 0),
    move_right: () => overlay.move(1, 0),
    clear: () => {
      engine.cancel()
      notices.length = 0
      emitAnswer({ kind: 'clear' })
      pushState()
    },
    type_mode: () => setInputMode(inputMode === 'type' ? 'none' : 'type'),
    presentation_mode: togglePresentation,
    click_through: toggleClickThrough
  }
}

function applyConfig(): void {
  try {
    config = loadConfig(paths.home).config
  } catch (err) {
    notify('error', err instanceof ConfigError ? err.message : `config.yaml: ${String(err)}`)
  }
  if (gem) gem.config = config
  hotkeyFailures = registerHotkeys(config.hotkeys, hotkeyHandlers())
  pushState()
}

function micMenu(): Electron.MenuItemConstructorOptions[] {
  const current = settings.data.micDeviceId ?? config.audio.mic_device
  const devices = capture?.devices.length ? capture.devices : [{ deviceId: 'default', label: 'Windows default microphone' }]
  return devices.map((d) => ({
    label: d.deviceId === 'default' ? `Default: ${d.label.replace(/^Default - /, '')}` : d.label,
    type: 'radio' as const,
    checked: d.deviceId === current,
    click: () => {
      settings.set({ micDeviceId: d.deviceId, micLabel: d.label })
      if (listening) {
        listener.stop()
        setTimeout(() => void listener.start(), 300)
      }
      buildTrayMenu()
    }
  }))
}

function buildTrayMenu(): void {
  const h = config.hotkeys
  tray.setMenu([
    { label: `${listening ? 'Pause listening' : 'Start listening'}\t${h.toggle_listening}`, click: toggleListening },
    { label: 'Microphone', submenu: micMenu() },
    { type: 'separator' },
    { label: `Show / hide overlay\t${h.toggle_overlay}`, click: () => overlay.toggle() },
    { label: `Click-through\t${h.click_through}`, type: 'checkbox', checked: overlay.clickThrough, click: toggleClickThrough },
    { label: `Type a question\t${h.type_mode}`, click: () => setInputMode('type') },
    { type: 'separator' },
    { label: 'Test screen-share hiding', click: () => void selfTest() },
    { label: 'Set API key…', click: () => setInputMode('apikey') },
    { label: 'Open config.yaml', click: () => void shell.openPath(paths.config) },
    { label: 'Open brief.md', enabled: Boolean(knowledge.kb?.brief), click: () => void shell.openPath(path.join(paths.knowledge, 'brief.md')) },
    { label: 'Open knowledge folder', click: () => void shell.openPath(paths.knowledge) },
    {
      label: 'Reload knowledge',
      click: () => {
        knowledge.load()
        notify('info', knowledge.kb ? `Notes reloaded: ${knowledge.info()}` : 'No knowledge folder yet. Run npm run prep.')
      }
    },
    { label: 'Reload config.yaml', click: applyConfigAndMenu },
    { label: 'Open sessions folder', click: () => void shell.openPath(paths.sessions) },
    { label: 'Open log folder', click: () => void shell.openPath(paths.logs) },
    { type: 'separator' },
    { label: 'Quit Cue', click: () => app.quit() }
  ])
}

function applyConfigAndMenu(): void {
  applyConfig()
  buildTrayMenu()
  notify('info', 'config.yaml reloaded.')
}

function wireIpc(): void {
  ipcMain.on('cue:ready', () => pushState())
  ipcMain.on('cue:ask', (_e, text: unknown) => {
    if (typeof text !== 'string' || !text.trim()) return
    setInputMode('none') // hand focus back to Zoom right away
    void engine.ask({ trigger: 'typed', question: text.slice(0, 2000) })
  })
  ipcMain.on('cue:apikey', (_e, key: unknown) => {
    setInputMode('none')
    if (typeof key !== 'string' || key.trim().length < 20) {
      notify('error', "That doesn't look like a Gemini API key.")
      return
    }
    if (!saveEncryptedKey(paths.userData, key)) {
      notify('error', 'Windows encryption (safeStorage) is unavailable; put the key in .env instead.')
      return
    }
    setupGemini()
    if (gem) notify('info', 'API key saved (encrypted).')
  })
  ipcMain.on('cue:exit-input', () => setInputMode('none'))
  ipcMain.on('cue:dismiss', (_e, id: unknown) => {
    const i = notices.findIndex((n) => n.id === id)
    if (i >= 0) notices.splice(i, 1)
    pushState()
  })
  ipcMain.on('cue:drag-start', () => overlay.dragStart())
  ipcMain.on('cue:drag-end', () => overlay.dragEnd())
  ipcMain.on('cue:handle-hover', (_e, over: unknown) => overlay.setHandleHover(Boolean(over)))
  ipcMain.on('cue:resize', (_e, h: unknown) => {
    if (typeof h === 'number' && Number.isFinite(h)) overlay.fitHeight(h)
  })
}

app.whenReady().then(() => {
  app.setAppUserModelId('local.cue.copilot')
  paths = resolvePaths()
  setLogDir(paths.logs)
  settings = Settings.at(paths.userData)
  const build = windowsBuild()
  log.info(`Cue ${app.getVersion()} starting; home=${paths.home}; platform=${process.platform}; windows build=${build || 'n/a'}`)

  try {
    config = loadConfig(paths.home).config
  } catch (err) {
    config = DEFAULT_CONFIG
    notices.push({ id: ++noticeSeq, level: 'error', text: err instanceof ConfigError ? err.message : String(err) })
  }

  overlay = new Overlay(config, path.join(paths.userData, 'overlay-position.json'), path.join(__dirname, '../preload/index.js'), () => {
    inputMode = 'none'
    pushState()
  })
  knowledge = new LiveKnowledge(paths.knowledge, () => gem, () => config, ctx, () => {
    pushState()
    if (tray) buildTrayMenu()
  })
  engine = new AnswerEngine(() => gem, () => config, ctx, knowledge, emitAnswer, pushState)

  tray = new CueTray('Cue: meeting copilot')
  tray.onClick(() => overlay.toggle())
  setupAudio()
  wireIpc()
  setupGemini()
  knowledge.load()
  knowledge.watch()
  if (!knowledge.kb) notices.push({ id: ++noticeSeq, level: 'warn', text: 'No notes loaded yet. Fill in sources in config.yaml, then run: npm run prep' })
  hotkeyFailures = registerHotkeys(config.hotkeys, hotkeyHandlers())
  buildTrayMenu()

  if (process.platform === 'win32' && build < 19041) {
    notify('warn', `Windows build ${build}: screen-share hiding needs Windows 10 2004 (19041)+. Older builds show a black box instead.`)
  }

  overlay.win.once('ready-to-show', () => {
    overlay.show()
    // CUE_SELFTEST=1 runs the screen-capture check right after start (same as the tray item).
    if (process.env.CUE_SELFTEST === '1') setTimeout(() => void selfTest(), 1500)
    // CUE_AUTOLISTEN=1 starts listening right away (handy with the CUE_TEST_*_WAV debug inputs).
    if (process.env.CUE_AUTOLISTEN === '1') setTimeout(() => toggleListening(), 800)
    void capture.refreshDevices()
  })
  const r = rendererUrl('index.html')
  if (r.url) void overlay.win.loadURL(r.url)
  else void overlay.win.loadFile(r.file)
})

app.on('second-instance', () => overlay?.show())
app.on('will-quit', () => {
  globalShortcut.unregisterAll()
  listener?.stop()
  capture?.destroy()
})
app.on('window-all-closed', () => app.quit())

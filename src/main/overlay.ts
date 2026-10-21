// The overlay window: frameless dark glass, always on top, never focused unless you ask, hidden from
// the taskbar, Alt+Tab and screen capture.
import { BrowserWindow, nativeTheme, screen, type Display, type Rectangle } from 'electron'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import type { CueConfig } from './config'
import { log } from './log'
import { displayAffinity, foregroundWindow, hwndOf, restoreForeground } from './win32'

export type Material = 'acrylic' | 'mica' | 'translucent'

/** Windows build number (e.g. 22631), or 0 when not on Windows. */
export function windowsBuild(): number {
  if (process.platform !== 'win32') return 0
  return Number(os.release().split('.')[2] ?? 0)
}

export function resolveMaterial(pref: CueConfig['ui']['material']): Material {
  // DWM system backdrops (acrylic/mica) need Windows 11 22H2 (build 22621).
  const supported = windowsBuild() >= 22621
  if (pref === 'translucent' || !supported) return 'translucent'
  if (pref === 'auto') return 'acrylic'
  return pref
}

interface SavedPosition {
  x: number
  y: number
  displayId: number
}

const MOVE_STEP = 40

export class Overlay {
  readonly win: BrowserWindow
  readonly material: Material
  clickThrough: boolean
  inputActive = false
  private prevForeground: bigint | null = null
  private hoveringHandle = false
  private dragTimer: NodeJS.Timeout | null = null
  private topTimer: NodeJS.Timeout
  private height = 240

  constructor(
    private cfg: CueConfig,
    private stateFile: string,
    preload: string,
    private onInputLost: () => void
  ) {
    this.material = resolveMaterial(cfg.ui.material)
    this.clickThrough = cfg.ui.start_click_through
    nativeTheme.themeSource = 'dark'
    const { x, y } = this.initialPosition()
    const glass = this.material !== 'translucent'
    this.win = new BrowserWindow({
      x,
      y,
      width: cfg.ui.width,
      height: this.height,
      show: false,
      frame: false,
      transparent: !glass,
      backgroundColor: '#00000000',
      ...(glass ? { backgroundMaterial: this.material } : {}),
      hasShadow: glass,
      resizable: false,
      maximizable: false,
      minimizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      focusable: false,
      alwaysOnTop: true,
      // Windows: a tool window, which keeps it out of Alt+Tab.
      type: process.platform === 'win32' ? 'toolbar' : undefined,
      title: 'Cue',
      webPreferences: {
        preload,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        backgroundThrottling: false,
        spellcheck: false
      }
    })
    this.win.setAlwaysOnTop(true, 'screen-saver')
    this.win.setContentProtection(true)
    this.win.setMenu(null)
    this.applyMouseMode()
    this.win.on('blur', () => {
      if (this.inputActive) {
        // You clicked into Zoom or somewhere else: leave input mode without yanking focus back.
        this.prevForeground = null
        this.exitInput()
        this.onInputLost()
      }
    })
    // PowerPoint's slideshow and some Zoom windows re-assert topmost; re-assert ours too.
    this.topTimer = setInterval(() => {
      if (!this.win.isDestroyed() && this.win.isVisible()) this.win.setAlwaysOnTop(true, 'screen-saver')
    }, 3000)
    screen.on('display-removed', () => this.clampToScreen())
    screen.on('display-metrics-changed', () => this.clampToScreen())
    this.win.on('closed', () => clearInterval(this.topTimer))
  }

  // ---------- visibility ----------

  show(): void {
    this.win.showInactive()
    // Re-apply after showing; cheap insurance against the affinity being dropped on re-show.
    this.win.setContentProtection(true)
    this.win.setAlwaysOnTop(true, 'screen-saver')
  }

  toggle(): boolean {
    if (this.win.isVisible()) {
      if (this.inputActive) this.exitInput()
      this.win.hide()
      return false
    }
    this.show()
    return true
  }

  /** 0x11 = excluded from capture (Win10 2004+), 0x1 = shows black, 0 = visible, null = unknown. */
  captureAffinity(): number | null {
    return displayAffinity(hwndOf(this.win.getNativeWindowHandle()))
  }

  // ---------- mouse ----------

  private applyMouseMode(): void {
    if (this.win.isDestroyed()) return
    const ignore = this.clickThrough && !this.inputActive && !this.hoveringHandle && !this.dragTimer
    if (ignore) this.win.setIgnoreMouseEvents(true, { forward: true })
    else this.win.setIgnoreMouseEvents(false)
  }

  setClickThrough(on: boolean): void {
    this.clickThrough = on
    this.applyMouseMode()
  }

  /** The drag handle stays grabbable even in click-through mode. */
  setHandleHover(over: boolean): void {
    this.hoveringHandle = over
    this.applyMouseMode()
  }

  dragStart(): void {
    if (this.dragTimer) return
    const cursor = screen.getCursorScreenPoint()
    const [wx, wy] = this.win.getPosition()
    const off = { x: cursor.x - wx, y: cursor.y - wy }
    const started = Date.now()
    this.dragTimer = setInterval(() => {
      const c = screen.getCursorScreenPoint()
      this.win.setPosition(Math.round(c.x - off.x), Math.round(c.y - off.y))
      if (Date.now() - started > 30_000) this.dragEnd() // safety if pointerup never arrives
    }, 16)
    this.applyMouseMode()
  }

  dragEnd(): void {
    if (!this.dragTimer) return
    clearInterval(this.dragTimer)
    this.dragTimer = null
    this.clampToScreen()
    this.savePosition()
    this.applyMouseMode()
  }

  // ---------- focus / input ----------

  /** Type mode or API-key entry: take focus so the text box receives keys. */
  enterInput(): void {
    const own = hwndOf(this.win.getNativeWindowHandle())
    const fg = foregroundWindow()
    this.prevForeground = fg && fg !== own ? fg : this.prevForeground
    this.inputActive = true
    this.win.setFocusable(true)
    this.applyMouseMode()
    if (!this.win.isVisible()) this.show()
    this.win.focus()
    this.win.webContents.focus()
  }

  /** Leave input mode and hand focus back to whatever had it (normally Zoom). */
  exitInput(): void {
    if (!this.inputActive) return
    this.inputActive = false
    this.win.setFocusable(false)
    this.applyMouseMode()
    const prev = this.prevForeground
    this.prevForeground = null
    if (!restoreForeground(prev)) this.win.blur()
  }

  // ---------- geometry ----------

  private targetDisplay(): Display {
    const d = this.cfg.ui.display
    if (d === 'cursor') return screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
    if (typeof d === 'number') return screen.getAllDisplays()[d - 1] ?? screen.getPrimaryDisplay()
    return screen.getPrimaryDisplay()
  }

  private initialPosition(): { x: number; y: number } {
    const saved = this.loadPosition()
    if (saved) {
      const disp = screen.getAllDisplays().find((d) => d.id === saved.displayId)
      if (disp && inside(disp.workArea, saved.x, saved.y)) return saved
    }
    const wa = this.targetDisplay().workArea
    const m = this.cfg.ui.margin
    const right = this.cfg.ui.position.endsWith('right')
    const bottom = this.cfg.ui.position.startsWith('bottom')
    return {
      x: right ? wa.x + wa.width - this.cfg.ui.width - m : wa.x + m,
      y: bottom ? wa.y + wa.height - this.height - m : wa.y + m
    }
  }

  private loadPosition(): SavedPosition | null {
    try {
      return existsSync(this.stateFile) ? (JSON.parse(readFileSync(this.stateFile, 'utf8')) as SavedPosition) : null
    } catch {
      return null
    }
  }

  private savePosition(): void {
    const b = this.win.getBounds()
    const disp = screen.getDisplayMatching(b)
    try {
      writeFileSync(this.stateFile, JSON.stringify({ x: b.x, y: b.y, displayId: disp.id } satisfies SavedPosition))
    } catch (err) {
      log.warn('could not save overlay position', err)
    }
  }

  private clampToScreen(): void {
    if (this.win.isDestroyed()) return
    const b = this.win.getBounds()
    const wa = screen.getDisplayMatching(b).workArea
    const x = Math.min(Math.max(b.x, wa.x), wa.x + wa.width - b.width)
    const y = Math.min(Math.max(b.y, wa.y), wa.y + Math.max(0, wa.height - b.height))
    if (x !== b.x || y !== b.y) this.win.setPosition(x, y)
  }

  move(dx: number, dy: number): void {
    const b = this.win.getBounds()
    const next = { ...b, x: b.x + dx * MOVE_STEP, y: b.y + dy * MOVE_STEP }
    // Allow sliding onto a neighbouring monitor; clamp to whichever monitor the panel lands on.
    const wa = screen.getDisplayNearestPoint({ x: next.x + next.width / 2, y: next.y + 20 }).workArea
    next.x = Math.min(Math.max(next.x, wa.x), wa.x + wa.width - next.width)
    next.y = Math.min(Math.max(next.y, wa.y), wa.y + Math.max(0, wa.height - next.height))
    this.win.setBounds(next)
    this.savePosition()
  }

  /** Renderer reports its content height; the window hugs it so empty glass never blocks clicks. */
  fitHeight(contentHeight: number): void {
    const b = this.win.getBounds()
    const wa = screen.getDisplayMatching(b).workArea
    const h = Math.max(80, Math.min(Math.ceil(contentHeight), wa.height - 2 * this.cfg.ui.margin))
    if (h === this.height && b.height === h) return
    this.height = h
    const y = Math.min(b.y, wa.y + wa.height - h)
    this.win.setBounds({ x: b.x, y, width: this.cfg.ui.width, height: h })
  }

  bounds(): Rectangle {
    return this.win.getBounds()
  }
}

function inside(r: Rectangle, x: number, y: number): boolean {
  return x >= r.x && y >= r.y && x < r.x + r.width && y < r.y + r.height
}

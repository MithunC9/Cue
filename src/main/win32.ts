// A few user32 calls through koffi, which ships prebuilt binaries, so no compiler is needed.
// koffi is an optional dependency: if it's missing, every helper returns null and Cue falls back to
// plain Electron behavior.
import { log } from './log'

type Fn = (...args: unknown[]) => unknown
let api: {
  GetForegroundWindow: Fn
  SetForegroundWindow: Fn
  GetWindowDisplayAffinity: Fn
  IsWindow: Fn
  FindWindowW: Fn
  IsWindowVisible: Fn
} | null = null

if (process.platform === 'win32') {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const koffi = require('koffi')
    const user32 = koffi.load('user32.dll')
    api = {
      GetForegroundWindow: user32.func('intptr_t __stdcall GetForegroundWindow()'),
      SetForegroundWindow: user32.func('bool __stdcall SetForegroundWindow(intptr_t hWnd)'),
      GetWindowDisplayAffinity: user32.func('bool __stdcall GetWindowDisplayAffinity(intptr_t hWnd, _Out_ uint32_t *pdwAffinity)'),
      IsWindow: user32.func('bool __stdcall IsWindow(intptr_t hWnd)'),
      FindWindowW: user32.func('intptr_t __stdcall FindWindowW(const char16_t *lpClassName, const char16_t *lpWindowName)'),
      IsWindowVisible: user32.func('bool __stdcall IsWindowVisible(intptr_t hWnd)')
    }
  } catch (err) {
    log.warn('koffi unavailable; focus restore and affinity check disabled', err)
  }
}

export const win32Available = (): boolean => api !== null

/** HWND from BrowserWindow.getNativeWindowHandle(). */
export function hwndOf(buf: Buffer): bigint {
  return buf.length >= 8 ? buf.readBigUInt64LE(0) : BigInt(buf.readUInt32LE(0))
}

export function foregroundWindow(): bigint | null {
  if (!api) return null
  const h = api.GetForegroundWindow() as number | bigint
  return h ? BigInt(h) : null
}

export function restoreForeground(hwnd: bigint | null): boolean {
  if (!api || !hwnd) return false
  try {
    const h = Number(hwnd)
    if (!api.IsWindow(h)) return false
    return Boolean(api.SetForegroundWindow(h))
  } catch (err) {
    log.warn('SetForegroundWindow failed', err)
    return false
  }
}

export const WDA_NONE = 0x0
export const WDA_MONITOR = 0x1
export const WDA_EXCLUDEFROMCAPTURE = 0x11

export function displayAffinity(hwnd: bigint): number | null {
  if (!api) return null
  const out = [0]
  try {
    return api.GetWindowDisplayAffinity(Number(hwnd), out) ? out[0] : null
  } catch {
    return null
  }
}

/** Window classes of Zoom's in-meeting windows (stable across Zoom versions for years). */
const ZOOM_MEETING_CLASSES = ['ZPContentViewWndClass', 'ConfMultiTabContentWndClass']

/** True when a Zoom meeting window is open (Windows only; null when it can't tell). */
export function zoomMeetingOpen(): boolean | null {
  if (!api) return null
  try {
    return ZOOM_MEETING_CLASSES.some((cls) => {
      const h = api!.FindWindowW(cls, null) as number | bigint
      return Boolean(h) && Boolean(api!.IsWindowVisible(h))
    })
  } catch {
    return null
  }
}

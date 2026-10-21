// Screen-capture hiding self-test.
//
// Paints the overlay solid magenta for a moment, grabs the monitor through Electron's desktopCapturer
// (the same Windows capture APIs Zoom, OBS and the Snipping Tool use) and checks whether any magenta
// shows up where the overlay is. It's a quick sanity check. Still run the real Zoom / OBS / Win+Shift+S
// checks from the README before the meeting.
import { desktopCapturer, screen } from 'electron'
import type { Overlay } from './overlay'
import { windowsBuild } from './overlay'
import { WDA_EXCLUDEFROMCAPTURE, WDA_MONITOR } from './win32'

export interface SelfTestResult {
  pass: boolean | null
  summary: string
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

export async function runCaptureSelfTest(overlay: Overlay, setPattern: (on: boolean) => void): Promise<SelfTestResult> {
  const build = windowsBuild()
  const affinity = overlay.captureAffinity()
  const affinityText =
    affinity === WDA_EXCLUDEFROMCAPTURE
      ? 'display affinity = EXCLUDEFROMCAPTURE'
      : affinity === WDA_MONITOR
        ? 'display affinity = MONITOR (older Windows: shows as a black box)'
        : affinity === null
          ? 'display affinity unknown'
          : `display affinity = 0x${affinity.toString(16)} (NOT protected)`

  const wasVisible = overlay.win.isVisible()
  if (!wasVisible) overlay.show()
  setPattern(true)
  await wait(400)
  try {
    const b = overlay.bounds()
    const disp = screen.getDisplayMatching(b)
    const scale = disp.scaleFactor
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: Math.round(disp.bounds.width * scale), height: Math.round(disp.bounds.height * scale) }
    })
    const src = sources.find((s) => s.display_id === String(disp.id)) ?? (sources.length === 1 ? sources[0] : undefined)
    if (!src || src.thumbnail.isEmpty()) {
      return { pass: null, summary: `Couldn't capture the screen to check (${affinityText}). Use the manual checks in the README.` }
    }
    const img = src.thumbnail
    const { width: tw, height: th } = img.getSize()
    const bmp = img.toBitmap() // BGRA
    const sx = tw / disp.bounds.width
    const sy = th / disp.bounds.height
    let magenta = 0
    let black = 0
    let samples = 0
    for (let gy = 1; gy < 12; gy++) {
      for (let gx = 1; gx < 12; gx++) {
        const px = Math.floor((b.x - disp.bounds.x + (b.width * gx) / 12) * sx)
        const py = Math.floor((b.y - disp.bounds.y + (b.height * gy) / 12) * sy)
        if (px < 0 || py < 0 || px >= tw || py >= th) continue
        const i = (py * tw + px) * 4
        const [bl, g, r] = [bmp[i], bmp[i + 1], bmp[i + 2]]
        samples++
        if (r > 180 && bl > 180 && g < 90) magenta++
        if (r < 12 && g < 12 && bl < 12) black++
      }
    }
    if (!samples) return { pass: null, summary: `Overlay is off-screen; move it and retry (${affinityText}).` }
    if (magenta / samples > 0.3) {
      return {
        pass: false,
        summary: `FAIL: the overlay showed up in a screen capture (${affinityText}, Windows build ${build}). See README → "If the overlay shows up in Zoom".`
      }
    }
    if (black / samples > 0.9 && affinity !== WDA_EXCLUDEFROMCAPTURE) {
      return { pass: false, summary: `Partial: captures show a black box where the overlay is (${affinityText}). Needs Windows 10 2004+ (build 19041).` }
    }
    return { pass: true, summary: `PASS: hidden from screen capture (${affinityText}, Windows build ${build}). Now confirm in a real Zoom share.` }
  } finally {
    setPattern(false)
    if (!wasVisible) overlay.win.hide()
  }
}

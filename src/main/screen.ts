// Screen capture for "screenshot + answer" and slide tracking. On Windows the overlay is excluded from
// capture by display affinity, so it never appears in these images.
import { desktopCapturer, screen, type Display, type NativeImage } from 'electron'

export type DisplayChoice = 'cursor' | 'primary' | number

export function pickDisplay(choice: DisplayChoice): Display {
  if (choice === 'cursor') return screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
  if (typeof choice === 'number') return screen.getAllDisplays()[choice - 1] ?? screen.getPrimaryDisplay()
  return screen.getPrimaryDisplay()
}

/** Full-resolution capture of one monitor. */
export async function captureDisplay(display: Display, maxWidth?: number): Promise<NativeImage> {
  const scale = display.scaleFactor
  const full = { width: Math.round(display.bounds.width * scale), height: Math.round(display.bounds.height * scale) }
  const size = maxWidth && full.width > maxWidth ? { width: maxWidth, height: Math.round((full.height * maxWidth) / full.width) } : full
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: size })
  const all = screen.getAllDisplays()
  const src =
    sources.find((s) => s.display_id && s.display_id === String(display.id)) ??
    (sources.length === all.length ? sources[all.findIndex((d) => d.id === display.id)] : undefined) ??
    sources[0]
  if (!src || src.thumbnail.isEmpty()) throw new Error('Screen capture returned nothing (is screen recording blocked?)')
  return src.thumbnail
}

/** JPEG for Gemini: ≤1600 px wide keeps text readable at roughly a thousand image tokens. */
export async function screenshotJpeg(choice: DisplayChoice, maxWidth = 1600): Promise<{ data: Buffer; mimeType: string; width: number; height: number }> {
  const img = await captureDisplay(pickDisplay(choice), maxWidth)
  const { width, height } = img.getSize()
  return { data: img.toJPEG(82), mimeType: 'image/jpeg', width, height }
}

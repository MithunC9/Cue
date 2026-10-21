// Tray icon (the overlay itself has no taskbar button) with settings and quit.
import { Menu, Tray, nativeImage, type MenuItemConstructorOptions, type NativeImage } from 'electron'

/** Draws a small round icon so we don't need image files. `dot` adds a red "listening" dot. */
export function makeIcon(dot = false, size = 32): NativeImage {
  const buf = Buffer.alloc(size * size * 4)
  const c = (size - 1) / 2
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4
      const d = Math.hypot(x - c, y - c)
      const r = size / 2 - 0.5
      // anti-aliased disc
      const a = Math.max(0, Math.min(1, r - d))
      let [R, G, B] = [56, 189, 248] // sky blue
      if (d < r * 0.42) [R, G, B] = [15, 23, 42] // dark core = "speech bubble" dot
      const dd = Math.hypot(x - size * 0.78, y - size * 0.22)
      if (dot && dd < size * 0.2) [R, G, B] = [239, 68, 68]
      buf[i] = B
      buf[i + 1] = G
      buf[i + 2] = R
      buf[i + 3] = Math.round(a * 255)
    }
  }
  return nativeImage.createFromBitmap(buf, { width: size, height: size, scaleFactor: 2 })
}

export class CueTray {
  private tray: Tray
  constructor(tooltip: string) {
    this.tray = new Tray(makeIcon())
    this.tray.setToolTip(tooltip)
  }

  setMenu(items: MenuItemConstructorOptions[]): void {
    this.tray.setContextMenu(Menu.buildFromTemplate(items))
  }

  onClick(fn: () => void): void {
    this.tray.on('click', fn)
  }

  setListening(on: boolean): void {
    this.tray.setImage(makeIcon(on))
  }

  setTooltip(t: string): void {
    this.tray.setToolTip(t)
  }

  destroy(): void {
    this.tray.destroy()
  }
}

// Global hotkeys. Anything that fails to register (taken by another app, or a typo) is reported.
import { globalShortcut } from 'electron'
import type { HotkeyAction } from './config'
import { log } from './log'

/** Accepts "Ctrl+Alt+Enter" style and turns it into an Electron accelerator. */
export function toAccelerator(combo: string): string {
  return combo
    .split('+')
    .map((k) => k.trim())
    .filter(Boolean)
    .map((k) => {
      const l = k.toLowerCase()
      if (l === 'ctrl' || l === 'control') return 'Ctrl'
      if (l === 'win' || l === 'windows' || l === 'meta') return 'Super'
      if (l === 'esc') return 'Escape'
      if (l === 'enter') return 'Return'
      if (l.length === 1) return l.toUpperCase()
      return k[0].toUpperCase() + k.slice(1)
    })
    .join('+')
}

export function registerHotkeys(
  map: Record<HotkeyAction, string>,
  handlers: Partial<Record<HotkeyAction, () => void>>
): string[] {
  globalShortcut.unregisterAll()
  const failures: string[] = []
  const seen = new Map<string, HotkeyAction>()
  for (const [action, combo] of Object.entries(map) as [HotkeyAction, string][]) {
    const handler = handlers[action]
    if (!handler || !combo) continue
    const acc = toAccelerator(combo)
    const dup = seen.get(acc.toLowerCase())
    if (dup) {
      failures.push(`${combo} (${action}): same key as ${dup}`)
      continue
    }
    seen.set(acc.toLowerCase(), action)
    let ok = false
    try {
      ok = globalShortcut.register(acc, handler)
    } catch (err) {
      log.warn(`invalid hotkey ${combo}`, err)
    }
    if (!ok) failures.push(`${combo} (${action.replace(/_/g, ' ')})`)
  }
  if (failures.length) log.warn('hotkeys failed to register:', failures.join(', '))
  return failures
}

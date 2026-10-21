// Small per-user settings changed from the tray (kept out of config.yaml so it stays hand-edited).
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

export interface UserSettings {
  micDeviceId?: string
  micLabel?: string
}

export class Settings {
  data: UserSettings
  constructor(private file: string) {
    this.data = {}
    try {
      if (existsSync(file)) this.data = JSON.parse(readFileSync(file, 'utf8')) as UserSettings
    } catch {
      this.data = {}
    }
  }

  set(patch: Partial<UserSettings>): void {
    this.data = { ...this.data, ...patch }
    try {
      writeFileSync(this.file, JSON.stringify(this.data, null, 2))
    } catch {
      // non-fatal
    }
  }

  static at(dir: string): Settings {
    return new Settings(path.join(dir, 'settings.json'))
  }
}

// Shared by the command-line tools (prep, debrief): API key and the app's per-user data folder.
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { parseEnv } from 'node:util'

/** Same folder the app uses (so prep, debrief and live answers share one request budget). */
export function userDataDir(): string {
  if (process.env.CUE_USER_DATA) return process.env.CUE_USER_DATA
  if (process.platform === 'win32') return path.join(process.env.APPDATA ?? path.join(homedir(), 'AppData', 'Roaming'), 'Cue')
  if (process.platform === 'darwin') return path.join(homedir(), 'Library', 'Application Support', 'Cue')
  return path.join(process.env.XDG_CONFIG_HOME ?? path.join(homedir(), '.config'), 'Cue')
}

export function apiKey(root: string): string | null {
  if (process.env.GEMINI_API_KEY) return process.env.GEMINI_API_KEY.trim()
  const env = path.join(root, '.env')
  if (!existsSync(env)) return null
  const v = (parseEnv(readFileSync(env, 'utf8')) as Record<string, string>).GEMINI_API_KEY
  return v?.trim() || null
}

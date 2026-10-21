// Where Cue keeps config.yaml, knowledge\ and sessions\.
// Dev (`npm run dev`): the project folder. Packaged: the folder next to Cue.exe (or the portable exe),
// overridable with the CUE_HOME environment variable.
import { app } from 'electron'
import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import path from 'node:path'

export function cueHome(): string {
  if (process.env.CUE_HOME) return path.resolve(process.env.CUE_HOME)
  if (!app.isPackaged) return app.getAppPath()
  return process.env.PORTABLE_EXECUTABLE_DIR ?? path.dirname(app.getPath('exe'))
}

export interface CuePaths {
  home: string
  config: string
  env: string
  knowledge: string
  sessions: string
  userData: string
  logs: string
}

export function resolvePaths(): CuePaths {
  const home = cueHome()
  const userData = app.getPath('userData')
  const p: CuePaths = {
    home,
    config: path.join(home, 'config.yaml'),
    env: path.join(home, '.env'),
    knowledge: path.join(home, 'knowledge'),
    sessions: path.join(home, 'sessions'),
    userData,
    logs: path.join(userData, 'logs')
  }
  for (const dir of [p.knowledge, p.sessions, p.logs]) mkdirSync(dir, { recursive: true })
  if (app.isPackaged && !existsSync(p.config)) {
    const bundled = path.join(process.resourcesPath, 'config.default.yaml')
    if (existsSync(bundled)) copyFileSync(bundled, p.config)
  }
  return p
}

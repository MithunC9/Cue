// Small file + console logger. Every line passes through redact() so an API key never lands on disk.
import { appendFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'

const secrets = new Set<string>()
let logFile: string | null = null

export function addSecret(value: string | undefined | null): void {
  if (value && value.length >= 8) secrets.add(value)
}

export function redact(text: string): string {
  let out = text.replace(/AIza[0-9A-Za-z_-]{30,}/g, 'AIza***').replace(/\bAQ\.[0-9A-Za-z_-]{30,}/g, 'AQ.***')
  for (const s of secrets) out = out.split(s).join('***')
  return out.replace(/([?&]key=)[^&\s"]+/g, '$1***')
}

export function setLogDir(dir: string): void {
  mkdirSync(dir, { recursive: true })
  logFile = path.join(dir, 'cue.log')
}

function write(level: string, args: unknown[]): void {
  const text = redact(
    args
      .map((a) => (a instanceof Error ? `${a.name}: ${a.message}` : typeof a === 'string' ? a : JSON.stringify(a)))
      .join(' ')
  )
  const line = `${new Date().toISOString()} ${level} ${text}`
  if (level === 'ERROR') console.error(line)
  else console.log(line)
  if (logFile) {
    try {
      appendFileSync(logFile, line + '\n')
    } catch {
      // logging must never take the app down
    }
  }
}

export const log = {
  info: (...a: unknown[]) => write('INFO', a),
  warn: (...a: unknown[]) => write('WARN', a),
  error: (...a: unknown[]) => write('ERROR', a)
}

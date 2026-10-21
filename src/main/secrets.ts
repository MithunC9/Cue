// Gemini API key: read from .env (or the environment), and keep an encrypted copy via Electron
// safeStorage (Windows DPAPI, tied to your Windows account) so .env can be emptied after first run.
import { safeStorage } from 'electron'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { parseEnv } from 'node:util'
import { addSecret, log } from './log'

const KEY_FILE = 'gemini-key.bin'

export interface KeyResult {
  key: string | null
  source: 'env' | 'encrypted' | null
  savedEncryptedNow: boolean
}

function readDotEnv(envPath: string): Record<string, string> {
  if (!existsSync(envPath)) return {}
  try {
    return parseEnv(readFileSync(envPath, 'utf8')) as Record<string, string>
  } catch (err) {
    log.warn('could not parse .env', err)
    return {}
  }
}

function readEncrypted(userData: string): string | null {
  const file = path.join(userData, KEY_FILE)
  if (!existsSync(file) || !safeStorage.isEncryptionAvailable()) return null
  try {
    return safeStorage.decryptString(readFileSync(file)).trim() || null
  } catch (err) {
    log.warn('could not decrypt stored key', err)
    return null
  }
}

export function saveEncryptedKey(userData: string, key: string): boolean {
  if (!safeStorage.isEncryptionAvailable()) return false
  writeFileSync(path.join(userData, KEY_FILE), safeStorage.encryptString(key.trim()))
  return true
}

export function loadApiKey(envPath: string, userData: string): KeyResult {
  const fromEnv = (process.env.GEMINI_API_KEY || readDotEnv(envPath).GEMINI_API_KEY || '').trim()
  const stored = readEncrypted(userData)
  if (fromEnv) {
    addSecret(fromEnv)
    const savedEncryptedNow = stored !== fromEnv && saveEncryptedKey(userData, fromEnv)
    return { key: fromEnv, source: 'env', savedEncryptedNow }
  }
  if (stored) {
    addSecret(stored)
    return { key: stored, source: 'encrypted', savedEncryptedNow: false }
  }
  return { key: null, source: null, savedEncryptedNow: false }
}

// npm run debrief [-- <session folder>]: writes debrief.md for the latest (or given) session.
import path from 'node:path'
import { ConfigError, loadConfig } from '../main/config'
import { writeDebrief } from '../main/debrief'
import { Gemini } from '../main/gemini/client'
import { AllModelsExhaustedError, parseApiError } from '../main/gemini/quota'
import { addSecret, redact } from '../main/log'
import { latestSession } from '../main/session'
import { apiKey, userDataDir } from './env'

async function main(): Promise<void> {
  const root = process.env.CUE_HOME ? path.resolve(process.env.CUE_HOME) : process.cwd()
  const { config } = loadConfig(root)
  const arg = process.argv.slice(2).find((a) => !a.startsWith('--'))
  const dir = arg ? path.resolve(arg) : latestSession(path.join(root, 'sessions'))
  if (!dir) {
    console.log('No sessions yet. Sessions are written to sessions\\ while Cue listens or answers.')
    process.exitCode = 1
    return
  }
  const key = apiKey(root)
  if (!key) {
    console.log('No GEMINI_API_KEY in .env or the environment.')
    process.exitCode = 1
    return
  }
  addSecret(key)
  console.log(`▸ Debriefing ${dir} …`)
  const gem = new Gemini(key, config, path.join(userDataDir(), 'quota.json'))
  const r = await writeDebrief(gem, config, dir, path.join(root, 'knowledge'))
  console.log(`✓ ${r.file} (${r.model})`)
}

main().catch((err) => {
  if (err instanceof ConfigError) console.error(err.message)
  else if (err instanceof AllModelsExhaustedError) console.error(`Out of free-tier budget: ${err.details.join('; ')}. Try again after the limits reset.`)
  else console.error(redact(`Debrief failed: ${parseApiError(err).message}`))
  process.exitCode = 1
})

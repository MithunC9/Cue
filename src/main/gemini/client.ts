// One GoogleGenAI client + quota manager shared by BRAIN, FAST and EARS.
import { GoogleGenAI } from '@google/genai'
import type { CueConfig } from '../config'
import { quotaFor } from '../config'
import { QuotaManager } from './quota'

export class Gemini {
  readonly ai: GoogleGenAI
  readonly quota: QuotaManager
  tokens = { input: 0, output: 0 }
  costUsd = 0

  constructor(
    apiKey: string,
    public config: CueConfig,
    quotaFile: string | null
  ) {
    this.ai = new GoogleGenAI({ apiKey })
    this.quota = new QuotaManager((m) => quotaFor(this.config, m), quotaFile)
  }

  get brainChain(): string[] {
    const m = this.config.gemini.models
    return [m.brain, ...m.brain_fallbacks]
  }

  get fastChain(): string[] {
    const m = this.config.gemini.models
    return [m.fast, ...m.fast_fallbacks]
  }

  addUsage(model: string, input: number, output: number): void {
    this.tokens.input += input
    this.tokens.output += output
    const price = this.config.gemini.prices[model]
    if (this.config.gemini.tier === 'paid' && price) {
      this.costUsd += (input * price.input + output * price.output) / 1_000_000
    }
  }

  usage() {
    return { brain: this.quota.usage(this.brainChain), fast: this.quota.usage(this.fastChain) }
  }
}

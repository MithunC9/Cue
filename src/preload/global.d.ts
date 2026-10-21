import type { CueBridge } from '../shared/types'

declare global {
  interface Window {
    cue: CueBridge
  }
}

export {}

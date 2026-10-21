import type { QuotaUsage, UiState } from '@shared/types'

const short = (m: string) => m.replace(/^gemini-/, '')

function quotaText(chain: QuotaUsage[]): string {
  const now = Date.now()
  const active = chain.find((m) => m.usedToday < m.rpd && !(m.blockedUntil && m.blockedUntil > now))
  if (!active) return 'out of budget'
  const prefix = active === chain[0] ? '' : `→${short(active.model)} `
  return `${prefix}${active.usedToday}/${active.rpd}`
}

export function StatusBar({ ui }: { ui: UiState }) {
  const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n))
  return (
    <div className="status">
      <span className={`dot ${ui.listening ? 'on' : ''}`}>●</span>
      <span>{ui.lastLatencyMs !== null ? `${(ui.lastLatencyMs / 1000).toFixed(1)}s` : '–'}</span>
      {ui.quota.brain.length > 0 && <span>brain {quotaText(ui.quota.brain)}</span>}
      {ui.quota.fast.length > 0 && <span>fast {quotaText(ui.quota.fast)}</span>}
      <span>
        {k(ui.sessionTokens.input + ui.sessionTokens.output)} tok
        {ui.sessionCostUsd !== null ? ` · $${ui.sessionCostUsd.toFixed(3)}` : ' · free tier'}
      </span>
      {ui.knowledgeLoaded ? <span>{ui.knowledgeInfo}</span> : <span className="warn">no notes: run npm run prep</span>}
    </div>
  )
}

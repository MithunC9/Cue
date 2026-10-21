import type { TranscriptLine } from '@shared/types'

export function Transcript({ lines, listening, available }: { lines: TranscriptLine[]; listening: boolean; available: boolean }) {
  const last = lines.slice(-3)
  if (!last.length) {
    return (
      <div className="transcript empty">
        {available ? (listening ? 'Listening… nothing said yet.' : 'Paused. Ctrl+Alt+L to listen.') : 'Live transcript arrives in Phase 4.'}
      </div>
    )
  }
  return (
    <div className="transcript">
      {last.map((l) => (
        <div key={l.id} className={`tline ${l.speaker === 'ME' ? 'me' : 'them'} ${l.final ? '' : 'interim'}`}>
          <span className="who">{l.speaker}</span>
          <span className="said">{l.text}</span>
        </div>
      ))}
    </div>
  )
}

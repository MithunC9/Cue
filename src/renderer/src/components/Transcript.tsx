import type { TranscriptLine } from '@shared/types'

/** The end of a long line is what matters (questions come last), so trim from the front. */
const tail = (s: string, max = 150) => (s.length > max ? '…' + s.slice(s.length - max).replace(/^\S*\s/, '') : s)

export function Transcript({ lines, listening, available }: { lines: TranscriptLine[]; listening: boolean; available: boolean }) {
  const last = lines.slice(-3)
  if (!last.length) {
    return (
      <div className="transcript empty">
        {available ? (listening ? 'Listening… nothing said yet.' : 'Not listening. Ctrl+Alt+L to start.') : ''}
      </div>
    )
  }
  return (
    <div className="transcript">
      {last.map((l) => (
        <div key={l.id} className={`tline ${l.speaker === 'ME' ? 'me' : 'them'} ${l.final ? '' : 'interim'}`}>
          <span className="who">{l.speaker}</span>
          <span className="said">{tail(l.text)}</span>
        </div>
      ))}
    </div>
  )
}

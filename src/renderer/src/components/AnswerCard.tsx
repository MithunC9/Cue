import type { ReactNode } from 'react'
import type { AnswerTrigger } from '@shared/types'

export interface CardState {
  id: number
  trigger: AnswerTrigger
  question: string
  text: string
  status: 'streaming' | 'done' | 'error'
  error?: string
  model?: string
  firstTokenMs?: number
  prepared?: { text: string; matched: string; confidence: number; source: 'qa' | 'notes' }
}

/** Renders **bold** spans without touching innerHTML. */
function inline(text: string): ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*)/g).map((seg, i) =>
    seg.startsWith('**') && seg.endsWith('**') && seg.length > 4 ? <strong key={i}>{seg.slice(2, -2)}</strong> : seg
  )
}

function Line({ line, first }: { line: string; first: boolean }) {
  // Citations belong on the sources line; drop any the model put inline.
  const t = /^\[sources?:/i.test(line.trim()) ? line.trim() : line.replace(/\s*\[src:[^\]]*\]/g, '').trim()
  if (!t) return null
  if (/^\[sources?:/i.test(t)) return <div className="sources">{t.replace(/^\[|\]$/g, '')}</div>
  if (t.startsWith('↳')) return <div className="deeper">{inline(t)}</div>
  if (/^clarify:/i.test(t)) return <div className="clarify">{inline(t)}</div>
  if (/^[•\-*]\s/.test(t)) return <div className="bullet">• {inline(t.replace(/^[•\-*]\s+/, ''))}</div>
  return <div className={first ? 'lead first' : 'lead'}>{inline(t)}</div>
}

const TRIGGER: Record<AnswerTrigger, string> = { typed: 'typed', hotkey: 'answer now', auto: 'heard', screenshot: 'screen' }

export function AnswerCard({ card }: { card: CardState | null }) {
  if (!card) return <div className="card idle">Ctrl+Alt+T to type a question · Ctrl+Alt+Enter to answer now</div>
  // Live text wins as soon as it starts streaming; until then (or if it fails) show the prepared answer.
  const showPrepared = !card.text && card.prepared
  const body = card.text || card.prepared?.text || ''
  const lines = body.split('\n').filter((l) => l.trim())
  const notInNotes = /not in (?:your|my) notes/i.test(lines[0] ?? '')
  return (
    <div className={`card ${card.status} ${notInNotes ? 'unverified' : ''} ${showPrepared ? 'prepared' : ''}`}>
      <div className="q">
        <span className="trig">{TRIGGER[card.trigger]}</span> {card.question}
      </div>
      {showPrepared && (
        <div className="prep-tag">
          {card.prepared!.source === 'qa' ? 'PREPARED' : 'FROM YOUR NOTES'}
          {card.status === 'streaming' ? ' · live answer coming…' : ''}{' '}
          {card.prepared!.source === 'qa' && <span className="dim">matched “{card.prepared!.matched}”</span>}
        </div>
      )}
      {body ? lines.map((l, i) => <Line key={i} line={l} first={i === 0} />) : card.status !== 'error' && <div className="thinking">thinking…</div>}
      {card.status === 'error' && <div className="err">{card.error}</div>}
    </div>
  )
}

import type { SlideView } from '@shared/types'

export function SlidePanel({ slide }: { slide: SlideView | null }) {
  if (!slide) return <div className="slide empty">Presentation mode: waiting to recognize a slide…</div>
  return (
    <div className="slide">
      <div className="slide-head">
        <span className="slide-no">
          SLIDE {slide.index}/{slide.total}
        </span>{' '}
        {slide.title}
        {slide.confidence < 0.6 && <span className="dim"> (?)</span>}
      </div>
      {slide.talkingPoints.map((p, i) => (
        <div key={i} className="point">
          • {p}
        </div>
      ))}
      {slide.likelyQuestion && (
        <div className="likely">
          <span className="lq">Likely Q:</span> {slide.likelyQuestion}
          {slide.answer && <div className="la">→ {slide.answer.replace(/\s*\[src:[^\]]*\]/g, '')}</div>}
        </div>
      )}
    </div>
  )
}

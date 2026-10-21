import type { UiState } from '@shared/types'

/** RMS (0..1) → 0..100% on a dB scale, so quiet speech still shows. */
const pct = (rms: number) => Math.max(0, Math.min(100, ((20 * Math.log10(rms + 1e-6) + 55) / 45) * 100))

export function Header({ ui, levels }: { ui: UiState; levels: [number, number] }) {
  return (
    <div className="header">
      <div
        className="handle"
        title="Drag to move"
        onPointerEnter={() => window.cue.handleHover(true)}
        onPointerLeave={() => window.cue.handleHover(false)}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId)
          window.cue.dragStart()
        }}
        onPointerUp={() => window.cue.dragEnd()}
        onPointerCancel={() => window.cue.dragEnd()}
      >
        ⋮⋮
      </div>
      <span className="title">Cue</span>
      {ui.presentation && <span className="chip">PRESENTING</span>}
      {ui.inputMode === 'type' && <span className="chip">TYPE</span>}
      {!ui.clickThrough && <span className="chip dim">mouse</span>}
      <span className="right">
      {ui.listening && (
        <span className="meters" title="Input levels: ME (mic) and THEM (Zoom audio)">
          <span className="meter me">
            <i style={{ width: `${pct(levels[0])}%` }} />
          </span>
          <span className="meter them">
            <i style={{ width: `${pct(levels[1])}%` }} />
          </span>
        </span>
      )}
      <span className={`listen ${ui.listening ? 'on' : ''}`}>{ui.listening ? '● Listening' : '○ Not listening'}</span>
      </span>
    </div>
  )
}

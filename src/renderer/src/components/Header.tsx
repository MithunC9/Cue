import type { UiState } from '@shared/types'

export function Header({ ui }: { ui: UiState }) {
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
      <span className={`listen ${ui.listening ? 'on' : ''}`}>{ui.listening ? '● Listening' : '○ Not listening'}</span>
    </div>
  )
}

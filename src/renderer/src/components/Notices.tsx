import { useEffect } from 'react'
import type { Notice } from '@shared/types'

export function Notices({ notices }: { notices: Notice[] }) {
  // Info notices fade after 10s; warnings and errors stay until dismissed or cleared (Ctrl+Alt+K).
  useEffect(() => {
    const timers = notices.filter((n) => n.level === 'info').map((n) => setTimeout(() => window.cue.dismissNotice(n.id), 10_000))
    return () => timers.forEach(clearTimeout)
  }, [notices])
  if (!notices.length) return null
  return (
    <div className="notices">
      {notices.map((n) => (
        <div key={n.id} className={`banner ${n.level}`} onClick={() => window.cue.dismissNotice(n.id)}>
          {n.text}
        </div>
      ))}
    </div>
  )
}

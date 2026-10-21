import { useEffect, useRef, useState } from 'react'
import type { InputMode } from '@shared/types'

export function InputBox({ mode }: { mode: InputMode }) {
  const [value, setValue] = useState('')
  const ref = useRef<HTMLTextAreaElement & HTMLInputElement>(null)
  useEffect(() => {
    setValue('')
    const t = setTimeout(() => ref.current?.focus(), 30)
    return () => clearTimeout(t)
  }, [mode])

  const submit = () => {
    const v = value.trim()
    if (!v) return
    if (mode === 'apikey') window.cue.submitApiKey(v)
    else window.cue.ask(v)
    setValue('')
  }
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      window.cue.exitInput()
    } else if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      submit()
    }
  }

  return (
    <div className="inputbox">
      {mode === 'apikey' ? (
        <input
          ref={ref}
          type="password"
          placeholder="Paste Gemini API key, Enter to save (encrypted) · Esc cancels"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={onKey}
        />
      ) : (
        <textarea
          ref={ref}
          rows={2}
          placeholder="Type a question · Enter to ask · Esc back to Zoom"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={onKey}
        />
      )}
    </div>
  )
}

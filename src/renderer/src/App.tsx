import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { AnswerEvent, TranscriptLine, UiState } from '@shared/types'
import { AnswerCard, type CardState } from './components/AnswerCard'
import { Header } from './components/Header'
import { InputBox } from './components/InputBox'
import { Notices } from './components/Notices'
import { SlidePanel } from './components/SlidePanel'
import { StatusBar } from './components/StatusBar'
import { Transcript } from './components/Transcript'

export function App() {
  const [ui, setUi] = useState<UiState | null>(null)
  const [card, setCard] = useState<CardState | null>(null)
  const [lines, setLines] = useState<TranscriptLine[]>([])
  const panel = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const offState = window.cue.onState(setUi)
    const offTranscript = window.cue.onTranscript(setLines)
    const offAnswer = window.cue.onAnswer((e: AnswerEvent) => {
      setCard((prev) => {
        switch (e.kind) {
          case 'clear':
            return null
          case 'start':
            return { id: e.id, trigger: e.trigger, question: e.question, text: '', status: 'streaming' }
          case 'prepared':
            return prev && prev.id === e.id ? { ...prev, prepared: { text: e.text, matched: e.matched, confidence: e.confidence, source: e.source } } : prev
          case 'delta':
            return prev && prev.id === e.id ? { ...prev, text: e.text } : prev
          case 'done':
            return prev && prev.id === e.id
              ? { ...prev, text: e.text, status: 'done', model: e.model, firstTokenMs: e.firstTokenMs }
              : prev
          case 'error':
            return prev && prev.id === e.id ? { ...prev, status: 'error', error: e.message } : prev
        }
      })
      if (e.kind === 'clear') setLines([])
    })
    window.cue.ready()
    return () => {
      offState()
      offTranscript()
      offAnswer()
    }
  }, [])

  // The window hugs the panel so transparent space never blocks clicks on Zoom underneath.
  useLayoutEffect(() => {
    const el = panel.current
    if (!el) return
    const ro = new ResizeObserver(() => window.cue.resize(el.getBoundingClientRect().height + 2))
    ro.observe(el)
    return () => ro.disconnect()
  }, [ui === null])

  if (!ui) return null
  return (
    <div
      ref={panel}
      className={`panel material-${ui.material}`}
      style={{ ['--fs' as string]: `${ui.fontSize}px` }}
    >
      {ui.selfTestPattern && <div className="selftest" />}
      <Header ui={ui} />
      {ui.hotkeyFailures.length > 0 && (
        <div className="banner error">Hotkeys not registered: {ui.hotkeyFailures.join(' · ')}</div>
      )}
      <Notices notices={ui.notices} />
      <Transcript lines={lines} listening={ui.listening} available={ui.listeningAvailable} />
      {ui.inputMode !== 'none' && <InputBox mode={ui.inputMode} />}
      <AnswerCard card={card} />
      {ui.presentation && <SlidePanel />}
      <StatusBar ui={ui} />
    </div>
  )
}

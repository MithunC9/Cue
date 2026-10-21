// The only bridge between the overlay page and the main process. No Node access in the page.
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { AnswerEvent, CueBridge, TranscriptLine, UiState } from '../shared/types'

function on<T>(channel: string, cb: (v: T) => void): () => void {
  const listener = (_e: IpcRendererEvent, v: T) => cb(v)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const bridge: CueBridge = {
  onState: (cb) => on<UiState>('cue:state', cb),
  onAnswer: (cb) => on<AnswerEvent>('cue:answer', cb),
  onTranscript: (cb) => on<TranscriptLine[]>('cue:transcript', cb),
  onLevels: (cb) => on<[number, number]>('cue:levels', ([me, them]) => cb(me, them)),
  ready: () => ipcRenderer.send('cue:ready'),
  ask: (text) => ipcRenderer.send('cue:ask', text),
  submitApiKey: (key) => ipcRenderer.send('cue:apikey', key),
  exitInput: () => ipcRenderer.send('cue:exit-input'),
  dismissNotice: (id) => ipcRenderer.send('cue:dismiss', id),
  dragStart: () => ipcRenderer.send('cue:drag-start'),
  dragEnd: () => ipcRenderer.send('cue:drag-end'),
  handleHover: (over) => ipcRenderer.send('cue:handle-hover', over),
  resize: (h) => ipcRenderer.send('cue:resize', h)
}

contextBridge.exposeInMainWorld('cue', bridge)

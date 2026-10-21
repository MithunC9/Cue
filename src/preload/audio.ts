// Bridge for the hidden audio window.
import { contextBridge, ipcRenderer } from 'electron'
import type { AudioBridge } from '../shared/audio'

const bridge: AudioBridge = {
  onCommand: (cb) => void ipcRenderer.on('audio:command', (_e, cmd) => cb(cmd)),
  frames: (speaker, pcm) => ipcRenderer.send('audio:frames', speaker, pcm),
  utteranceStart: (speaker) => ipcRenderer.send('audio:utterance-start', speaker),
  utteranceEnd: (speaker) => ipcRenderer.send('audio:utterance-end', speaker),
  levels: (me, them) => ipcRenderer.send('audio:levels', me, them),
  status: (state, detail) => ipcRenderer.send('audio:status', state, detail),
  devices: (list) => ipcRenderer.send('audio:devices', list),
  readTestFile: (path) => ipcRenderer.invoke('audio:read-test-file', path)
}

contextBridge.exposeInMainWorld('cueAudio', bridge)

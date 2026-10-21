import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    build: {
      externalizeDeps: { include: ['koffi'] },
      rollupOptions: { input: { index: resolve(__dirname, 'src/main/index.ts') } }
    },
    resolve: { alias: { '@shared': resolve(__dirname, 'src/shared') } }
  },
  preload: {
    build: {
      rollupOptions: { input: { index: resolve(__dirname, 'src/preload/index.ts'), audio: resolve(__dirname, 'src/preload/audio.ts') } }
    },
    resolve: { alias: { '@shared': resolve(__dirname, 'src/shared') } }
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    build: {
      rollupOptions: { input: { index: resolve(__dirname, 'src/renderer/index.html'), audio: resolve(__dirname, 'src/renderer/audio.html') } }
    },
    resolve: { alias: { '@shared': resolve(__dirname, 'src/shared') } },
    plugins: [react()]
  }
})

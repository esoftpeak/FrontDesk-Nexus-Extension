import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { chromeExtension } from 'vite-plugin-chrome-extension'

export default defineConfig({
  plugins: [react(), chromeExtension()],
  build: {
    rollupOptions: {
      input: 'manifest.json'
    }
  }
})
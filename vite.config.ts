import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { crx } from '@crxjs/vite-plugin'
import manifest from './manifest.config'

export default defineConfig({
  base: './',
  plugins: [react(), crx({ manifest })],
  build: {
    rollupOptions: {
      input: {
        // Explicitly declare so Vite bundles main.ts into the page (CRXJS alone skips WAR entries)
        'registration-card': 'registration-card.html',
      },
    },
  },
})

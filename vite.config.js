import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

// For GitHub Pages: https://<user>.github.io/<repo>/
// Override via VITE_BASE env var if your Pages URL differs.
const base = process.env.VITE_BASE ?? '/Juliet/'

export default defineConfig({
  base,
  plugins: [vue()],
  build: {
    target: 'es2020',
  },
})

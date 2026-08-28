import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// /r2 is the app's own path to the private data bucket; see R2_BASE in utils/epmFetch.
// Production does this with a rewrite in vercel.json, so dev has to mirror it or the
// R2 branches load nothing locally.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/r2': {
        target: 'https://pub-fbe9fb64480745d48ed524b3803b349d.r2.dev',
        changeOrigin: true,
        rewrite: p => p.replace(/^\/r2/, ''),
      },
    },
  },
})

import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Browser mluví VŽDYCKY jen s tímhle serverem (stejný origin) a /api proxyujeme
// na Fastify. Žádné volání localhost:8080 z kódu, který běží v prohlížeči — to by
// v sandboxu ani za reverse proxy nefungovalo.
export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',        // ne 127.0.0.1 — kvůli live preview
    port: Number(process.env.WEB_PORT ?? 5173),
    strictPort: false,
    // Live preview běží pod *.e2b.app; Vite má defaultně allowlist jen localhost.
    allowedHosts: true,
    proxy: {
      '/api': {
        target: process.env.API_URL ?? 'http://127.0.0.1:8080',
        changeOrigin: true,
      },
    },
  },
  preview: { host: '0.0.0.0', port: 4173, allowedHosts: true },
})

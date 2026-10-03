import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  root: 'client',
  base: '/dist/',
  plugins: [react()],
  publicDir: false,
  build: {
    outDir: '../public/dist',
    emptyOutDir: true,
    target: 'esnext',
    minify: false,
    rollupOptions: {
      output: {
        entryFileNames: 'app.js',
        chunkFileNames: 'chunks/[name]-[hash].js',
        assetFileNames: 'app.[ext]',
      },
    },
  },
  server: {
    port: 5173,
    strictPort: false,
    proxy: {
      '/api': 'http://127.0.0.1:8787',
      '/uploads': 'http://127.0.0.1:8787',
    },
  },
})

import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: true,
    proxy: {
      '/api': 'http://localhost:8002',
    },
  },
  build: {
    rollupOptions: {
      // Capacitor native plugins are injected by the native bridge at runtime;
      // they must not be bundled into the web build.
      external: [
        '@capacitor-community/background-geolocation',
        '@revenuecat/purchases-capacitor',
      ],
    },
  },
})

import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    allowedHosts: true, // Allows ngrok URLs to load your UI securely
    proxy: {
      // Proxies all authentication requests to NestJS
      '/auth': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
      // Proxies all meeting room CRUD requests to NestJS
      '/meetings': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
      // Proxies all real-time Socket.io signaling connections to NestJS WebRTC gateway
      '/socket.io': {
        target: 'http://localhost:3000',
        ws: true,
        changeOrigin: true,
      },
    },
  },
})

import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const elliGameRoutePlugin = () => ({
  name: 'elli-game-route-rewrite',
  configureServer(server) {
    server.middlewares.use((req, _res, next) => {
      if (req.url === '/elli-game' || req.url === '/elli-game/') {
        req.url = '/elli-game.html'
      }
      next()
    })
  },
  configurePreviewServer(server) {
    server.middlewares.use((req, _res, next) => {
      if (req.url === '/elli-game' || req.url === '/elli-game/') {
        req.url = '/elli-game.html'
      }
      next()
    })
  },
})

// https://vite.dev/config/
export default defineConfig({
  plugins: [elliGameRoutePlugin(), react()],
  server: {
    host: true,
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3001',
    },
  },
})

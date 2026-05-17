import { fileURLToPath } from 'node:url'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import { defineConfig } from 'vite'
import viteReact from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { nitro } from 'nitro/vite'

// Resolve once at config time so the Nitro builder gets an absolute path
// regardless of where the dev/build command is invoked from.
const securityHeadersMiddleware = fileURLToPath(
  new URL('./server/middleware/security-headers.ts', import.meta.url),
)

export default defineConfig({
  server: {
    port: 3000,
  },
  resolve: {
    tsconfigPaths: true,
  },
  plugins: [
    tailwindcss(),
    tanstackStart({
      srcDirectory: 'src',
    }),
    viteReact(),
    nitro(),
  ],
  // TanStack Start's Vite plugin reconfigures Nitro's scanDirs to only look
  // inside `src/`, so a file under ./server/middleware/ isn't picked up
  // automatically — register the SECURITY-AUDIT F-013 middleware explicitly
  // here. Route `/**` + middleware:true makes it run before every other
  // route handler (SSR HTML, API JSON, healthz, logout, the lot).
  nitro: {
    handlers: [
      {
        route: '/**',
        middleware: true,
        handler: securityHeadersMiddleware,
      },
    ],
  },
})

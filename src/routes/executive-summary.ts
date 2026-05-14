import { createFileRoute } from '@tanstack/react-router'
import html from '../../executive-summary.html?raw'

export const Route = createFileRoute('/executive-summary')({
  server: {
    handlers: {
      GET: () =>
        new Response(html, {
          headers: { 'Content-Type': 'text/html; charset=utf-8' },
        }),
    },
  },
})

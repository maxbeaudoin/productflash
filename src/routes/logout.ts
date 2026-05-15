import { createFileRoute } from '@tanstack/react-router'
import { auth } from '~/lib/auth'

// Hard sign-out via direct GET on /logout. We forward the response Better
// Auth produces (it already carries the Set-Cookie clears via the
// tanstack-start cookie plugin) and rewrite the Location header to point
// back to the landing page.
export const Route = createFileRoute('/logout')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const response = await auth.api.signOut({
          headers: request.headers,
          asResponse: true,
        })
        const headers = new Headers(response.headers)
        headers.set('Location', '/')
        return new Response(null, { status: 302, headers })
      },
    },
  },
})

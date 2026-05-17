import { defineEventHandler, setResponseHeader } from 'nitro/h3'

// Sets baseline security headers on every Nitro response. Nitro auto-loads
// any file under `server/middleware/` and runs it before route handlers.
//
// CSP is intentionally deferred (see SECURITY-AUDIT F-013). The 4 headers
// below are zero-risk: HSTS forces HTTPS, X-Frame-Options blocks clickjacking
// against /admin and /logout, X-Content-Type-Options prevents MIME sniffing
// on user-fetchable bytes (the email tracking pixel, JSON endpoints), and
// strict-origin-when-cross-origin caps Referer leakage to the path on
// cross-site navigations. A follow-up rolls out CSP in report-only mode.
export default defineEventHandler((event) => {
  setResponseHeader(event, 'Strict-Transport-Security', 'max-age=31536000; includeSubDomains')
  setResponseHeader(event, 'X-Frame-Options', 'DENY')
  setResponseHeader(event, 'X-Content-Type-Options', 'nosniff')
  setResponseHeader(event, 'Referrer-Policy', 'strict-origin-when-cross-origin')
})

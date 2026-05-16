import posthog from 'posthog-js'

// Client-side PostHog (#20). Reads the same VITE_POSTHOG_KEY the server
// reads via process.env — PostHog's "project API key" is a single value that
// drives both posthog-js and posthog-node, so one env var serves both. Dev
// without analytics leaves it unset and every helper short-circuits.

const KEY: string | undefined = import.meta.env.VITE_POSTHOG_KEY
const HOST: string = import.meta.env.VITE_POSTHOG_HOST ?? 'https://us.i.posthog.com'

let initialized = false

export function initPostHog(): void {
  if (initialized) return
  if (!KEY) return
  if (typeof window === 'undefined') return
  posthog.init(KEY, {
    api_host: HOST,
    capture_pageview: false,
    capture_pageleave: true,
    person_profiles: 'identified_only',
    // PostHog Error Tracking (#51). Auto-captures window.onerror +
    // unhandledrejection. React render errors don't surface through these
    // — they go through TanStack Router's errorComponent (DefaultCatchBoundary)
    // which calls captureClientException() explicitly.
    capture_exceptions: true,
  })
  initialized = true
}

export function capturePageview(pathname: string): void {
  if (!initialized) return
  posthog.capture('$pageview', { $pathname: pathname })
}

export function captureClient(event: string, properties: Record<string, unknown> = {}): void {
  if (!initialized) return
  posthog.capture(event, properties)
}

export function captureClientException(
  err: unknown,
  extra: Record<string, unknown> = {},
): void {
  if (!initialized) return
  // posthog.captureException accepts unknown — it stringifies non-Error inputs.
  posthog.captureException(err, extra)
}

export function identifyPostHog(distinctId: string, traits: Record<string, unknown> = {}): void {
  if (!initialized) return
  posthog.identify(distinctId, traits)
}

export function resetPostHog(): void {
  if (!initialized) return
  posthog.reset()
}

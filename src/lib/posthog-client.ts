import posthog from 'posthog-js'

// Client-side PostHog (#20). Init guarded by VITE_POSTHOG_KEY so dev without
// analytics is a silent no-op — every helper short-circuits when the key is
// absent. Mirrors the server-side `captureServerEvent` shape so callers don't
// need to think about which environment they're in.
//
// posthog-js uses the same project key as posthog-node; PostHog itself has no
// "public vs secret" key distinction. VITE_ prefix is the standard Vite
// convention for client-visible env vars.

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

export function identifyPostHog(distinctId: string, traits: Record<string, unknown> = {}): void {
  if (!initialized) return
  posthog.identify(distinctId, traits)
}

export function resetPostHog(): void {
  if (!initialized) return
  posthog.reset()
}

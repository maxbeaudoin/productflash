import { PostHog } from "posthog-node";
import { env } from "./env";
import { logger } from "./logger";

// Server-side PostHog client (lazy-init, single instance per process).
//
// Used by the worker for pipeline events (ingestion_run, digest_sent, …)
// and by server functions for funnel events (signup_completed). When
// POSTHOG_API_KEY is unset (local dev without analytics) every call is a
// no-op so callers never need a guard.

let _client: PostHog | null | undefined;

function getClient(): PostHog | null {
  if (_client !== undefined) return _client;
  if (!env.VITE_POSTHOG_KEY) {
    logger.debug("posthog: VITE_POSTHOG_KEY unset, capture is a no-op");
    _client = null;
    return null;
  }
  _client = new PostHog(env.VITE_POSTHOG_KEY, {
    host: env.VITE_POSTHOG_HOST,
    // Worker fires a small number of events per day; flush on every capture
    // so a kill -9 doesn't drop the daily ingestion_run event.
    flushAt: 1,
    flushInterval: 0,
  });
  return _client;
}

export function captureServerEvent(
  distinctId: string,
  event: string,
  properties: Record<string, unknown> = {},
): void {
  const client = getClient();
  if (!client) return;
  client.capture({ distinctId, event, properties: properties as Record<string, unknown> });
}

// Ship a thrown error to PostHog Error Tracking (#51). distinctId is optional
// because some failures (worker start-up, pg-boss internal errors) don't have
// a user to attribute to — they land against the 'worker' system identity.
export function captureServerException(
  err: unknown,
  distinctId: string | undefined,
  extra: Record<string, unknown> = {},
): void {
  const client = getClient();
  if (!client) return;
  // posthog-node's captureException coerces unknown into an Error-shaped event.
  // Wrap non-Error values so the stack trace surface stays useful in the UI.
  const exception = err instanceof Error ? err : new Error(String(err));
  client.captureException(exception, distinctId ?? "worker", extra);
}

export async function shutdownPosthog(): Promise<void> {
  if (!_client) return;
  try {
    await _client.shutdown(5_000);
  } catch (err) {
    logger.warn({ err }, "posthog: shutdown failed");
  }
  _client = null;
}

import { ErrorComponentProps } from "@tanstack/react-router";
import { useEffect } from "react";
import { captureClientException } from "~/shared/client/posthog-client";

export function DefaultCatchBoundary({ error, info }: ErrorComponentProps) {
  useEffect(() => {
    // React render errors don't trigger window.onerror, so posthog-js's
    // exception autocapture misses them. TanStack Router routes errors here;
    // ship to PostHog Error Tracking (#51) before rendering the fallback.
    captureClientException(error, {
      component_stack: info?.componentStack ?? null,
    });
  }, [error, info?.componentStack]);

  return (
    <div className="p-8">
      <h1 className="text-2xl font-semibold">Something went wrong</h1>
      <pre className="mt-4 overflow-auto rounded bg-black/5 p-3 text-xs">{error.message}</pre>
    </div>
  );
}

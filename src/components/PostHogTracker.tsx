import { useRouterState } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import { capturePageview, initPostHog } from "~/shared/client/posthog-client";

// Renders nothing — initializes posthog-js on mount and fires a $pageview each
// time TanStack Router commits a new pathname. Mounted in __root.tsx so every
// route (landing, app, admin) is covered. No-op when VITE_POSTHOG_KEY is unset.
export function PostHogTracker() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const lastPathRef = useRef<string | null>(null);

  useEffect(() => {
    initPostHog();
  }, []);

  useEffect(() => {
    if (lastPathRef.current === pathname) return;
    lastPathRef.current = pathname;
    capturePageview(pathname);
  }, [pathname]);

  return null;
}

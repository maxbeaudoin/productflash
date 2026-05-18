/// <reference types="vite/client" />
import { HeadContent, Scripts, createRootRoute } from "@tanstack/react-router";
import { TanStackRouterDevtools } from "@tanstack/react-router-devtools";
import { useEffect, type ReactNode } from "react";
import { DefaultCatchBoundary } from "~/components/DefaultCatchBoundary";
import { NotFound } from "~/components/NotFound";
import { PostHogTracker } from "~/components/PostHogTracker";
import { Toaster } from "~/components/ui/sonner";
import appCss from "~/styles/app.css?url";

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "Product Flash — daily competitive intel for SaaS product leaders" },
    ],
    links: [
      { rel: "stylesheet", href: appCss },
      { rel: "icon", type: "image/svg+xml", href: "/favicon.svg" },
    ],
  }),
  errorComponent: DefaultCatchBoundary,
  notFoundComponent: () => <NotFound />,
  shellComponent: RootDocument,
});

function RootDocument({ children }: { children: ReactNode }) {
  return (
    <html>
      <head>
        <HeadContent />
      </head>
      <body>
        <HydrationMarker />
        <PostHogTracker />
        {children}
        <Toaster theme="dark" />
        {import.meta.env.DEV ? <TanStackRouterDevtools position="bottom-right" /> : null}
        <Scripts />
      </body>
    </html>
  );
}

// Stamps <html data-hydrated="true"> once React has mounted on the client.
// e2e tests await this attribute instead of `waitUntil: "networkidle"` —
// it's a deterministic, ~0-cost signal that interactive event handlers
// are bound, so a click won't race a not-yet-hydrated form into a native
// POST.
function HydrationMarker() {
  useEffect(() => {
    document.documentElement.dataset.hydrated = "true";
  }, []);
  return null;
}

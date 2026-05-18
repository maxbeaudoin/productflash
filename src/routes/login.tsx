import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { LoginPage } from "~/features/auth/ui/login-page";

// Better Auth appends `?error=<code>` to the social errorCallbackURL.
// Known codes worth differentiating: `signup_disabled` (uninvited email →
// route to waitlist), everything else (generic "try again"). Accept any
// string so an unknown code still routes to the generic branch instead
// of 500-ing the loader.
const searchSchema = z.object({
  reason: z.enum(["unauthenticated"]).optional(),
  error: z.string().optional(),
});

export const Route = createFileRoute("/login")({
  validateSearch: searchSchema,
  component: LoginRoute,
});

function LoginRoute() {
  const { reason, error } = Route.useSearch();
  return <LoginPage reason={reason} oauthError={error} />;
}

import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { submitSignup, verifyInvite } from "~/features/auth/server/signup";
import { FteSignupForm } from "~/features/auth/ui/fte-signup-form";
import { InviteGate } from "~/features/auth/ui/invite-gate";

// The public funnel is invite-only (see #33/#34). Admins issue signed
// `?invite=<token>` URLs from /admin/waitlist; a bare /signup or a tampered
// token shows the gate. Valid tokens render the FTE intake form with the
// email prefilled and locked — the user can only sign up as the address the
// invite was issued to. Submitting kicks off the FTE agent (#28) and auto-
// signs the user in (#38): the invite token's HMAC is the trust anchor, so
// we skip the magic-link email round-trip and return a one-shot verify URL
// the client navigates to — establishing the Better Auth session cookie.
const searchSchema = z.object({
  invite: z.string().min(1).optional(),
});

export const Route = createFileRoute("/signup")({
  validateSearch: searchSchema,
  loaderDeps: ({ search: { invite } }) => ({ invite }),
  loader: async ({ deps }) => {
    const { email, defaults } = await verifyInvite({ data: { token: deps.invite } });
    return { email, defaults, inviteToken: deps.invite ?? null };
  },
  component: SignupPage,
});

function SignupPage() {
  const { email, defaults, inviteToken } = Route.useLoaderData();
  if (!email || !inviteToken) return <InviteGate />;
  return (
    <FteSignupForm
      email={email}
      defaults={defaults}
      onSubmit={(values) =>
        submitSignup({
          data: {
            inviteToken,
            companyUrl: values.companyUrl,
            position: values.position,
            ultimateGoal: values.ultimateGoal,
            tz: values.tz,
          },
        })
      }
    />
  );
}

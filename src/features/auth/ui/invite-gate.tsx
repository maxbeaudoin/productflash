import { Link } from "@tanstack/react-router";
import { AuthShell } from "~/features/auth/ui/auth-shell";

// Shown on /signup when the invite token is missing, malformed, or expired.
// Funnels visitors to the public waitlist instead of leaking that we're
// invite-only via a generic error.
export function InviteGate() {
  return (
    <AuthShell
      eyebrow="Invite only"
      headlineLead="Private beta,"
      headlineAccent="by invite."
      sub="New seats open on a rolling basis. Drop your email on the waitlist and we'll be in touch when one frees up."
      footnote={
        <span>
          Already signed in?{" "}
          <Link to="/login" className="text-white underline-offset-4 hover:underline">
            Log in →
          </Link>
        </span>
      }
    >
      <Link
        to="/"
        hash="waitlist"
        className="group inline-flex h-12 items-center justify-center gap-[10px] rounded-pill bg-accent px-8 text-base font-semibold text-ink transition-transform duration-150 hover:-translate-y-px"
      >
        Request early access
        <span
          aria-hidden
          className="transition-transform duration-150 group-hover:translate-x-[3px]"
        >
          →
        </span>
      </Link>
    </AuthShell>
  );
}

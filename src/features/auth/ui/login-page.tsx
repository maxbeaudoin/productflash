import { useForm } from "@tanstack/react-form";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";
import { FieldShell, fieldHasError } from "~/components/forms/field-shell";
import { signIn } from "~/features/auth/client/auth-client";
import { magicLinkFormSchema } from "~/features/auth/schema";
import { AuthShell } from "~/features/auth/ui/auth-shell";

export type LoginPageProps = {
  /** `?reason=unauthenticated` is set when /app guards redirect here. */
  reason?: "unauthenticated";
  /** `?error=<code>` set by Better Auth's OAuth errorCallbackURL. */
  oauthError?: string;
};

export function LoginPage({ reason, oauthError }: LoginPageProps) {
  const [sentEmail, setSentEmail] = useState<string | null>(null);
  const [googleState, setGoogleState] = useState<"idle" | "redirecting">("idle");

  const form = useForm({
    defaultValues: { email: "" },
    validators: { onChange: magicLinkFormSchema },
    onSubmit: async ({ value }) => {
      const { error } = await signIn.magicLink({ email: value.email, callbackURL: "/app" });
      if (error) {
        toast.error(error.message ?? "Couldn't send the magic link. Try again in a moment.");
        throw new Error("magic_link_failed");
      }
      setSentEmail(value.email);
    },
  });

  async function onGoogle() {
    setGoogleState("redirecting");
    // The success path is a full redirect to Google → /api/auth/callback/google
    // → /app, so we never return here on success. On failure (most likely
    // `disableSignUp` for an uninvited email) Better Auth redirects to
    // errorCallbackURL with `?error=...` and we re-render with the banner.
    // errorCallbackURL must NOT have a query string — Better Auth appends
    // its own `&error=<code>` (e.g. `signup_disabled`), so passing
    // `/login?error=oauth` produces `/login?error=oauth&error=signup_disabled`
    // which the loader's Zod schema parses as an array and 500s.
    await signIn.social({
      provider: "google",
      callbackURL: "/app",
      errorCallbackURL: "/login",
    });
    setGoogleState("idle");
  }

  return (
    <AuthShell
      eyebrow={reason === "unauthenticated" ? "Session expired" : "Sign in"}
      headlineLead="Welcome"
      headlineAccent="back."
      sub="Enter your email — we'll send a one-time link to sign you in. No password to remember."
      footnote={
        <span>
          New here?{" "}
          <Link to="/" hash="waitlist" className="text-white underline-offset-4 hover:underline">
            Request early access →
          </Link>
        </span>
      }
    >
      {sentEmail ? (
        <SentCard
          email={sentEmail}
          onReset={() => {
            setSentEmail(null);
            form.reset();
          }}
        />
      ) : (
        <div className="grid gap-4">
          {oauthError === "signup_disabled" ? (
            <div className="rounded-md border border-coral/40 bg-coral/10 px-4 py-3 text-sm text-coral">
              <p className="font-semibold">That email isn't on the private beta yet.</p>
              <p className="mt-1 text-coral/80">
                Product Flash is invite-only.{" "}
                <Link to="/" hash="waitlist" className="underline-offset-4 hover:underline">
                  Request early access
                </Link>{" "}
                and we'll be in touch when a seat opens.
              </p>
            </div>
          ) : oauthError ? (
            <div className="rounded-md border border-coral/40 bg-coral/10 px-4 py-3 text-sm text-coral">
              <p className="font-semibold">Couldn't complete Google sign-in.</p>
              <p className="mt-1 text-coral/80">Try again, or use the email magic link below.</p>
            </div>
          ) : null}

          <button
            type="button"
            onClick={onGoogle}
            disabled={googleState === "redirecting"}
            className="inline-flex h-12 w-full items-center justify-center gap-3 rounded-md border-[1.5px] border-[#2a2a38] bg-white px-4 text-base font-semibold text-ink transition-transform duration-150 hover:-translate-y-px disabled:cursor-not-allowed disabled:opacity-70 disabled:hover:translate-y-0"
          >
            <GoogleG />
            {googleState === "redirecting" ? "Redirecting…" : "Continue with Google"}
          </button>

          <div className="flex items-center gap-3 text-[11px] font-semibold uppercase tracking-[0.15em] text-[#5a5a6a]">
            <span className="h-px flex-1 bg-[#2a2a38]" />
            or
            <span className="h-px flex-1 bg-[#2a2a38]" />
          </div>

          <form
            noValidate
            onSubmit={(e) => {
              e.preventDefault();
              void form.handleSubmit();
            }}
            className="grid gap-4"
          >
            <form.Field name="email">
              {(field) => (
                <FieldShell
                  field={field}
                  label="Email"
                  labelClassName="text-[11px] font-semibold uppercase tracking-[0.12em] text-[#8a8a98]"
                >
                  <input
                    id={field.name}
                    type="email"
                    autoFocus
                    autoComplete="email"
                    value={field.state.value}
                    onBlur={field.handleBlur}
                    onChange={(e) => field.handleChange(e.target.value)}
                    aria-invalid={fieldHasError(field)}
                    placeholder="you@company.com"
                    className="h-12 w-full rounded-md border-[1.5px] border-[#2a2a38] bg-ink-soft px-4 text-base font-normal normal-case tracking-normal text-white outline-none placeholder:text-[#5a5a6a] transition-colors focus:border-accent aria-invalid:border-coral aria-invalid:focus:border-coral"
                  />
                </FieldShell>
              )}
            </form.Field>

            <form.Subscribe
              selector={(s) => ({ canSubmit: s.canSubmit, isSubmitting: s.isSubmitting })}
            >
              {({ canSubmit, isSubmitting }) => (
                <button
                  type="submit"
                  disabled={!canSubmit}
                  className="group mt-2 inline-flex h-12 items-center justify-center gap-[10px] rounded-pill bg-accent px-8 text-base font-semibold text-ink transition-transform duration-150 hover:-translate-y-px disabled:cursor-not-allowed disabled:opacity-70 disabled:hover:translate-y-0"
                >
                  {isSubmitting ? "Sending…" : "Send magic link"}
                  <span
                    aria-hidden
                    className="transition-transform duration-150 group-hover:translate-x-[3px] group-disabled:hidden"
                  >
                    →
                  </span>
                </button>
              )}
            </form.Subscribe>
          </form>
        </div>
      )}
    </AuthShell>
  );
}

// Official Google "G" mark — required by Google's branding guidelines on
// any "Sign in with Google" button. Lucide has no exact equivalent.
function GoogleG() {
  return (
    <svg width="20" height="20" viewBox="0 0 48 48" aria-hidden focusable="false">
      <path
        fill="#EA4335"
        d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
      />
      <path
        fill="#4285F4"
        d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
      />
      <path
        fill="#FBBC05"
        d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
      />
      <path
        fill="#34A853"
        d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
      />
      <path fill="none" d="M0 0h48v48H0z" />
    </svg>
  );
}

function SentCard({ email, onReset }: { email: string; onReset: () => void }) {
  return (
    <div
      className="overflow-hidden rounded-card-lg border border-[#2a2a38] bg-ink-soft"
      style={{ boxShadow: "0 40px 80px rgba(0,0,0,0.4)" }}
    >
      <div className="flex items-center justify-between border-b border-[#2a2a38] bg-[#1a1a23] px-6 py-4">
        <div className="inline-flex items-center gap-[8px] text-[11px] font-semibold uppercase tracking-[0.15em] text-accent">
          <span
            aria-hidden
            className="h-[6px] w-[6px] rounded-full bg-accent"
            style={{ boxShadow: "0 0 12px var(--color-accent)" }}
          />
          Sent
        </div>
        <div className="font-mono text-xs text-[#888]">expires in 5 min</div>
      </div>
      <div className="px-6 py-7">
        <p className="text-lg font-semibold text-white">Check your inbox.</p>
        <p className="mt-2 text-sm text-[#b8b8c8]">
          If <span className="font-mono text-white">{email}</span> is on the private beta, we just
          sent a sign-in link. Click it from the same browser and you'll land in the app.
        </p>
        <p className="mt-3 text-sm text-[#8a8a98]">
          Not on the list yet?{" "}
          <Link to="/" hash="waitlist" className="text-white underline-offset-4 hover:underline">
            Request early access →
          </Link>
        </p>
        <button
          type="button"
          onClick={onReset}
          className="mt-5 text-sm text-[#8a8a98] underline-offset-4 hover:text-white hover:underline"
        >
          Use a different email
        </button>
      </div>
    </div>
  );
}

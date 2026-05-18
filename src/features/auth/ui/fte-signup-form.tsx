import { useForm } from "@tanstack/react-form";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";
import { FieldShell, fieldHasError } from "~/components/forms/field-shell";
import { signupFormSchema, type SignupFormValues } from "~/features/auth/schema";
import { AuthShell } from "~/features/auth/ui/auth-shell";

// Submit result shape used by the form. Mirrors `SubmitResult` in
// `~/features/auth/server/signup` — kept duplicated rather than imported so
// UI doesn't pull a server module (lint guard).
type SubmitError = "invalid_invite" | "already_confirmed" | "user_insert_failed" | "session_failed";
export type FteSignupSubmitResult =
  | { ok: true; email: string; signInUrl: string }
  | { ok: false; error: SubmitError };

export function FteSignupForm({
  email,
  defaults,
  onSubmit,
}: {
  email: string;
  defaults: { position: string; companyUrl: string } | null;
  onSubmit: (values: SignupFormValues & { tz?: string }) => Promise<FteSignupSubmitResult>;
}) {
  const [redirecting, setRedirecting] = useState(false);

  const form = useForm({
    defaultValues: {
      companyUrl: defaults?.companyUrl ?? "",
      position: defaults?.position ?? "",
      ultimateGoal: "",
    },
    validators: { onChange: signupFormSchema },
    onSubmit: async ({ value }) => {
      const res = await onSubmit({
        companyUrl: value.companyUrl,
        position: value.position,
        ultimateGoal: value.ultimateGoal,
        tz: detectBrowserTz(),
      });
      if (!res.ok) {
        toast.error(messageForError(res.error));
        throw new Error("signup_failed");
      }
      // Full-page nav so Better Auth's redirect + Set-Cookie land naturally.
      // The verify URL is single-use and expires in 60s; consuming it now
      // creates the session and routes to /app → /app/onboarding.
      setRedirecting(true);
      window.location.href = res.signInUrl;
    },
  });

  const labelClass = "text-[11px] font-semibold uppercase tracking-[0.12em] text-[#8a8a98]";
  const inputClass =
    "h-12 w-full rounded-md border-[1.5px] border-[#2a2a38] bg-ink-soft px-4 text-base font-normal normal-case tracking-normal text-white outline-none placeholder:text-[#5a5a6a] transition-colors focus:border-accent aria-invalid:border-coral aria-invalid:focus:border-coral";
  const textareaClass =
    "min-h-[96px] w-full rounded-md border-[1.5px] border-[#2a2a38] bg-ink-soft px-4 py-3 text-base font-normal normal-case tracking-normal text-white outline-none placeholder:text-[#5a5a6a] transition-colors focus:border-accent aria-invalid:border-coral aria-invalid:focus:border-coral";

  return (
    <AuthShell
      eyebrow="You're invited"
      headlineLead="Tell us"
      headlineAccent="who you are."
      sub="Four lines, then your AI analyst goes to work — researching your space, finding your competitors, and shaping your first brief in real time."
      footnote={
        <span>
          Not you?{" "}
          <Link to="/" hash="waitlist" className="text-white underline-offset-4 hover:underline">
            Join the waitlist instead →
          </Link>
        </span>
      }
    >
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void form.handleSubmit();
        }}
        className="grid gap-4"
      >
        <FieldLabel label="Email" hint="locked to invite">
          <input
            type="email"
            value={email}
            readOnly
            autoComplete="email"
            className="h-12 w-full rounded-md border-[1.5px] border-[#2a2a38] bg-ink/60 px-4 text-base font-normal normal-case tracking-normal text-white outline-none cursor-not-allowed"
          />
        </FieldLabel>

        <form.Field name="companyUrl">
          {(field) => (
            <FieldShell
              field={field}
              labelClassName={labelClass}
              label={<FieldLabelText label="Company URL" />}
            >
              <input
                id={field.name}
                type="url"
                autoFocus={!defaults?.companyUrl}
                autoComplete="url"
                placeholder="https://yourcompany.com"
                value={field.state.value}
                onBlur={field.handleBlur}
                onChange={(e) => field.handleChange(e.target.value)}
                aria-invalid={fieldHasError(field)}
                className={inputClass}
              />
            </FieldShell>
          )}
        </form.Field>

        <form.Field name="position">
          {(field) => (
            <FieldShell
              field={field}
              labelClassName={labelClass}
              label={<FieldLabelText label="Your role" />}
            >
              <input
                id={field.name}
                type="text"
                autoComplete="organization-title"
                placeholder="Head of Product, PM Lead, …"
                value={field.state.value}
                onBlur={field.handleBlur}
                onChange={(e) => field.handleChange(e.target.value)}
                aria-invalid={fieldHasError(field)}
                className={inputClass}
              />
            </FieldShell>
          )}
        </form.Field>

        <form.Field name="ultimateGoal">
          {(field) => (
            <FieldShell
              field={field}
              labelClassName={labelClass}
              label={<FieldLabelText label="What's your goal" hint="one sentence" />}
            >
              <textarea
                id={field.name}
                rows={3}
                autoFocus={!!defaults?.companyUrl}
                placeholder="Catch every competitor launch / pricing change so I can react before my CEO asks."
                value={field.state.value}
                onBlur={field.handleBlur}
                onChange={(e) => field.handleChange(e.target.value)}
                aria-invalid={fieldHasError(field)}
                className={textareaClass}
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
              disabled={!canSubmit || redirecting}
              className="group mt-2 inline-flex h-12 items-center justify-center gap-[10px] rounded-pill bg-accent px-8 text-base font-semibold text-ink transition-transform duration-150 hover:-translate-y-px disabled:cursor-not-allowed disabled:opacity-70 disabled:hover:translate-y-0"
            >
              {isSubmitting
                ? "Kicking it off…"
                : redirecting
                  ? "Signing you in…"
                  : "Start onboarding"}
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
    </AuthShell>
  );
}

function FieldLabel({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="grid gap-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-[#8a8a98]">
      <FieldLabelText label={label} hint={hint} />
      {children}
    </label>
  );
}

function FieldLabelText({ label, hint }: { label: string; hint?: string }) {
  return (
    <span className="inline-flex items-center gap-2">
      {label}
      {hint ? (
        <span className="rounded-pill bg-accent/15 px-2 py-[2px] font-mono text-[10px] normal-case tracking-normal text-accent">
          {hint}
        </span>
      ) : null}
    </span>
  );
}

function detectBrowserTz(): string | undefined {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return tz && tz.length > 0 ? tz : undefined;
  } catch {
    return undefined;
  }
}

function messageForError(code: SubmitError) {
  switch (code) {
    case "invalid_invite":
      return "This invite link looks invalid or expired. Ask for a fresh one.";
    case "already_confirmed":
      return "This invite has already been used. Sign in instead, or ask for a fresh invite.";
    case "user_insert_failed":
      return "We couldn't set up your account. Try again in a moment.";
    case "session_failed":
      return "We couldn't start your session. Try again in a moment.";
  }
}

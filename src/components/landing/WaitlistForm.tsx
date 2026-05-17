import { useForm } from "@tanstack/react-form";
import { toast } from "sonner";
import { FieldShell, fieldHasError } from "~/components/forms/field-shell";
import { WAITLIST } from "~/data/landing";
import { waitlistFormSchema } from "~/lib/validation/waitlist";

const inputClass =
  "h-11 rounded-md border-[1.5px] border-ink/20 bg-paper px-3 text-sm font-normal normal-case tracking-normal text-ink outline-none placeholder:text-ink/40 focus:border-ink aria-invalid:border-coral aria-invalid:focus:border-coral";

const labelClass = "text-[11px] font-semibold uppercase tracking-[0.12em] text-ink/70";

export function WaitlistForm({ source }: { source: string }) {
  const form = useForm({
    defaultValues: { email: "", position: "", companyUrl: "" },
    validators: { onChange: waitlistFormSchema, onBlur: waitlistFormSchema },
    onSubmit: async ({ value }) => {
      const parsed = waitlistFormSchema.safeParse(value);
      if (!parsed.success) return;
      const res = await fetch("/api/waitlist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: parsed.data.email,
          position: parsed.data.position,
          companyUrl: parsed.data.companyUrl,
          source,
        }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        const code = data?.error;
        toast.error(
          code === "invalid_email"
            ? "That email doesn't look right."
            : code === "invalid_url"
              ? "We couldn't reach that URL — double-check and resubmit."
              : "Couldn't reach the server — try again in a moment.",
        );
        throw new Error("submit_failed");
      }
    },
  });

  const isDone = form.state.isSubmitSuccessful;
  if (isDone) {
    return (
      <div className="mx-auto mt-2 max-w-[520px] rounded-2xl border-[1.5px] border-ink/20 bg-ink/5 px-6 py-5 text-left text-ink">
        <p className="font-semibold">{WAITLIST.success}</p>
        <p className="mt-1 text-sm text-ink/70">
          We'll reach out from <span className="font-mono">hello@productflash.io</span> when a seat
          opens.
        </p>
      </div>
    );
  }

  return (
    <form
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        void form.handleSubmit();
      }}
      className="mx-auto mt-2 grid max-w-[520px] gap-3 text-left"
    >
      <form.Field name="email">
        {(field) => (
          <FieldShell field={field} label="Email" labelClassName={labelClass}>
            <input
              id={field.name}
              type="email"
              autoComplete="email"
              value={field.state.value}
              onBlur={field.handleBlur}
              onChange={(e) => field.handleChange(e.target.value)}
              aria-invalid={fieldHasError(field)}
              className={inputClass}
              placeholder="you@company.com"
            />
          </FieldShell>
        )}
      </form.Field>

      <div className="grid grid-cols-2 items-start gap-3 max-md:grid-cols-1">
        <form.Field name="position">
          {(field) => (
            <FieldShell field={field} label="Role" labelClassName={labelClass}>
              <input
                id={field.name}
                type="text"
                autoComplete="organization-title"
                maxLength={120}
                value={field.state.value}
                onBlur={field.handleBlur}
                onChange={(e) => field.handleChange(e.target.value)}
                aria-invalid={fieldHasError(field)}
                className={inputClass}
                placeholder="Head of Product"
              />
            </FieldShell>
          )}
        </form.Field>

        <form.Field name="companyUrl">
          {(field) => (
            <FieldShell field={field} label="Company URL" labelClassName={labelClass}>
              <input
                id={field.name}
                type="text"
                inputMode="url"
                autoComplete="url"
                value={field.state.value}
                onBlur={field.handleBlur}
                onChange={(e) => field.handleChange(e.target.value)}
                aria-invalid={fieldHasError(field)}
                className={inputClass}
                placeholder="acme.com"
              />
            </FieldShell>
          )}
        </form.Field>
      </div>

      <form.Subscribe selector={(s) => ({ canSubmit: s.canSubmit, isSubmitting: s.isSubmitting })}>
        {({ canSubmit, isSubmitting }) => (
          <button
            type="submit"
            disabled={!canSubmit}
            className="mt-2 inline-flex h-12 items-center justify-center gap-[10px] rounded-pill bg-ink px-8 text-base font-semibold text-white transition-transform duration-150 hover:-translate-y-px disabled:cursor-not-allowed disabled:opacity-70"
          >
            {isSubmitting ? "Sending…" : WAITLIST.label}
          </button>
        )}
      </form.Subscribe>
    </form>
  );
}

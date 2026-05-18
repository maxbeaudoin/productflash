import { useForm } from "@tanstack/react-form";
import { toast } from "sonner";
import { z } from "zod";
import { FieldShell, fieldHasError } from "~/components/forms/field-shell";
import {
  onboardingProfileFormSchema,
  settingsProfileFormSchema,
} from "~/shared/iso/validation/profile";
import { FocusAreasLabel } from "./focus-areas";

// Output shape covers both variants. companyUrl is optional — only present
// when the editor runs in `settings` mode.
export type ProfileEditorValues = {
  position: string;
  companyName: string;
  companyUrl?: string;
  ultimateGoal: string;
  focusAreas: string[];
};

export type ProfileEditorInitial = {
  position: string | null;
  companyName: string | null;
  companyUrl?: string | null;
  ultimateGoal: string | null;
  focusAreas: string[] | null;
};

// Comma-separated focusAreas string → validated array. Each variant uses
// the underlying schema for its variant so error messages stay consistent
// with the rest of the form.
//
// Both variants accept a `companyUrl` string in their input shape so the
// TanStack Form `defaultValues` (which always supplies one) lines up.
// The onboarding variant doesn't render that field and the parsed value
// is discarded by the route's onSave — but the schema needs to declare
// it for the static input type to match.
const onboardingEditFormSchema = onboardingProfileFormSchema.extend({
  companyUrl: z.string(),
  focusAreas: focusAreasFromCommaString(onboardingProfileFormSchema.shape.focusAreas),
});
const settingsEditFormSchema = settingsProfileFormSchema.extend({
  focusAreas: focusAreasFromCommaString(settingsProfileFormSchema.shape.focusAreas),
});

function focusAreasFromCommaString(arraySchema: z.ZodTypeAny) {
  return z.string().transform((v, ctx) => {
    const parsed = v
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    const result = arraySchema.safeParse(parsed);
    if (!result.success) {
      ctx.addIssue({
        code: "custom",
        message: result.error.issues[0]?.message ?? "Add at least one focus area.",
      });
      return z.NEVER;
    }
    return result.data;
  });
}

const labelClass = "text-[11px] font-semibold uppercase tracking-[0.12em] text-[#8a8a98]";
const inputClass =
  "h-11 w-full rounded-md border-[1.5px] border-[#2a2a38] bg-ink px-4 text-base text-white outline-none transition-colors focus:border-accent aria-invalid:border-coral aria-invalid:focus:border-coral";
const urlInputClass =
  "h-11 w-full rounded-md border-[1.5px] border-[#2a2a38] bg-ink px-4 font-mono text-sm text-white outline-none transition-colors focus:border-accent aria-invalid:border-coral aria-invalid:focus:border-coral";
const textareaClass =
  "min-h-[88px] w-full rounded-md border-[1.5px] border-[#2a2a38] bg-ink px-4 py-3 text-base text-white outline-none transition-colors focus:border-accent aria-invalid:border-coral aria-invalid:focus:border-coral";

export function ProfileEditor({
  initial,
  variant,
  onCancel,
  onSave,
}: {
  initial: ProfileEditorInitial;
  // `onboarding` hides companyUrl (already captured at signup, not
  // re-editable mid-onboarding). `settings` exposes companyUrl as an
  // editable field with monospace styling.
  variant: "onboarding" | "settings";
  onCancel: () => void;
  onSave: (next: ProfileEditorValues) => Promise<void> | void;
}) {
  // Cast to a single schema type so TanStack Form's validator typing
  // accepts it. Both branches share the same input shape (5 string fields,
  // since the onboarding schema declares an ignored `companyUrl` string)
  // — they differ only in the nominal Zod types of `companyUrl`. The runtime
  // schema picked here is the correct one for each variant.
  const schema = (
    variant === "settings" ? settingsEditFormSchema : onboardingEditFormSchema
  ) as typeof settingsEditFormSchema;

  const form = useForm({
    defaultValues: {
      position: initial.position ?? "",
      companyName: initial.companyName ?? "",
      companyUrl: initial.companyUrl ?? "",
      ultimateGoal: initial.ultimateGoal ?? "",
      focusAreas: (initial.focusAreas ?? []).join(", "),
    },
    validators: { onChange: schema },
    onSubmit: async ({ value }) => {
      const parsed = schema.safeParse(value);
      if (!parsed.success) return;
      try {
        await onSave(parsed.data as ProfileEditorValues);
      } catch {
        toast.error("Could not save changes. Try again.");
        throw new Error("save_failed");
      }
    },
  });

  const headerCopy =
    variant === "settings"
      ? "change anything that's drifted"
      : "change anything the agent got wrong";

  return (
    <form
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        void form.handleSubmit();
      }}
      className="overflow-hidden rounded-card-lg border border-[#2a2a38] bg-ink-soft"
      style={{ boxShadow: "0 40px 80px rgba(0,0,0,0.4)" }}
    >
      <div className="border-b border-[#2a2a38] bg-[#1a1a23] px-7 py-5 text-[13px] text-[#888]">
        <strong className="font-semibold text-white">Edit profile</strong> · {headerCopy}
      </div>

      <div className="grid gap-5 px-7 py-7">
        <form.Field name="position">
          {(field) => (
            <FieldShell field={field} labelClassName={labelClass} label="Role">
              <input
                id={field.name}
                value={field.state.value}
                onBlur={field.handleBlur}
                onChange={(e) => field.handleChange(e.target.value)}
                aria-invalid={fieldHasError(field)}
                className={inputClass}
              />
            </FieldShell>
          )}
        </form.Field>
        <form.Field name="companyName">
          {(field) => (
            <FieldShell field={field} labelClassName={labelClass} label="Company">
              <input
                id={field.name}
                value={field.state.value}
                onBlur={field.handleBlur}
                onChange={(e) => field.handleChange(e.target.value)}
                aria-invalid={fieldHasError(field)}
                className={inputClass}
              />
            </FieldShell>
          )}
        </form.Field>
        {variant === "settings" ? (
          <form.Field name="companyUrl">
            {(field) => (
              <FieldShell field={field} labelClassName={labelClass} label="Company URL">
                <input
                  id={field.name}
                  type="url"
                  value={field.state.value}
                  onBlur={field.handleBlur}
                  onChange={(e) => field.handleChange(e.target.value)}
                  aria-invalid={fieldHasError(field)}
                  placeholder="https://your-company.com"
                  className={urlInputClass}
                />
              </FieldShell>
            )}
          </form.Field>
        ) : null}
        <form.Field name="ultimateGoal">
          {(field) => (
            <FieldShell field={field} labelClassName={labelClass} label="Goal">
              <textarea
                id={field.name}
                rows={3}
                value={field.state.value}
                onBlur={field.handleBlur}
                onChange={(e) => field.handleChange(e.target.value)}
                aria-invalid={fieldHasError(field)}
                className={textareaClass}
              />
            </FieldShell>
          )}
        </form.Field>
        <form.Field name="focusAreas">
          {(field) => (
            <FieldShell field={field} labelClassName={labelClass} label={<FocusAreasLabel />}>
              <input
                id={field.name}
                value={field.state.value}
                onBlur={field.handleBlur}
                onChange={(e) => field.handleChange(e.target.value)}
                aria-invalid={fieldHasError(field)}
                className={inputClass}
              />
            </FieldShell>
          )}
        </form.Field>
      </div>

      <div className="flex flex-wrap items-center gap-3 border-t border-[#2a2a38] bg-[#1a1a23] px-7 py-5">
        <form.Subscribe
          selector={(s) => ({ canSubmit: s.canSubmit, isSubmitting: s.isSubmitting })}
        >
          {({ canSubmit, isSubmitting }) => (
            <>
              <button
                type="submit"
                disabled={!canSubmit}
                className="inline-flex h-11 items-center gap-2 rounded-pill bg-accent px-6 text-sm font-semibold text-ink transition-transform duration-150 hover:-translate-y-px disabled:cursor-not-allowed disabled:opacity-70"
              >
                {isSubmitting ? "Saving…" : "Save changes"}
              </button>
              <button
                type="button"
                onClick={onCancel}
                disabled={isSubmitting}
                className="inline-flex h-11 items-center gap-2 rounded-pill border border-[#2a2a38] px-5 text-sm font-semibold text-white hover:bg-ink/40 disabled:opacity-50"
              >
                Cancel
              </button>
            </>
          )}
        </form.Subscribe>
      </div>
    </form>
  );
}

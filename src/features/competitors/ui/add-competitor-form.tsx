import { useForm } from "@tanstack/react-form";
import { toast } from "sonner";
import { FieldShell, fieldHasError } from "~/components/forms/field-shell";
import { addCompetitorFormSchema } from "~/features/competitors/schema";

export function AddCompetitorForm({
  onCancel,
  onSubmit,
}: {
  onCancel: () => void;
  onSubmit: (input: { name: string; homepageUrl: string }) => Promise<void>;
}) {
  const form = useForm({
    defaultValues: { name: "", homepageUrl: "" },
    validators: { onChange: addCompetitorFormSchema },
    onSubmit: async ({ value, formApi }) => {
      try {
        await onSubmit(value);
        formApi.reset();
      } catch {
        toast.error("Could not add competitor. Try again.");
        throw new Error("add_competitor_failed");
      }
    },
  });

  const inputClass =
    "h-11 w-full rounded-md border-[1.5px] border-[#2a2a38] bg-ink px-4 text-base text-white outline-none transition-colors focus:border-accent aria-invalid:border-coral aria-invalid:focus:border-coral";

  return (
    <form
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        void form.handleSubmit();
      }}
      className="grid gap-3 rounded-md border border-[#2a2a38] bg-ink/40 px-4 py-4"
    >
      <div className="grid gap-3 sm:grid-cols-[1fr_2fr]">
        <form.Field name="name">
          {(field) => (
            <FieldShell field={field} label="" labelClassName="sr-only">
              <input
                id={field.name}
                type="text"
                placeholder="Notion"
                value={field.state.value}
                autoFocus
                onBlur={field.handleBlur}
                onChange={(e) => field.handleChange(e.target.value)}
                aria-invalid={fieldHasError(field)}
                aria-label="Competitor name"
                className={inputClass}
              />
            </FieldShell>
          )}
        </form.Field>
        <form.Field name="homepageUrl">
          {(field) => (
            <FieldShell field={field} label="" labelClassName="sr-only">
              <input
                id={field.name}
                type="text"
                inputMode="url"
                placeholder="https://notion.so"
                value={field.state.value}
                onBlur={field.handleBlur}
                onChange={(e) => field.handleChange(e.target.value)}
                aria-invalid={fieldHasError(field)}
                aria-label="Competitor homepage URL"
                className={inputClass}
              />
            </FieldShell>
          )}
        </form.Field>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <form.Subscribe
          selector={(s) => ({ canSubmit: s.canSubmit, isSubmitting: s.isSubmitting })}
        >
          {({ canSubmit, isSubmitting }) => (
            <>
              <button
                type="submit"
                disabled={!canSubmit}
                className="inline-flex h-10 items-center gap-2 rounded-pill bg-accent px-5 text-sm font-semibold text-ink hover:-translate-y-px disabled:cursor-not-allowed disabled:opacity-70"
              >
                {isSubmitting ? "Adding…" : "Add competitor"}
              </button>
              <button
                type="button"
                onClick={onCancel}
                disabled={isSubmitting}
                className="inline-flex h-10 items-center gap-2 rounded-pill border border-[#2a2a38] px-4 text-sm font-semibold text-white hover:bg-ink/40 disabled:opacity-50"
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

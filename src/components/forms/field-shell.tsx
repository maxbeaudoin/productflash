import type { AnyFieldApi } from "@tanstack/react-form";
import { cn } from "~/shared/iso/utils";

// Shared shell around a TanStack Form field. Renders label, the consumer's
// input, and either an inline error (after the field has been touched) or a
// hint. The consumer wires the input — gives them full control over styling
// so the same shell works for landing-page and app surfaces.
export function FieldShell({
  field,
  label,
  children,
  hint,
  labelClassName,
  className,
}: {
  field: AnyFieldApi;
  label: React.ReactNode;
  children: React.ReactNode;
  hint?: React.ReactNode;
  labelClassName?: string;
  className?: string;
}) {
  const errorMessage = getFieldErrorMessage(field);
  return (
    <div className={cn("grid gap-1.5", className)}>
      <label htmlFor={field.name} className={cn("text-sm font-medium", labelClassName)}>
        {label}
      </label>
      {children}
      {errorMessage ? (
        <p className="text-xs font-medium text-destructive" role="alert">
          {errorMessage}
        </p>
      ) : hint ? (
        <p className="text-xs text-muted-foreground">{hint}</p>
      ) : null}
    </div>
  );
}

// Show an error once the user has either blurred the field (isTouched) OR
// tried to submit the form at least once. Without the second branch, a user
// who types-then-clears never sees why submit is disabled — the value
// changed but no real blur ever fired.
export function getFieldErrorMessage(field: AnyFieldApi): string | null {
  if (!shouldShowError(field)) return null;
  return errorToString(field.state.meta.errors[0]);
}

export function fieldHasError(field: AnyFieldApi): boolean {
  return shouldShowError(field) && field.state.meta.errors.length > 0;
}

function shouldShowError(field: AnyFieldApi): boolean {
  if (field.state.meta.isTouched) return true;
  const formMeta = field.form.state;
  return (formMeta.submissionAttempts ?? 0) > 0;
}

function errorToString(err: unknown): string | null {
  if (!err) return null;
  if (typeof err === "string") return err;
  if (typeof err === "object" && "message" in err && typeof err.message === "string") {
    return err.message;
  }
  return "Invalid value";
}

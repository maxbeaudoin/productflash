import { z } from "zod";
import { normalizeUrl } from "~/shared/iso/url";

// Reusable primitives so every form validates the same way on both
// client and server. Keep this file isomorphic — no Node-only imports.

export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(1, { message: "Enter your email." })
  .email({ message: "That doesn't look like a valid email." })
  .max(320, { message: "Email is too long." });

// Required URL field. Trims, normalizes, rejects malformed input
// (commas, missing TLD, ports, credentials, IP literals, etc.).
// Outputs the canonical https:// form.
//
// Factory rather than a constant so each call site can supply a
// context-appropriate empty-field message — e.g. "Enter your company URL."
// for the waitlist vs "Enter the competitor's homepage URL." for add-
// competitor. The normalization rules are identical.
export function requiredUrlSchema(emptyMessage: string) {
  return z
    .string()
    .trim()
    .min(1, { message: emptyMessage })
    .max(500, { message: "URL is too long." })
    .transform((v, ctx) => {
      const normalized = normalizeUrl(v);
      if (!normalized) {
        ctx.addIssue({
          code: "custom",
          message: "That doesn't look like a URL.",
        });
        return z.NEVER;
      }
      return normalized;
    });
}

// Optional URL field — empty string is allowed and becomes undefined.
// Anything else must normalize cleanly. Input type is `string` (not
// `string | undefined`) so the schema can validate raw form values whose
// empty state is "" — TanStack Form's defaultValues need that.
export const optionalUrlSchema = z
  .string()
  .trim()
  .max(500, { message: "URL is too long." })
  .transform((v, ctx) => {
    if (!v) return undefined;
    const normalized = normalizeUrl(v);
    if (!normalized) {
      ctx.addIssue({
        code: "custom",
        message: "That doesn't look like a URL.",
      });
      return z.NEVER;
    }
    return normalized;
  });

export const positionSchema = z
  .string()
  .trim()
  .min(1, { message: "Enter your role." })
  .min(2, { message: "Your role is too short." })
  .max(120, { message: "Your role is too long." });

export const optionalPositionSchema = z
  .string()
  .trim()
  .max(120, { message: "Your role is too long." })
  .transform((v) => (v ? v : undefined));

export const ultimateGoalSchema = z
  .string()
  .trim()
  .min(1, { message: "Enter your goal." })
  .min(8, { message: "Tell us a bit more — at least 8 characters." })
  .max(400, { message: "Keep it under 400 characters." });

export const companyNameSchema = z
  .string()
  .trim()
  .min(1, { message: "Enter your company name." })
  .max(160, { message: "Company name is too long." });

export const competitorNameSchema = z
  .string()
  .trim()
  .min(1, { message: "Enter a name." })
  .max(120, { message: "Name is too long." });

export const focusAreasSchema = z
  .array(z.string().trim().min(1).max(80))
  .min(1, { message: "Add at least one focus area." })
  .max(8, { message: "Up to 8 focus areas." });

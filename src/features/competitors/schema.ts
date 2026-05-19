import { z } from "zod";
import {
  competitorNameSchema,
  optionalUrlSchema,
  requiredUrlSchema,
} from "~/shared/iso/validation/primitives";

// Add-competitor form. Same shape on onboarding and on settings.
export const addCompetitorFormSchema = z.object({
  name: competitorNameSchema,
  homepageUrl: requiredUrlSchema("Enter the competitor's homepage URL."),
});

export type AddCompetitorFormValues = z.output<typeof addCompetitorFormSchema>;

// Admin edit form (PF-66). Lets an admin repair the shared competitor row
// when the FTE agent's auto-detect was wrong. The invariant noted on
// `competitors` in schema.ts ("FTE agent is the only privileged writer of
// fields on existing rows") gets an explicit second writer here, by design,
// behind an `admin_audit` trail so any cross-tenant blast radius is forensic.
//
// Empty string for an optional field means "clear it" — the server handler
// maps undefined → null in the UPDATE.
export const competitorEditFormSchema = z.object({
  name: competitorNameSchema,
  homepageUrl: requiredUrlSchema("Enter the competitor's homepage URL."),
  rssUrl: optionalUrlSchema,
  // PH slugs are lowercase alphanumeric + hyphens (see src/sources/ph.ts).
  // Empty string clears the field.
  phSlug: z
    .string()
    .trim()
    .toLowerCase()
    .max(80, { message: "Slug is too long." })
    .regex(/^[a-z0-9-]*$/, { message: "Slug can only contain a-z, 0-9, and -." })
    .transform((v) => (v ? v : undefined)),
  pricingUrl: optionalUrlSchema,
});

export type CompetitorEditFormValues = z.output<typeof competitorEditFormSchema>;

import { z } from "zod";
import { competitorNameSchema, requiredUrlSchema } from "~/shared/iso/validation/primitives";

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
export const competitorEditFormSchema = z.object({
  name: competitorNameSchema,
  homepageUrl: requiredUrlSchema("Enter the competitor's homepage URL."),
});

export type CompetitorEditFormValues = z.output<typeof competitorEditFormSchema>;

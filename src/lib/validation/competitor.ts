import { z } from "zod";
import { competitorNameSchema, requiredUrlSchema } from "~/lib/validation/primitives";

// Add-competitor form. Same shape on onboarding and on settings.
export const addCompetitorFormSchema = z.object({
  name: competitorNameSchema,
  homepageUrl: requiredUrlSchema,
});

export type AddCompetitorFormValues = z.output<typeof addCompetitorFormSchema>;

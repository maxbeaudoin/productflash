import { z } from "zod";
import { competitorNameSchema, requiredUrlSchema } from "~/shared/iso/validation/primitives";

// Add-competitor form. Same shape on onboarding and on settings.
export const addCompetitorFormSchema = z.object({
  name: competitorNameSchema,
  homepageUrl: requiredUrlSchema("Enter the competitor's homepage URL."),
});

export type AddCompetitorFormValues = z.output<typeof addCompetitorFormSchema>;

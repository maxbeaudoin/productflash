import { z } from "zod";
import { emailSchema } from "~/shared/iso/validation/primitives";

// Magic-link form. Single email field.
export const magicLinkFormSchema = z.object({
  email: emailSchema,
});

export type MagicLinkFormValues = z.output<typeof magicLinkFormSchema>;

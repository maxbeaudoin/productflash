import { z } from "zod";
import { emailSchema, positionSchema, requiredUrlSchema } from "~/shared/iso/validation/primitives";

// Form schema — used by TanStack Form on the client. Input type must be all
// `string` so default values can be empty strings. Role + Company URL are
// required: we use them to filter invites by ICP, and an anonymous waitlist
// row is noise.
export const waitlistFormSchema = z.object({
  email: emailSchema,
  position: positionSchema,
  companyUrl: requiredUrlSchema("Enter your company URL."),
});

export type WaitlistFormInput = z.input<typeof waitlistFormSchema>;
export type WaitlistFormValues = z.output<typeof waitlistFormSchema>;

// API schema — accepts the JSON-stringify'd body the client sends. Required
// fields are required server-side too. `name` and `source` may be absent so
// they stay optional.
export const waitlistApiSchema = z.object({
  email: emailSchema,
  position: positionSchema,
  companyUrl: requiredUrlSchema("Enter your company URL."),
  name: z.string().trim().max(160).optional(),
  source: z.string().trim().max(64).optional(),
});

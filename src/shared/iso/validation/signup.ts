import { z } from "zod";
import {
  positionSchema,
  requiredUrlSchema,
  ultimateGoalSchema,
} from "~/shared/iso/validation/primitives";

// FTE invited-signup form. Shared by the form and the submitSignup server fn.
// The email is locked to the invite token and never travels with form data.
export const signupFormSchema = z.object({
  companyUrl: requiredUrlSchema("Enter your company URL."),
  position: positionSchema,
  ultimateGoal: ultimateGoalSchema,
});

export type SignupFormValues = z.output<typeof signupFormSchema>;

// Server fn input — adds the invite token and the browser-captured timezone.
export const signupServerSchema = signupFormSchema.extend({
  inviteToken: z.string().min(1).max(2048),
  tz: z.string().trim().min(1).max(64).optional(),
});

export type SignupServerInput = z.output<typeof signupServerSchema>;

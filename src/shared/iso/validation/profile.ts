import { z } from "zod";
import {
  companyNameSchema,
  focusAreasSchema,
  positionSchema,
  requiredUrlSchema,
  ultimateGoalSchema,
} from "~/shared/iso/validation/primitives";

// Profile-edit form on /app/onboarding (no companyUrl — captured at signup
// and not re-edited mid-onboarding).
export const onboardingProfileFormSchema = z.object({
  position: positionSchema,
  companyName: companyNameSchema,
  ultimateGoal: ultimateGoalSchema,
  focusAreas: focusAreasSchema,
});

export type OnboardingProfileFormValues = z.output<typeof onboardingProfileFormSchema>;

// Settings profile form on /app/profile — companyUrl is editable here.
export const settingsProfileFormSchema = z.object({
  position: positionSchema,
  companyName: companyNameSchema,
  companyUrl: requiredUrlSchema("Enter your company URL."),
  ultimateGoal: ultimateGoalSchema,
  focusAreas: focusAreasSchema,
});

export type SettingsProfileFormValues = z.output<typeof settingsProfileFormSchema>;

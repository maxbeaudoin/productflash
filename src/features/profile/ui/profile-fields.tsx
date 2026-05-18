import { DetailRow } from "./detail-row";
import { FocusAreas } from "./focus-areas";

export type ProfileFieldsView = {
  position: string | null;
  companyName: string | null;
  companyUrl: string | null;
  ultimateGoal: string | null;
  focusAreas: string[] | null;
};

// Shared body of the read-only profile card. Each route wraps this with its
// own chrome (header copy + footer CTAs) — see ProfileCard in
// /app/profile vs /app/onboarding.
export function ProfileFields({
  profile,
  // /app/profile shows the company URL row (editable in settings). The
  // onboarding preview hides it (captured at signup, not user-tunable
  // mid-onboarding) and falls back to companyUrl-as-company when
  // companyName is empty.
  showCompanyUrl,
}: {
  profile: ProfileFieldsView;
  showCompanyUrl: boolean;
}) {
  return (
    <>
      <div className="grid gap-6 md:grid-cols-2">
        <DetailRow label="Role" value={profile.position} />
        <DetailRow
          label="Company"
          value={showCompanyUrl ? profile.companyName : (profile.companyName ?? profile.companyUrl)}
        />
      </div>
      {showCompanyUrl ? <DetailRow label="Company URL" value={profile.companyUrl} mono /> : null}
      <DetailRow label="Goal" value={profile.ultimateGoal} />
      <FocusAreas areas={profile.focusAreas} />
    </>
  );
}

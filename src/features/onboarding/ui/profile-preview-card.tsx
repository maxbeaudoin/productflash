import type { CompetitorView } from "~/features/competitors/shared/types";
import { CompetitorsList } from "~/features/competitors/ui/competitors-list";
import { ProfileFields } from "~/features/profile/ui/profile-fields";
import type { ProfileView } from "../shared/fte-event";

export function ProfilePreviewCard({
  profile,
  competitors,
  onEditProfile,
  onConfirm,
  confirming,
  addingCompetitor,
  onShowAdd,
  onHideAdd,
  onAddCompetitor,
  onRemoveCompetitor,
}: {
  profile: ProfileView;
  competitors: CompetitorView[];
  onEditProfile: () => void;
  onConfirm: () => void;
  confirming: boolean;
  addingCompetitor: boolean;
  onShowAdd: () => void;
  onHideAdd: () => void;
  onAddCompetitor: (input: { name: string; homepageUrl: string }) => Promise<void>;
  onRemoveCompetitor: (competitor: CompetitorView) => Promise<void>;
}) {
  return (
    <div
      className="overflow-hidden rounded-card-lg border border-[#2a2a38] bg-ink-soft"
      style={{ boxShadow: "0 40px 80px rgba(0,0,0,0.4)" }}
    >
      <div className="flex items-center justify-between border-b border-[#2a2a38] bg-[#1a1a23] px-7 py-5">
        <div className="text-[13px] text-[#888]">
          <strong className="font-semibold text-white">Profile preview</strong> · review and edit
          before confirming
        </div>
        <div className="font-mono text-xs text-[#666]">
          {competitors.length} competitor{competitors.length === 1 ? "" : "s"}
        </div>
      </div>

      <div className="grid gap-6 px-7 py-7">
        <ProfileFields profile={profile} showCompanyUrl={false} />
        <CompetitorsList
          variant="inline"
          competitors={competitors}
          addingCompetitor={addingCompetitor}
          onShowAdd={onShowAdd}
          onHideAdd={onHideAdd}
          onAddCompetitor={onAddCompetitor}
          onRemoveCompetitor={onRemoveCompetitor}
        />
      </div>

      <div className="flex flex-wrap items-center gap-3 border-t border-[#2a2a38] bg-[#1a1a23] px-7 py-5">
        <button
          type="button"
          onClick={onConfirm}
          disabled={confirming}
          className="group inline-flex h-11 items-center justify-center gap-[10px] rounded-pill bg-accent px-7 text-base font-semibold text-ink transition-transform duration-150 hover:-translate-y-px disabled:cursor-not-allowed disabled:opacity-70 disabled:hover:translate-y-0"
        >
          {confirming ? "Confirming…" : "Looks good"}
          <span
            aria-hidden
            className="transition-transform duration-150 group-hover:translate-x-[3px] group-disabled:hidden"
          >
            →
          </span>
        </button>
        <button
          type="button"
          onClick={onEditProfile}
          className="inline-flex h-11 items-center gap-2 rounded-pill border border-[#2a2a38] px-5 text-sm font-semibold text-white hover:bg-ink/40"
        >
          Edit profile fields
        </button>
      </div>
    </div>
  );
}

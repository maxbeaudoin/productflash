import { createFileRoute, useRouter } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { asc, eq } from "drizzle-orm";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import {
  addCompetitor,
  type CompetitorView,
  removeCompetitor,
} from "~/features/competitors/server/fns";
import { CompetitorsList } from "~/features/competitors/ui/competitors-list";
import { settingsProfileFormSchema } from "~/features/profile/schema";
import { ProfileEditor, type ProfileEditorValues } from "~/features/profile/ui/profile-editor";
import { ProfileFields, type ProfileFieldsView } from "~/features/profile/ui/profile-fields";
import {
  competitors as competitorsTable,
  itemScores,
  userCompetitors,
  users as usersTable,
} from "~/db/schema";
import { requireSession } from "~/shared/server/auth-server";
import { getDb } from "~/shared/server/db";

// /app/profile (#32). Standalone view + edit of the AI-generated profile.
//
// Distinct from /app/onboarding: that route is a one-shot terminal-feel
// streaming view tied to the FTE agent run and the confirm-and-continue
// flow. Here we're a plain settings screen — the user lands here from the
// header, tweaks fields, adds/removes competitors, and leaves.

type ProfileLoaderData = {
  profile: ProfileFieldsView;
  competitors: CompetitorView[];
};

const loadProfile = createServerFn({ method: "GET" }).handler(
  async (): Promise<ProfileLoaderData> => {
    const session = await requireSession();
    const db = getDb();

    const [user] = await db
      .select({
        position: usersTable.position,
        companyName: usersTable.companyName,
        companyUrl: usersTable.companyUrl,
        ultimateGoal: usersTable.ultimateGoal,
        focusAreas: usersTable.focusAreas,
      })
      .from(usersTable)
      .where(eq(usersTable.id, session.user.id))
      .limit(1);

    const competitors = await db
      .select({
        id: competitorsTable.id,
        name: competitorsTable.name,
        homepageUrl: competitorsTable.homepageUrl,
        rssUrl: competitorsTable.rssUrl,
      })
      .from(userCompetitors)
      .innerJoin(competitorsTable, eq(userCompetitors.competitorId, competitorsTable.id))
      .where(eq(userCompetitors.userId, session.user.id))
      .orderBy(asc(competitorsTable.name));

    return {
      profile: {
        position: user?.position ?? null,
        companyName: user?.companyName ?? null,
        companyUrl: user?.companyUrl ?? null,
        ultimateGoal: user?.ultimateGoal ?? null,
        focusAreas: user?.focusAreas ?? null,
      },
      competitors,
    };
  },
);

// editProfile lives in-route here (and not in lib/server) because it has
// settings-specific semantics that the onboarding variant doesn't share:
// (a) `companyUrl` IS editable, and (b) we wipe the per-user itemScores
// cache so the next score run re-classifies under the new profile — this
// only matters once scores exist, i.e. after onboarding wraps up.
const editProfile = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => settingsProfileFormSchema.parse(data))
  .handler(async ({ data }) => {
    const session = await requireSession();
    const db = getDb();
    await db
      .update(usersTable)
      .set({
        position: data.position,
        companyName: data.companyName,
        companyUrl: data.companyUrl,
        ultimateGoal: data.ultimateGoal,
        focusAreas: data.focusAreas,
        updatedAt: new Date(),
      })
      .where(eq(usersTable.id, session.user.id));
    // Profile fields are baked into Haiku scoring (#35). Drop the stale
    // cache so the next score run re-classifies under the new context.
    await db.delete(itemScores).where(eq(itemScores.userId, session.user.id));
    return { ok: true as const };
  });

export const Route = createFileRoute("/app/profile")({
  loader: () => loadProfile(),
  component: ProfilePage,
});

function ProfilePage() {
  const loaded = Route.useLoaderData();
  const router = useRouter();

  const [profile, setProfile] = useState<ProfileFieldsView>(loaded.profile);
  const [competitors, setCompetitors] = useState<CompetitorView[]>(loaded.competitors);
  const [editing, setEditing] = useState(false);
  const [addingCompetitor, setAddingCompetitor] = useState(false);

  useEffect(() => {
    setProfile(loaded.profile);
    setCompetitors(loaded.competitors);
  }, [loaded.profile, loaded.competitors]);

  async function onSaveEdit(next: ProfileEditorValues) {
    await editProfile({
      data: {
        position: next.position,
        companyName: next.companyName,
        companyUrl: next.companyUrl ?? "",
        ultimateGoal: next.ultimateGoal,
        focusAreas: next.focusAreas,
      },
    });
    setProfile({
      position: next.position,
      companyName: next.companyName,
      companyUrl: next.companyUrl ?? null,
      ultimateGoal: next.ultimateGoal,
      focusAreas: next.focusAreas,
    });
    setEditing(false);
    toast.success("Profile updated");
  }

  async function onAddCompetitor(input: { name: string; homepageUrl: string }) {
    const res = await addCompetitor({ data: input });
    setCompetitors((prev) =>
      prev.some((c) => c.id === res.competitor.id)
        ? prev
        : [...prev, res.competitor].sort((a, b) => a.name.localeCompare(b.name)),
    );
    setAddingCompetitor(false);
    toast.success(
      res.competitor.rssUrl
        ? `Added ${res.competitor.name} · RSS detected`
        : `Added ${res.competitor.name}`,
    );
  }

  async function onRemoveCompetitor(competitor: CompetitorView) {
    const previous = competitors;
    setCompetitors((prev) => prev.filter((c) => c.id !== competitor.id));
    try {
      await removeCompetitor({ data: { competitorId: competitor.id } });
      toast.success(`Removed ${competitor.name}`);
    } catch {
      setCompetitors(previous);
      toast.error("Could not remove competitor");
      await router.invalidate();
    }
  }

  return (
    <main className="mx-auto max-w-[920px] px-6 py-12">
      <header className="mb-10">
        <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.15em] text-accent">
          Profile
        </div>
        <h1 className="text-[clamp(28px,3vw,40px)] font-extrabold leading-[1.1] tracking-[-0.02em] text-white">
          Tune what your analyst watches for.
        </h1>
        <p className="mt-3 max-w-[640px] text-[15px] text-[#a8a8b8]">
          Edit your role, goal, and focus areas; add or drop competitors. Changes land in tomorrow's
          digest.
        </p>
      </header>

      {editing ? (
        <ProfileEditor
          initial={profile}
          variant="settings"
          onCancel={() => setEditing(false)}
          onSave={onSaveEdit}
        />
      ) : (
        <ProfileSummaryCard profile={profile} onEdit={() => setEditing(true)} />
      )}

      <section className="mt-10">
        <CompetitorsList
          competitors={competitors}
          addingCompetitor={addingCompetitor}
          onShowAdd={() => setAddingCompetitor(true)}
          onHideAdd={() => setAddingCompetitor(false)}
          onAddCompetitor={onAddCompetitor}
          onRemoveCompetitor={onRemoveCompetitor}
        />
      </section>
    </main>
  );
}

function ProfileSummaryCard({
  profile,
  onEdit,
}: {
  profile: ProfileFieldsView;
  onEdit: () => void;
}) {
  return (
    <div
      className="overflow-hidden rounded-card-lg border border-[#2a2a38] bg-ink-soft"
      style={{ boxShadow: "0 40px 80px rgba(0,0,0,0.4)" }}
    >
      <div className="flex items-center justify-between border-b border-[#2a2a38] bg-[#1a1a23] px-7 py-5">
        <div className="text-[13px] text-[#888]">
          <strong className="font-semibold text-white">Your profile</strong> · used to score and
          synthesize each daily brief
        </div>
        <button
          type="button"
          onClick={onEdit}
          className="inline-flex h-9 items-center gap-2 rounded-pill border border-[#2a2a38] px-4 text-xs font-semibold uppercase tracking-[0.1em] text-white hover:bg-ink/40"
        >
          Edit
        </button>
      </div>

      <div className="grid gap-6 px-7 py-7">
        <ProfileFields profile={profile} showCompanyUrl />
      </div>
    </div>
  );
}

import { waitlist } from "~/db/schema";
import { waitlistApiSchema } from "~/features/waitlist/schema";
import { getDb } from "~/shared/server/db";
import { logger } from "~/shared/server/logger";
import { verifyAndCanonicalize } from "~/shared/server/url-server";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

export async function handleWaitlistJoin(request: Request): Promise<Response> {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return json({ ok: false, error: "invalid_json" }, 400);
  }
  const parsed = waitlistApiSchema.safeParse(payload);
  if (!parsed.success) {
    const issues = parsed.error.issues;
    const isEmail = issues.some((i) => i.path[0] === "email");
    const isUrl = issues.some((i) => i.path[0] === "companyUrl");
    return json(
      {
        ok: false,
        error: isEmail ? "invalid_email" : isUrl ? "invalid_url" : "invalid_input",
      },
      400,
    );
  }
  const { email, name, position, companyUrl, source } = parsed.data;
  const finalCompanyUrl = companyUrl ? await verifyAndCanonicalize(companyUrl) : null;
  const db = getDb();
  await db
    .insert(waitlist)
    .values({
      email,
      name: name || null,
      position: position || null,
      companyUrl: finalCompanyUrl,
      source: source || null,
    })
    .onConflictDoNothing({ target: waitlist.email });

  logger.info(
    {
      email,
      source,
      urlVerified: finalCompanyUrl !== null && finalCompanyUrl !== companyUrl,
    },
    "waitlist_joined",
  );

  return json({ ok: true });
}

import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { waitlist } from "~/db/schema";
import { getDb } from "~/lib/db";
import { logger } from "~/lib/logger";
import { normalizeUrl } from "~/lib/url";
import { verifyAndCanonicalize } from "~/lib/url-server";

const bodySchema = z.object({
  email: z.string().trim().toLowerCase().email().max(320),
  name: z.string().trim().max(160).optional(),
  position: z.string().trim().max(120).optional(),
  companyUrl: z
    .string()
    .trim()
    .max(500)
    .optional()
    .transform((v) => (v ? normalizeUrl(v) : undefined))
    .refine((v) => v !== null, { message: "invalid_url" })
    .transform((v) => v ?? undefined)
    .or(z.literal("").transform(() => undefined)),
  source: z.string().trim().max(64).optional(),
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

export const Route = createFileRoute("/api/waitlist")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        let payload: unknown;
        try {
          payload = await request.json();
        } catch {
          return json({ ok: false, error: "invalid_json" }, 400);
        }
        const parsed = bodySchema.safeParse(payload);
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
      },
    },
  },
});

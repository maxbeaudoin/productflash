import { createFileRoute } from "@tanstack/react-router";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { digests } from "~/db/schema";
import { getDb } from "~/shared/server/db";
import { logger } from "~/shared/server/logger";
import { captureServerEvent } from "~/shared/server/posthog";

// Open-tracking pixel. The digest email embeds a hidden 1×1 image whose src
// is `${baseUrl}/api/email/open/<digestId>.gif`. When the recipient's mail
// client renders the email, it fetches the pixel, which lets us record an
// "opened" timestamp + fire a PostHog `digest_opened` event.
//
// Why no signed token: the URL already contains the digest UUID (unguessable
// without seeing the email). The worst-case forgery is a third party
// inflating an opened count — not a security boundary worth a per-recipient
// HMAC at PoC scale. If we need stricter tracking later (e.g. unique-opens
// per recipient device), upgrade to the Resend webhook path which Svix-signs
// every payload.
//
// The route accepts a trailing ".gif" so we can serve a 1×1 transparent GIF
// from a path that looks like a regular image to spam filters and clients
// that prefetch images — most webmail clients (Gmail, Apple Mail) proxy
// images so the request shows up as a single hit per render.

const uuidSchema = z.string().uuid();

function extractDigestId(raw: string): string | null {
  const id = raw.endsWith(".gif") ? raw.slice(0, -".gif".length) : raw;
  return uuidSchema.safeParse(id).success ? id : null;
}

// 1×1 transparent GIF — same bytes everyone uses for tracking pixels.
const PIXEL_GIF = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");

function gifResponse(): Response {
  return new Response(PIXEL_GIF, {
    status: 200,
    headers: {
      "Content-Type": "image/gif",
      "Content-Length": String(PIXEL_GIF.length),
      // Discourage CDN/edge caching so each render registers as an open.
      "Cache-Control": "private, no-cache, no-store, must-revalidate",
      Pragma: "no-cache",
      Expires: "0",
    },
  });
}

export const Route = createFileRoute("/api/email/open/$digestId")({
  server: {
    handlers: {
      GET: async ({ params }) => {
        const id = extractDigestId(params.digestId);
        if (!id) return gifResponse(); // never break the image render

        try {
          const db = getDb();
          // Stamp opened_at only on first open — preserves the "first open"
          // semantic and keeps repeats from clobbering the original ts.
          const updated = await db
            .update(digests)
            .set({ openedAt: sql`now()` })
            .where(sql`${digests.id} = ${id} AND ${digests.openedAt} IS NULL`)
            .returning({ userId: digests.userId });

          if (updated.length > 0) {
            captureServerEvent(updated[0].userId, "digest_opened", {
              digest_id: id,
            });
            logger.info({ digestId: id, userId: updated[0].userId }, "digest opened");
          }
        } catch (err) {
          // Tracking is fire-and-forget — log the failure but always return a
          // pixel so the client doesn't render a broken-image icon.
          logger.warn({ err, digestId: id }, "open-pixel: write failed");
        }

        return gifResponse();
      },
    },
  },
});

// Server-only — imports safeFetch which uses node:dns. Do not import from
// client components; the env transitive dep pulls node:fs into the browser
// bundle and Vite chokes.
import { safeFetch, SafeFetchError } from "~/shared/server/safe-fetch";
import { logger } from "~/shared/server/logger";

const HEAD_TIMEOUT_MS = 1500;

// UX-first: any failure (timeout, 4xx/5xx, 405, SSRF reject, DNS fail)
// silently falls back to the input. The form never blocks on verification —
// ~5–15% of real sites block HEAD/bots, so a hard failure here would punish
// too many legitimate users.
export async function verifyAndCanonicalize(normalizedUrl: string): Promise<string> {
  try {
    const head = await tryVerify(normalizedUrl, "HEAD");
    if (head) return head;
    const get = await tryVerify(normalizedUrl, "GET");
    return get ?? normalizedUrl;
  } catch (err) {
    logger.debug({ err, url: normalizedUrl }, "waitlist: verify failed, falling back");
    return normalizedUrl;
  }
}

async function tryVerify(url: string, method: "HEAD" | "GET"): Promise<string | null> {
  try {
    const res = await safeFetch(url, {
      method,
      timeoutMs: HEAD_TIMEOUT_MS,
      headers: method === "GET" ? { Range: "bytes=0-0" } : undefined,
    });
    if (method === "HEAD" && res.status === 405) return null;
    if (!res.ok && res.status !== 206) return null;
    return canonicalize(res.url || url);
  } catch (err) {
    if (err instanceof SafeFetchError) return null;
    throw err;
  }
}

function canonicalize(rawUrl: string): string {
  try {
    const u = new URL(rawUrl);
    u.protocol = u.protocol.toLowerCase();
    u.hostname = u.hostname.toLowerCase();
    let out = u.toString();
    if (u.pathname === "/" && !u.search && !u.hash) out = out.replace(/\/$/, "");
    return out;
  } catch {
    return rawUrl;
  }
}

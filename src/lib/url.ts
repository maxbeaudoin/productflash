// Client + server safe — no Node-only imports. Trim → lowercase scheme/host
// → prepend https:// if no scheme → reject non-http(s), bare-word hosts (no
// TLD), credentials, and structurally invalid URLs.
export function normalizeUrl(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  // Two scheme detectors below. Without these guards, prepending https:// to
  // `mailto:hi@acme.com` produces `https://mailto:hi@acme.com` which parses
  // as userinfo=`mailto:hi` + host=`acme.com` — silently storing a
  // credential-bearing URL instead of rejecting.
  //
  // 1) `scheme://…` — explicit scheme with authority. Accept only http(s).
  const schemeSlashes = trimmed.match(/^([a-z][a-z0-9+\-]*):\/\//i);
  if (schemeSlashes && !/^https?$/i.test(schemeSlashes[1]!)) return null;
  // 2) `scheme:<alpha>…` (no //) — opaque-body URI scheme like mailto:,
  // javascript:, data:. host:port is `scheme:<digit>` so it falls through.
  if (!schemeSlashes && /^[a-z][a-z0-9+\-]*:[a-z]/i.test(trimmed)) return null;

  const withScheme = schemeSlashes ? trimmed : `https://${trimmed}`;
  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  // Credentials in URL → reject. They can obscure the actual host
  // (`https://trusted.com@evil.com`) and aren't appropriate for a waitlist.
  if (parsed.username || parsed.password) return null;
  // Reject ports — company URLs don't have them. (`acme.com:8080`.)
  if (parsed.port) return null;
  // Reject IP literals. IPv4 = all-numeric dotted host; IPv6 = bracketed.
  // Skip node:net to keep this isomorphic.
  if (/^\d+(\.\d+){3}$/.test(parsed.hostname)) return null;
  if (parsed.hostname.startsWith("[")) return null;
  // Reject localhost and bare-word hosts — must be a real domain.
  if (parsed.hostname === "localhost") return null;
  if (!parsed.hostname.includes(".")) return null;
  parsed.protocol = parsed.protocol.toLowerCase();
  parsed.hostname = parsed.hostname.toLowerCase();
  let out = parsed.toString();
  if (parsed.pathname === "/" && !parsed.search && !parsed.hash) {
    out = out.replace(/\/$/, "");
  }
  return out;
}

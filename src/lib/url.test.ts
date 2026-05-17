import { describe, expect, test } from "vitest";
import { normalizeUrl } from "./url";

describe("normalizeUrl", () => {
  // Behavior contract: bare-domain submissions must Just Work. Non-technical
  // beta users will type `acme.com`, not `https://acme.com`, and the previous
  // Zod `.url()` rejection cost us legitimate signups.
  test.each([
    ["acme.com", "https://acme.com"],
    ["  acme.com  ", "https://acme.com"],
    ["www.acme.com/", "https://www.acme.com"],
    ["HTTP://Acme.com", "http://acme.com"],
    ["https://acme.com/pricing", "https://acme.com/pricing"],
    ["acme.com/path/", "https://acme.com/path/"],
    ["sub.acme.co.uk", "https://sub.acme.co.uk"],
  ])("normalizes %j → %j", (input, expected) => {
    expect(normalizeUrl(input)).toBe(expected);
  });

  test("preserves query string and skips trailing-slash strip when present", () => {
    expect(normalizeUrl("https://acme.com/?utm=x")).toBe("https://acme.com/?utm=x");
  });

  test("preserves hash and skips trailing-slash strip when present", () => {
    expect(normalizeUrl("https://acme.com/#top")).toBe("https://acme.com/#top");
  });

  test.each([
    ["", "empty string"],
    ["   ", "whitespace only"],
    ["acme", "bare word, no TLD"],
    ["not a url", "spaces"],
    ["ftp://acme.com", "non-http(s) scheme"],
    ["javascript:alert(1)", "javascript: scheme — XSS guard"],
    ["mailto:hi@acme.com", "mailto: scheme — must not get treated as userinfo"],
    ["file:///etc/passwd", "file: scheme"],
    ["://acme.com", "malformed scheme"],
    ["https://user:pass@acme.com", "credentials in URL — reject (could obscure host)"],
    ["acme.com:8080", "port in URL — suspicious for a company URL"],
    ["https://acme.com:3000", "explicit port — same"],
    ["1.2.3.4", "IPv4 literal"],
    ["http://1.2.3.4", "IPv4 with scheme"],
    ["http://[::1]", "IPv6 loopback literal"],
    ["http://[2001:db8::1]", "IPv6 literal"],
    ["localhost", "localhost"],
    ["http://localhost", "localhost with scheme"],
    ["http://localhost:3000", "localhost with port"],
  ])("rejects %j (%s) → null", (input) => {
    expect(normalizeUrl(input)).toBeNull();
  });
});

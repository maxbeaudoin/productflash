import { createAuthClient } from "better-auth/react";
import { adminClient, magicLinkClient } from "better-auth/client/plugins";

// Browser-side auth client. baseURL is omitted — when the client runs
// in-browser it defaults to the current origin, which is exactly what we
// want for same-origin /api/auth/* calls.
export const authClient = createAuthClient({
  plugins: [magicLinkClient(), adminClient()],
});

export const { signIn, signOut, useSession } = authClient;

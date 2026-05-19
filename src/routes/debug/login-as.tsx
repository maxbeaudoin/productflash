import { createFileRoute, notFound } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { users } from "~/db/schema";
import { getDb } from "~/shared/server/db";
import { env } from "~/shared/server/env";

const loadUsers = createServerFn({ method: "GET" }).handler(async () => {
  if (env.NODE_ENV === "production") throw notFound();
  return getDb()
    .select({ id: users.id, email: users.email, role: users.role })
    .from(users)
    .orderBy(users.email);
});

export const Route = createFileRoute("/debug/login-as")({
  loader: () => loadUsers(),
  component: LoginAsPage,
});

function LoginAsPage() {
  const rows = Route.useLoaderData();

  return (
    <div className="p-8 max-w-lg">
      <h1 className="text-lg font-semibold mb-4">Sign in as…</h1>
      <ul className="space-y-2">
        {rows.map((u: { id: string; email: string; role: string | null }) => (
          <li key={u.id} className="flex items-center justify-between gap-4">
            <span className="text-sm">
              {u.email}
              {u.role === "admin" && <span className="ml-2 text-xs text-amber-500">admin</span>}
            </span>
            <a
              href={`/api/debug/login-as?userId=${u.id}`}
              className="text-xs px-3 py-1 rounded border border-white/20 hover:bg-white/10"
            >
              Sign in
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}

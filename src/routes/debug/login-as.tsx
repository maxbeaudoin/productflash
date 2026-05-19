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
    <ul>
      {rows.map((u: { id: string; email: string; role: string | null }) => (
        <li key={u.id}>
          <a href={`/api/debug/login-as?userId=${u.id}`}>
            {u.email} {u.role === "admin" ? "(admin)" : ""}
          </a>
        </li>
      ))}
    </ul>
  );
}

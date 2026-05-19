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
    <table>
      <thead>
        <tr>
          <th>email</th>
          <th>role</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        {rows.map((u: { id: string; email: string; role: string | null }) => (
          <tr key={u.id}>
            <td>{u.email}</td>
            <td>{u.role ?? "user"}</td>
            <td>
              <a href={`/api/debug/login-as?userId=${u.id}`}>sign in</a>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

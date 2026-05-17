import { requireEnv } from "~/lib/env";
import { getPool } from "~/lib/db";

// PH GraphQL schema introspection probe.
//
// Dumps the actual root Query fields + Post / User type fields with their
// argument signatures. Use this whenever PH's API surface looks like it
// might have shifted — e.g. an existing adapter query starts erroring with
// "Field 'X' doesn't accept argument 'Y'" or returns unexpected shapes.
//
// The schema captured in docs/product-hunt.md was generated from this probe
// on 2026-05-14. Re-run and update the doc if anything has changed.

async function main() {
  const token = requireEnv("PRODUCT_HUNT_TOKEN");

  const query = `
    {
      Query: __type(name: "Query") {
        fields {
          name
          args {
            name
            type { kind name ofType { kind name ofType { kind name } } }
          }
          type { kind name ofType { kind name } }
        }
      }
      Post: __type(name: "Post") {
        fields {
          name
          type { kind name ofType { kind name ofType { kind name } } }
        }
      }
      User: __type(name: "User") {
        fields {
          name
          type { kind name ofType { kind name } }
        }
      }
    }
  `;

  const res = await fetch("https://api.producthunt.com/v2/api/graphql", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ query }),
  });

  const json: any = await res.json();
  if (json.errors) {
    console.error("errors:", JSON.stringify(json.errors, null, 2));
    process.exit(1);
  }

  console.log("=== Query root fields ===");
  for (const f of json.data.Query.fields) {
    const args = f.args.map((a: any) => `${a.name}: ${typeStr(a.type)}`).join(", ");
    console.log(`  ${f.name}(${args}) -> ${typeStr(f.type)}`);
  }

  console.log("\n=== Post fields ===");
  for (const f of json.data.Post.fields) {
    console.log(`  ${f.name}: ${typeStr(f.type)}`);
  }

  console.log("\n=== User fields ===");
  for (const f of json.data.User.fields) {
    console.log(`  ${f.name}: ${typeStr(f.type)}`);
  }
}

function typeStr(t: any): string {
  if (!t) return "?";
  if (t.kind === "NON_NULL") return `${typeStr(t.ofType)}!`;
  if (t.kind === "LIST") return `[${typeStr(t.ofType)}]`;
  return t.name || t.kind;
}

main()
  .catch((err) => {
    console.error("probe failed:", err);
    process.exit(1);
  })
  .finally(() => getPool().end());

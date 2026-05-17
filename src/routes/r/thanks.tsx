import { createFileRoute, useSearch } from "@tanstack/react-router";
import { z } from "zod";

const search = z.object({
  rating: z.enum(["up", "down"]).optional(),
});

export const Route = createFileRoute("/r/thanks")({
  validateSearch: search,
  component: ThanksPage,
});

function ThanksPage() {
  const { rating } = useSearch({ from: "/r/thanks" });

  const message =
    rating === "down"
      ? "Thanks — we'll do less of that."
      : rating === "up"
        ? "Thanks — glad it was useful."
        : "Thanks for your feedback.";

  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "#0a0a0f",
        color: "#fafaf7",
        fontFamily: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
        padding: "2rem",
      }}
    >
      <div style={{ maxWidth: "32rem", textAlign: "center" }}>
        <div
          style={{
            color: "#d9ff3a",
            fontSize: "0.75rem",
            letterSpacing: "0.2em",
            textTransform: "uppercase",
            marginBottom: "1rem",
          }}
        >
          Product Flash
        </div>
        <h1 style={{ fontSize: "1.75rem", fontWeight: 600, margin: 0 }}>{message}</h1>
        <p style={{ marginTop: "0.75rem", color: "#a5a5b3", fontSize: "0.95rem" }}>
          Your feedback helps tune tomorrow's digest.
        </p>
      </div>
    </div>
  );
}

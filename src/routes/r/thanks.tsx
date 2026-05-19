import { createFileRoute, useSearch } from "@tanstack/react-router";
import { useState } from "react";
import { z } from "zod";

const COMMENT_MAX_LENGTH = 500;

const search = z.object({
  rating: z.enum(["up", "down"]).optional(),
  // Carried over from `/r/$digestItemId/$rating` so the comment form can post
  // to `/r/$digestItemId/comment` with the same down-token. Optional because
  // 👍 redirects don't carry them.
  digestItemId: z.string().uuid().optional(),
  t: z.string().optional(),
});

export const Route = createFileRoute("/r/thanks")({
  validateSearch: search,
  component: ThanksPage,
});

function ThanksPage() {
  const { rating, digestItemId, t } = useSearch({ from: "/r/thanks" });

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
      <div style={{ maxWidth: "32rem", width: "100%", textAlign: "center" }}>
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
        {rating === "down" && digestItemId && t ? (
          <CommentForm digestItemId={digestItemId} token={t} />
        ) : null}
      </div>
    </div>
  );
}

function CommentForm({ digestItemId, token }: { digestItemId: string; token: string }) {
  const [value, setValue] = useState("");
  const [pending, setPending] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const trimmed = value.trim();
  const canSend = !pending && !saved && trimmed.length > 0;

  async function send() {
    if (!canSend) return;
    setPending(true);
    setError(null);
    try {
      const res = await fetch(`/r/${digestItemId}/comment`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ comment: trimmed, token }),
      });
      if (!res.ok) {
        const text = (await res.text()) || `comment failed (${res.status})`;
        throw new Error(text);
      }
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not record comment");
    } finally {
      setPending(false);
    }
  }

  return (
    <div
      style={{
        marginTop: "1.75rem",
        textAlign: "left",
        background: "#15151c",
        border: "1px solid #2a2a38",
        borderRadius: "8px",
        padding: "1rem",
      }}
    >
      <label
        htmlFor="thanks-comment"
        style={{
          display: "block",
          fontSize: "0.7rem",
          letterSpacing: "0.1em",
          textTransform: "uppercase",
          color: "#7a7a88",
          marginBottom: "0.5rem",
        }}
      >
        What was wrong with this? (optional)
      </label>
      <textarea
        id="thanks-comment"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        maxLength={COMMENT_MAX_LENGTH}
        rows={2}
        disabled={pending || saved}
        placeholder="One line — what made this miss?"
        style={{
          width: "100%",
          resize: "none",
          background: "#0f0f15",
          border: "1px solid #2a2a38",
          borderRadius: "4px",
          color: "#fafaf7",
          fontFamily: "inherit",
          fontSize: "0.9rem",
          padding: "0.5rem",
        }}
      />
      <div
        style={{
          marginTop: "0.5rem",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          fontSize: "0.75rem",
          color: "#7a7a88",
        }}
      >
        <span>{saved ? "Saved." : error ? error : `${trimmed.length}/${COMMENT_MAX_LENGTH}`}</span>
        <button
          type="button"
          onClick={send}
          disabled={!canSend}
          style={{
            border: "1px solid #2a2a38",
            background: "transparent",
            color: canSend ? "#fafaf7" : "#7a7a88",
            borderRadius: "999px",
            padding: "0.25rem 0.85rem",
            fontSize: "0.8rem",
            cursor: canSend ? "pointer" : "default",
          }}
        >
          {pending ? "Sending…" : saved ? "Sent" : "Send"}
        </button>
      </div>
    </div>
  );
}

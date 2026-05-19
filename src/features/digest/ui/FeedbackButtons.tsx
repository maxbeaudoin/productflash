import { useMemo, useState } from "react";
import { toast } from "sonner";

type Rating = "up" | "down";

type Props = {
  digestItemId: string;
  initialRating: Rating | null;
  initialComment: string | null;
  signedUrls: { up: string; down: string };
};

// Mirrors `FEEDBACK_COMMENT_MAX_LENGTH` server-side. Kept inline so the
// client doesn't pull in `feedback-comment.ts` (server-only).
const COMMENT_MAX_LENGTH = 500;

export function FeedbackButtons({
  digestItemId,
  initialRating,
  initialComment,
  signedUrls,
}: Props) {
  const [rating, setRating] = useState<Rating | null>(initialRating);
  const [pending, setPending] = useState<Rating | null>(null);

  // The down-token is already embedded in `signedUrls.down`; pulling it out
  // here avoids minting a second token + a second signing primitive.
  const downToken = useMemo(() => extractToken(signedUrls.down), [signedUrls.down]);

  async function submit(next: Rating) {
    if (pending) return;
    const previous = rating;
    setRating(next);
    setPending(next);
    try {
      const res = await fetch(signedUrls[next], { method: "GET" });
      if (!res.ok) throw new Error(`feedback failed (${res.status})`);
      toast.success(
        next === "up" ? "Thanks — glad it was useful." : "Thanks — we'll do less of that.",
      );
    } catch (err) {
      setRating(previous);
      toast.error(err instanceof Error ? err.message : "Could not record feedback");
    } finally {
      setPending(null);
    }
  }

  return (
    <div className="mt-3 flex flex-col gap-2" data-digest-item-id={digestItemId}>
      <div className="flex items-center gap-2">
        <FeedbackPill
          label="👍"
          active={rating === "up"}
          pending={pending === "up"}
          onClick={() => submit("up")}
        />
        <FeedbackPill
          label="👎"
          active={rating === "down"}
          pending={pending === "down"}
          onClick={() => submit("down")}
        />
      </div>
      {rating === "down" && downToken ? (
        <CommentForm
          digestItemId={digestItemId}
          token={downToken}
          initialComment={initialComment}
        />
      ) : null}
    </div>
  );
}

function FeedbackPill({
  label,
  active,
  pending,
  onClick,
}: {
  label: string;
  active: boolean;
  pending: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={pending}
      className={`rounded-pill border px-3 py-1 text-sm transition-colors ${
        active
          ? "border-accent bg-accent/15 text-accent"
          : "border-[#2a2a38] text-[#a8a8b8] hover:border-accent hover:text-white"
      } disabled:opacity-50`}
    >
      {label}
    </button>
  );
}

function CommentForm({
  digestItemId,
  token,
  initialComment,
}: {
  digestItemId: string;
  token: string;
  initialComment: string | null;
}) {
  const [value, setValue] = useState(initialComment ?? "");
  const [saved, setSaved] = useState(Boolean(initialComment));
  const [pending, setPending] = useState(false);
  const trimmed = value.trim();
  const dirty = trimmed.length > 0 && trimmed !== (initialComment ?? "").trim();

  async function send() {
    if (pending || !dirty) return;
    setPending(true);
    try {
      const res = await fetch(`/r/${digestItemId}/comment`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ comment: trimmed, token }),
      });
      if (!res.ok) throw new Error(`comment failed (${res.status})`);
      setSaved(true);
      toast.success("Thanks — that detail helps.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not record comment");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="rounded-md border border-[#2a2a38] bg-[#15151c] p-3">
      <label
        htmlFor={`feedback-comment-${digestItemId}`}
        className="mb-2 block text-[11px] uppercase tracking-[0.1em] text-[#7a7a88]"
      >
        What was wrong with this? (optional)
      </label>
      <textarea
        id={`feedback-comment-${digestItemId}`}
        value={value}
        onChange={(e) => {
          setValue(e.target.value);
          setSaved(false);
        }}
        maxLength={COMMENT_MAX_LENGTH}
        rows={2}
        className="w-full resize-none rounded-sm border border-[#2a2a38] bg-[#0f0f15] px-2 py-1.5 text-sm text-white placeholder:text-[#5a5a68] focus:border-accent focus:outline-none"
        placeholder="One line — what made this miss?"
        disabled={pending}
      />
      <div className="mt-2 flex items-center justify-between text-[11px] text-[#7a7a88]">
        <span>{saved && !dirty ? "Saved." : `${trimmed.length}/${COMMENT_MAX_LENGTH}`}</span>
        <button
          type="button"
          onClick={send}
          disabled={pending || !dirty}
          className="rounded-pill border border-[#2a2a38] px-3 py-1 text-xs text-[#a8a8b8] transition-colors enabled:hover:border-accent enabled:hover:text-white disabled:opacity-50"
        >
          {pending ? "Sending…" : saved && !dirty ? "Sent" : "Send"}
        </button>
      </div>
    </div>
  );
}

function extractToken(url: string): string | null {
  const idx = url.indexOf("?t=");
  if (idx < 0) return null;
  const rest = url.slice(idx + 3);
  const amp = rest.indexOf("&");
  return decodeURIComponent(amp >= 0 ? rest.slice(0, amp) : rest);
}

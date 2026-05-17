import { useState } from "react";
import { toast } from "sonner";

type Rating = "up" | "down";

type Props = {
  digestItemId: string;
  initialRating: Rating | null;
  signedUrls: { up: string; down: string };
};

export function FeedbackButtons({ digestItemId, initialRating, signedUrls }: Props) {
  const [rating, setRating] = useState<Rating | null>(initialRating);
  const [pending, setPending] = useState<Rating | null>(null);

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
    <div className="mt-3 flex items-center gap-2" data-digest-item-id={digestItemId}>
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

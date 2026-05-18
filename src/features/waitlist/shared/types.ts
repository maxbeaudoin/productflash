export type WaitlistState = "waitlist" | "invited" | "accepted";

export type WaitlistRow = {
  id: string;
  email: string;
  name: string | null;
  position: string | null;
  companyUrl: string | null;
  source: string | null;
  invitedAt: string | null;
  createdAt: string;
  // Derived from the joined users row: a row is "accepted" once the
  // invitee actually submitted /signup (status moves past 'pending') or
  // verified the magic link (emailVerified=true). acceptedAt is a best-
  // available proxy — profileConfirmedAt when present, else updatedAt at
  // the moment of acceptance.
  state: WaitlistState;
  userId: string | null;
  acceptedAt: string | null;
};

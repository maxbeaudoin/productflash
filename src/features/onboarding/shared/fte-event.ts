export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export type FteEventRow = {
  id: string;
  runId: string;
  kind: string;
  payload: { [key: string]: JsonValue };
  ts: string;
};

export type ProfileView = {
  position: string | null;
  companyName: string | null;
  companyUrl: string | null;
  ultimateGoal: string | null;
  focusAreas: string[] | null;
  profileConfirmedAt: string | null;
};

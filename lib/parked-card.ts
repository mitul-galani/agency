export const WAKE_PARKED_SQL = `
  UPDATE ideas
  SET status = 'new', parked_until = NULL, parked_at = NULL,
      parked_note = '', created_at = CURRENT_TIMESTAMP
  WHERE status = 'parked'
    AND parked_until IS NOT NULL
    AND parked_until <= CURRENT_TIMESTAMP
`;

export function normalizeParkedUntil(input: unknown, now = new Date()) {
  if (input === null || input === undefined || input === "") return { value: null as string | null };
  if (typeof input !== "string") return { value: null, error: "Parked until must be an ISO timestamp." };
  const timestamp = input.trim();
  if (!/(?:Z|[+-]\d{2}:\d{2})$/i.test(timestamp)) {
    return { value: null, error: "Parked until needs a timezone." };
  }
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return { value: null, error: "Parked until is not a valid timestamp." };
  if (date.getTime() <= now.getTime()) return { value: null, error: "Parked until must be in the future." };
  return { value: date.toISOString().slice(0, 19).replace("T", " ") };
}

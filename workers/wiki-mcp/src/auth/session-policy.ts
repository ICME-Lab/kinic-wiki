export const II_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const REVIEW_SESSION_TTL_MS = 8 * 60 * 60 * 1000;

// Keep all replay hashes for the session, including proactive hourly refreshes.
export const MAX_REFRESH_ROTATIONS = 4096;

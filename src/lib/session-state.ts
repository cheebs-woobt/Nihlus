// Per-day usage counters. Kept separate from UserConfig because these
// are observations, not preferences — a user clicking "save" in the
// popup shouldn't accidentally rewrite the dismissal count, and a
// daily reset shouldn't ever touch the user's allow / block lists.
//
// Reset semantics: lazy. Every read checks whether sessionResetDate is
// today; if not, the row is overwritten with a fresh state before the
// caller sees it. That avoids needing chrome.alarms for a midnight
// timer and keeps the file simple.

const STORAGE_KEY = "sessionState";
const MAX_RECENT_DISMISSED_SITES = 10;

export interface SessionState {
  // Count of times the user has clicked the dismiss button on a banter
  // overlay since the last daily reset.
  sessionDismissals: number;
  // YYYY-MM-DD in the user's local timezone. Compared against
  // todayIsoDate() on every read; mismatch triggers a reset.
  sessionResetDate: string;
  // Most-recent first list of hostnames where banter was dismissed
  // today. Capped at MAX_RECENT_DISMISSED_SITES; surfaced to the LLM
  // banter generator so it can call back to a pattern. Deduped, so
  // re-dismissing the same site moves it to the front without growing
  // the list.
  recentlyDismissedSites: string[];
}

export function defaultSessionState(): SessionState {
  return {
    sessionDismissals: 0,
    sessionResetDate: todayIsoDate(),
    recentlyDismissedSites: [],
  };
}

export async function getSessionState(): Promise<SessionState> {
  let raw: unknown;
  try {
    const result = await chrome.storage.local.get(STORAGE_KEY);
    raw = result[STORAGE_KEY];
  } catch (err) {
    console.warn("[Nihlus session] read failed; using defaults:", err);
    return defaultSessionState();
  }
  const current = sanitize(raw);
  const today = todayIsoDate();
  if (current.sessionResetDate !== today) {
    const reset: SessionState = {
      sessionDismissals: 0,
      sessionResetDate: today,
      recentlyDismissedSites: [],
    };
    try {
      await chrome.storage.local.set({ [STORAGE_KEY]: reset });
    } catch (err) {
      console.warn("[Nihlus session] reset write failed:", err);
    }
    return reset;
  }
  return current;
}

// Read-modify-write. Returns the post-increment state. Daily reset is
// applied first via getSessionState so a dismissal on a new day starts
// the counter at 1, not (yesterday + 1). When hostname is provided, it
// is pushed to the front of recentlyDismissedSites (deduped, capped).
export async function incrementDismissals(
  hostname: string | null = null,
): Promise<SessionState> {
  const cur = await getSessionState();
  const dismissed = pushRecentSite(cur.recentlyDismissedSites, hostname);
  const next: SessionState = {
    sessionDismissals: cur.sessionDismissals + 1,
    sessionResetDate: cur.sessionResetDate,
    recentlyDismissedSites: dismissed,
  };
  try {
    await chrome.storage.local.set({ [STORAGE_KEY]: next });
  } catch (err) {
    console.warn("[Nihlus session] increment write failed:", err);
  }
  return next;
}

function pushRecentSite(
  current: readonly string[],
  hostname: string | null,
): string[] {
  if (hostname === null || hostname.length === 0) return [...current];
  const filtered = current.filter((h) => h !== hostname);
  filtered.unshift(hostname);
  if (filtered.length > MAX_RECENT_DISMISSED_SITES) {
    filtered.length = MAX_RECENT_DISMISSED_SITES;
  }
  return filtered;
}

function sanitize(raw: unknown): SessionState {
  if (typeof raw !== "object" || raw === null) return defaultSessionState();
  const o = raw as Record<string, unknown>;
  const count =
    typeof o["sessionDismissals"] === "number" && Number.isFinite(o["sessionDismissals"])
      ? Math.max(0, Math.floor(o["sessionDismissals"]))
      : 0;
  const date =
    typeof o["sessionResetDate"] === "string" && /^\d{4}-\d{2}-\d{2}$/.test(o["sessionResetDate"])
      ? o["sessionResetDate"]
      : todayIsoDate();
  const sites = sanitizeSiteList(o["recentlyDismissedSites"]);
  return { sessionDismissals: count, sessionResetDate: date, recentlyDismissedSites: sites };
}

function sanitizeSiteList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string") continue;
    const cleaned = entry.trim().toLowerCase();
    if (cleaned.length === 0) continue;
    if (out.includes(cleaned)) continue;
    out.push(cleaned);
    if (out.length >= MAX_RECENT_DISMISSED_SITES) break;
  }
  return out;
}

function todayIsoDate(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export const SESSION_STATE_STORAGE_KEY = STORAGE_KEY;

import type { UserConfig } from "./config.ts";

// Per-URL decision feeding the future intervention layer.
//   - "distracting": user is somewhere they shouldn't be (Nihlus would
//     intervene)
//   - "allowed": URL is explicitly on the allow list, fine to ignore
//   - "neutral": no list opinion (blacklist mode + URL not blocked, or
//     focus mode off, or URL we can't classify)
export type UrlVerdict = "distracting" | "allowed" | "neutral";

export interface UrlDecision {
  verdict: UrlVerdict;
  // The matched list entry, if any. Useful for future banter that wants
  // to quote the rule back at the user.
  matchedEntry: string | null;
}

// Decision policy:
//   1. Focus mode off                                          → neutral
//   2. URL hostname matches any non-expired temporaryBlacklist → distracting
//      (Phase 6: auto-blocks from level-5/6 close actions)
//   3. URL hostname matches any blockedSites entry             → distracting
//   4. URL hostname matches any allowedSites entry             → allowed
//   5. allowedSites is non-empty AND no allow match            → distracting
//      (whitelist mode: anything not listed is off-task)
//   6. allowedSites is empty                                   → neutral
//      (blacklist mode: distractions are only the blocked list)
//
// Blocked wins over allowed on conflict so a user accidentally listing
// the same domain in both still gets called out, which matches the
// "people who'd resist a soft tool" framing.
export function classifyUrl(config: UserConfig, url: string): UrlDecision {
  if (!config.focusModeActive) return { verdict: "neutral", matchedEntry: null };

  const hostname = extractHostname(url);
  if (hostname === null) return { verdict: "neutral", matchedEntry: null };

  // Temporary auto-blocks. Filter expired on the fly; the saved list
  // is also pruned on next loadConfig, but checking here means a
  // freshly-expired entry can't bite while a write is in flight.
  const now = Date.now();
  for (const entry of config.temporaryBlacklist) {
    if (entry.expiresAt <= now) continue;
    if (hostname.includes(entry.hostname)) {
      return { verdict: "distracting", matchedEntry: entry.hostname };
    }
  }

  const blockedHit = matchAny(hostname, config.blockedSites);
  if (blockedHit !== null) return { verdict: "distracting", matchedEntry: blockedHit };

  const allowedHit = matchAny(hostname, config.allowedSites);
  if (allowedHit !== null) return { verdict: "allowed", matchedEntry: allowedHit };

  if (config.allowedSites.length > 0) {
    return { verdict: "distracting", matchedEntry: null };
  }
  return { verdict: "neutral", matchedEntry: null };
}

// Returns the matched entry (the user's original string) on hit, null
// on miss. Substring match against the lowercased hostname so a user
// entering "youtube.com" matches both youtube.com and www.youtube.com,
// and an entry like "docs" matches docs.google.com.
function matchAny(hostname: string, list: readonly string[]): string | null {
  for (const entry of list) {
    if (entry.length === 0) continue;
    if (hostname.includes(entry)) return entry;
  }
  return null;
}

// Returns the lowercased hostname, or null for URLs we shouldn't try to
// classify (chrome://, about:, file://, malformed). Caller treats null
// as "no opinion" so the service worker stays quiet on internal pages.
export function extractHostname(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  return parsed.hostname.toLowerCase();
}

// Static banter pool. Fires as fallback when AI banter is disabled or
// fails. Tone per the Phase 6 follow-up calibration: direct, present,
// declarative. No hedging tags (no "just", "maybe", "perhaps"). The
// AI branch in service-worker.ts handles dynamic commitment quoting;
// the static lines work without specific commitment context but still
// name what the user did. 14 of 15 are declarative (line 8 is the one
// pointed question, kept for variety on the confrontational tier).

const BANTER_POOL: readonly string[] = [
  "YouTube. Right. The plan didn't include this.",
  "You committed to something else this morning. This is not it.",
  "Three dismissals in twenty minutes. Be real with yourself.",
  "Close the tab. You know.",
  "Twenty minutes here. You set the rules. You broke them.",
  "You opened this and you knew.",
  "The plan didn't include this site. You know what to do.",
  "Back here again. What are you actually avoiding?",
  "This isn't the work. You decided it wasn't this morning.",
  "Stop. Go finish the thing you opened first.",
  "You're not relaxing. You're escaping.",
  "Forty minutes lost. The plan is waiting.",
  "Pattern noted: every time it gets hard, you come here.",
  "This is the third tab today. The work is over there.",
  "You set a deadline this morning. This page isn't helping you hit it.",
];

export interface BanterPick {
  // Index into BANTER_POOL. Stable across the session so the worker
  // can echo it through the dismissal round-trip and future heuristics
  // can correlate per-message dismissal counts.
  id: number;
  message: string;
}

// Session-scope rotation tracker. Held in module state because the
// service worker only imports this from one place; if the worker is
// torn down by Chrome and re-imported, the rotation resets, which is
// the intended "new session" semantics. Phase 5 may persist this.
const seenIds = new Set<number>();

// Pick a banter line the user hasn't seen this session. When all lines
// have been shown, the rotation resets and the next pick is fresh from
// the full pool. Uses Math.random for selection — not security-grade,
// fine for variety.
export function pickBanter(): BanterPick {
  if (seenIds.size >= BANTER_POOL.length) {
    seenIds.clear();
  }
  const remaining: number[] = [];
  for (let i = 0; i < BANTER_POOL.length; i++) {
    if (!seenIds.has(i)) remaining.push(i);
  }
  // Defensive: BANTER_POOL is non-empty so remaining is non-empty after
  // the reset above, but tsc's noUncheckedIndexedAccess gates the
  // access through an undefined check.
  const pickIdx = remaining[Math.floor(Math.random() * remaining.length)];
  if (pickIdx === undefined) {
    throw new Error("Banter pool empty");
  }
  const message = BANTER_POOL[pickIdx];
  if (message === undefined) {
    throw new Error(`Banter index ${pickIdx} out of range`);
  }
  seenIds.add(pickIdx);
  return { id: pickIdx, message };
}

// Test / admin hook. The worker doesn't call this in normal flow.
export function resetBanterRotation(): void {
  seenIds.clear();
}

export function banterPoolSize(): number {
  return BANTER_POOL.length;
}

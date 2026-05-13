// Static banter pool. Phase 3 deliberately keeps these flat strings,
// no dynamic templating, no model calls. Tone target per Wyatt's spec:
// pointed but not preachy, named-not-shamed, designed for someone who
// would resist a hard tool but ignore a soft one. Phase 4 swaps this
// for an LLM-backed pool; the picker interface stays the same.

const BANTER_POOL: readonly string[] = [
  "Hmm. Is this what we agreed on?",
  "Quick check: is this the thing, or a thing-shaped escape?",
  "Five seconds. Tab close, or genuine yes?",
  "I noticed. That's all.",
  "The commitment of the hour is still open in another tab.",
  "You can rationalize this one. That's how we got here.",
  "Calling it: this isn't the work.",
  "Just naming the pattern. Avoidance.",
  "If past-you saw this tab right now, what would they say?",
  "Here on purpose, or here on reflex?",
  "I'd be a worse extension if I didn't mention this.",
  "Hi. Yes. I see you.",
  "This is the soft nudge. You know what comes next.",
  "Two minutes here becomes twenty. You already know this.",
  "The plan didn't include this site. Just an observation.",
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

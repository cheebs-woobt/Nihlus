// Phase 6 star-level system. The user's current "wanted level"
// (GTA-inspired) determines overlay variant, countdown timing, and
// timeout behavior. The level moves up and down based on behavior;
// the worker's escalation triggers and the decay alarm are the
// drivers. This module owns:
//   - the level → behavior mapping (pure)
//   - the adjustStarLevel mutation (read / clamp / write / log)
//   - star display helpers used by the popup
//
// All level-driven config (countdown duration, blacklist minutes,
// overlay variant) lives in getStarBehavior so a future calibration
// edits one table, not five call sites.

import {
  loadConfig,
  MAX_ESCALATION_EVENTS,
  saveConfig,
  STAR_LEVEL_CEILING,
  STAR_LEVEL_FLOOR,
  type EscalationEvent,
  type UserConfig,
} from "./config.ts";

export type OverlayVariant = "none" | "small" | "standard" | "large";
export type TimeoutAction = "interrupt-page" | "close-with-blacklist";

export interface StarBehavior {
  // Visual size tier for the overlay. "none" suppresses the overlay
  // entirely so the worker still classifies + logs but the user is
  // not interrupted.
  overlay: OverlayVariant;
  // Countdown duration in seconds the overlay displays. null means no
  // countdown (no auto-action). 0 means fire immediately.
  countdown: number | null;
  // What the worker does when the countdown elapses. null is paired
  // with countdown === null (no action).
  onTimeout: TimeoutAction | null;
  // Minutes to add the offending hostname to the temporary blacklist
  // when onTimeout === "close-with-blacklist". null otherwise.
  blacklistDurationMin: number | null;
}

// Hand-tuned table. Index lookup uses Math.floor of the user's
// fractional starLevel so values between integers fall back to the
// lower tier. Levels above STAR_LEVEL_CEILING clamp to 6.
const BEHAVIOR_BY_LEVEL: readonly StarBehavior[] = [
  { overlay: "none", countdown: null, onTimeout: null, blacklistDurationMin: null },
  { overlay: "small", countdown: null, onTimeout: null, blacklistDurationMin: null },
  { overlay: "standard", countdown: null, onTimeout: null, blacklistDurationMin: null },
  { overlay: "standard", countdown: 30, onTimeout: "interrupt-page", blacklistDurationMin: null },
  { overlay: "large", countdown: 10, onTimeout: "interrupt-page", blacklistDurationMin: null },
  { overlay: "large", countdown: 0, onTimeout: "close-with-blacklist", blacklistDurationMin: 10 },
  { overlay: "large", countdown: 0, onTimeout: "close-with-blacklist", blacklistDurationMin: 1440 },
];

export function getStarBehavior(level: number): StarBehavior {
  const idx = Math.max(STAR_LEVEL_FLOOR, Math.min(STAR_LEVEL_CEILING, Math.floor(level)));
  const b = BEHAVIOR_BY_LEVEL[idx];
  // BEHAVIOR_BY_LEVEL has STAR_LEVEL_CEILING + 1 entries; idx is
  // clamped to that range. The undefined branch is unreachable but
  // tsc's noUncheckedIndexedAccess wants a guard.
  if (b === undefined) {
    return { overlay: "none", countdown: null, onTimeout: null, blacklistDurationMin: null };
  }
  return b;
}

// Mutate UserConfig.starLevel by delta, clamped to [starMinimum, starMaximum],
// and append an EscalationEvent to the rolling log. Writes once. Returns
// the updated config so the caller can read the new level without a
// re-load. If the level wouldn't actually change (already at the
// clamped bound), the event is still logged so dismiss-pattern detection
// can count "attempted escalation while pinned at max".
export async function adjustStarLevel(
  delta: number,
  reason: string,
): Promise<UserConfig> {
  const cur = await loadConfig();
  const raw = cur.starLevel + delta;
  const next = Math.max(cur.starMinimum, Math.min(cur.starMaximum, raw));
  const event: EscalationEvent = {
    timestamp: Date.now(),
    delta,
    reason,
  };
  const escalationEvents = [...cur.escalationEvents, event];
  while (escalationEvents.length > MAX_ESCALATION_EVENTS) {
    escalationEvents.shift();
  }
  const updated: UserConfig = {
    ...cur,
    starLevel: next,
    escalationEvents,
  };
  await saveConfig(updated);
  return updated;
}

// Force the star level to an explicit value (clamped). Used by the
// "Reset" button in the popup (delta is implicit so we don't have to
// guess which way to go) and by the advanced "Starting level" slider.
export async function setStarLevel(value: number, reason: string): Promise<UserConfig> {
  const cur = await loadConfig();
  const clamped = Math.max(cur.starMinimum, Math.min(cur.starMaximum, value));
  const event: EscalationEvent = {
    timestamp: Date.now(),
    delta: clamped - cur.starLevel,
    reason,
  };
  const escalationEvents = [...cur.escalationEvents, event];
  while (escalationEvents.length > MAX_ESCALATION_EVENTS) {
    escalationEvents.shift();
  }
  const updated: UserConfig = {
    ...cur,
    starLevel: clamped,
    escalationEvents,
  };
  await saveConfig(updated);
  return updated;
}

// Returns the integer star count rendered in the popup. Math.floor so
// the user sees a level upgrade only after the threshold is fully
// crossed; e.g. starLevel 2.75 still reads "2 of 6".
export function visibleStars(level: number): number {
  return Math.max(0, Math.min(STAR_LEVEL_CEILING, Math.floor(level)));
}

// Convenience for the popup star strip. Returns one entry per slot
// (filled or empty) so the renderer can map over a stable array.
export function renderStarStrip(level: number): boolean[] {
  const filled = visibleStars(level);
  const out: boolean[] = [];
  for (let i = 0; i < STAR_LEVEL_CEILING; i++) {
    out.push(i < filled);
  }
  return out;
}

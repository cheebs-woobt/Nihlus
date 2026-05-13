import { pickBanter } from "../lib/banter.ts";
import { classifyUrl, extractHostname } from "../lib/classify.ts";
import {
  defaultUserConfig,
  loadConfig,
  saveConfig,
  USER_CONFIG_STORAGE_KEY,
  type TemporaryBlock,
  type UserConfig,
} from "../lib/config.ts";
import {
  deriveTimeOfDay,
  generateBanter,
  type BanterContext,
  type GenerateBanterResult,
} from "../lib/llm.ts";
import {
  isBanterDismissedMessage,
  isRepulseFiredMessage,
  type ShowBanterMessage,
} from "../lib/messages.ts";
import {
  countDismissalsToday,
  getSessionState,
  recordDismissal,
} from "../lib/session-state.ts";
import {
  adjustStarLevel,
  getStarBehavior,
  type StarBehavior,
} from "../lib/star.ts";

// MV3 service worker. Phase 6 responsibilities (additive over Phase 5):
//   - Escalation triggers: dismiss +0.5, distraction visit +0.25,
//     rapid-reopen +1, dismiss-pattern (5+ in 30min) +1.
//   - Decay: chrome.alarms periodic check. If no escalation event in
//     the last 30min and starLevel > starMinimum, fire -1 "clean-focus".
//   - Behavior dispatch by getStarBehavior(level):
//       level 0   → no overlay (silent classify + log)
//       level 1   → small overlay
//       level 2   → standard overlay
//       level 3   → standard + 30s countdown → interrupt page
//       level 4   → large + 10s countdown → interrupt page
//       level 5-6 → large + 0s countdown → close tab + temp blacklist
//   - Per-tab close-action timer (countdownByTab Map). Cancel on
//     dismiss, URL-change-away, or tab close.
//   - Rapid-reopen detection: when Nihlus closes a hostname, the
//     worker remembers it for 60s; a fresh visit within that window
//     triggers the +1 escalation.

const COOLDOWN_MS = 30_000;
const RECENT_BANTER_CACHE = 3;
const RAPID_REOPEN_WINDOW_MS = 60_000;
const DISMISS_PATTERN_WINDOW_MS = 30 * 60_000;
const DISMISS_PATTERN_THRESHOLD = 5;
const CLEAN_FOCUS_WINDOW_MS = 30 * 60_000;
const DECAY_ALARM_NAME = "nihlus-decay-check";
const DECAY_ALARM_PERIOD_MIN = 5;
const INTERRUPT_PAGE_PATH = "src/interrupt/interrupt.html";

const tabCooldownExpiresAt = new Map<number, number>();
const lastBanterUrlByTab = new Map<number, string>();
const recentAiBanters: string[] = [];

// Per-tab pending close-action timer. setTimeout in MV3 service workers
// keeps the worker alive as long as the timer is pending, so a 30-second
// countdown reliably fires.
interface CountdownEntry {
  url: string;
  deadline: number;
  timeoutId: number;
}
const countdownByTab = new Map<number, CountdownEntry>();

// Hostnames Nihlus just closed. Used to detect rapid re-open: if any
// URL hits a hostname inside this map's TTL, fire the escalation.
const recentlyClosedHostnames = new Map<string, number>();

chrome.runtime.onInstalled.addListener((details) => {
  console.log("Nihlus service worker installed", details.reason);
  void ensureDefaultConfig();
  ensureDecayAlarm();
});

// Some Chrome builds tear down + restart the worker on browser launch
// without firing onInstalled. Idempotent alarm creation here covers
// that path.
ensureDecayAlarm();

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== DECAY_ALARM_NAME) return;
  void maybeDecay();
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  const url = pickUrl(changeInfo, tab);
  if (url !== null) {
    void classifyAndLog(url);
    void checkRapidReopen(url);
  }
  // Countdown cancellation: any committed URL change to a different
  // URL than the one we armed the timer for cancels the pending close.
  if (changeInfo.url !== undefined) {
    const entry = countdownByTab.get(tabId);
    if (entry !== undefined && entry.url !== changeInfo.url) {
      clearCountdown(tabId, "URL changed");
    }
  }
  if (changeInfo.status !== "complete") return;
  const finalUrl = typeof tab.url === "string" ? tab.url : url;
  if (finalUrl === null) return;
  void maybeSendBanter(tabId, finalUrl);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  tabCooldownExpiresAt.delete(tabId);
  lastBanterUrlByTab.delete(tabId);
  const entry = countdownByTab.get(tabId);
  if (entry !== undefined) {
    clearTimeout(entry.timeoutId);
    countdownByTab.delete(tabId);
  }
});

chrome.runtime.onMessage.addListener((message, sender) => {
  if (isRepulseFiredMessage(message)) {
    const tabId = sender.tab?.id ?? -1;
    console.log(`Nihlus repulse fired on tab ${tabId} (45s no-action)`);
    return;
  }
  if (!isBanterDismissedMessage(message)) return;
  const tabId = sender.tab?.id;
  if (tabId !== undefined) {
    tabCooldownExpiresAt.set(tabId, Date.now() + COOLDOWN_MS);
    // Dismiss cancels any pending firm-mode close.
    clearCountdown(tabId, "dismissed");
  }
  const url = tabId !== undefined ? lastBanterUrlByTab.get(tabId) ?? "" : "";
  const hostname = url.length > 0 ? extractHostname(url) ?? "" : "";
  void handleDismissalEscalation(message.banterId, url, hostname, message.reason);
});

async function handleDismissalEscalation(
  banterId: number,
  url: string,
  hostname: string,
  reason: import("../lib/session-state.ts").DismissReason,
): Promise<void> {
  const state = await recordDismissal({ banterId, url, hostname, reason });
  const todayCount = countDismissalsToday(state);
  console.log(
    `Nihlus banter dismissed (${reason}, id ${banterId}). Today: ${todayCount} dismissals.`,
  );
  // Each dismiss is +0.5 stars baseline.
  await adjustStarLevel(0.5, "dismiss");
  // 5+ dismissals within the trailing 30 minutes adds another +1.
  const now = Date.now();
  const recent = state.dismissals.filter(
    (d) => now - d.timestamp <= DISMISS_PATTERN_WINDOW_MS,
  );
  if (recent.length >= DISMISS_PATTERN_THRESHOLD) {
    await adjustStarLevel(1, "dismiss-pattern");
  }
}

async function ensureDefaultConfig(): Promise<void> {
  try {
    const result = await chrome.storage.local.get(USER_CONFIG_STORAGE_KEY);
    if (result[USER_CONFIG_STORAGE_KEY] !== undefined) return;
    await saveConfig(defaultUserConfig());
    console.log("Nihlus wrote default UserConfig on first install");
  } catch (err) {
    console.warn("Nihlus ensureDefaultConfig failed:", err);
  }
}

function ensureDecayAlarm(): void {
  // create() is idempotent — replaces an existing alarm with the same
  // name, so re-running on every worker boot is safe.
  chrome.alarms.create(DECAY_ALARM_NAME, { periodInMinutes: DECAY_ALARM_PERIOD_MIN });
}

async function maybeDecay(): Promise<void> {
  const config = await loadConfig();
  if (config.starLevel <= config.starMinimum) return;
  const events = config.escalationEvents;
  const lastEvent = events.length > 0 ? events[events.length - 1] : undefined;
  const lastTs = lastEvent !== undefined ? lastEvent.timestamp : 0;
  if (Date.now() - lastTs < CLEAN_FOCUS_WINDOW_MS) return;
  const updated = await adjustStarLevel(-1, "clean-focus");
  console.log(`Nihlus clean-focus decay: star level now ${updated.starLevel.toFixed(2)}`);
}

async function checkRapidReopen(url: string): Promise<void> {
  const hostname = extractHostname(url);
  if (hostname === null) return;
  const closedAt = recentlyClosedHostnames.get(hostname);
  if (closedAt === undefined) return;
  const now = Date.now();
  if (now - closedAt > RAPID_REOPEN_WINDOW_MS) {
    recentlyClosedHostnames.delete(hostname);
    return;
  }
  // Trigger once; clear the entry so a long browsing session on the
  // same host doesn't fire repeatedly.
  recentlyClosedHostnames.delete(hostname);
  console.log(`Nihlus rapid-reopen detected for ${hostname}`);
  await adjustStarLevel(1, "rapid-reopen");
}

async function classifyAndLog(url: string): Promise<void> {
  const hostname = extractHostname(url);
  if (hostname === null) return;

  const config = await loadConfig();
  const decision = classifyUrl(config, url);

  if (decision.verdict === "distracting") {
    const reason =
      decision.matchedEntry !== null
        ? `matched blocked entry "${decision.matchedEntry}"`
        : `not on allow list (whitelist mode)`;
    console.log(`Nihlus would intervene here: ${url}  (${reason})`);
    // Distraction-visit nudge. Only escalates while below max so the
    // user pinned at starMaximum doesn't accumulate adjustment events
    // they can't see in the level. The clamp inside adjustStarLevel
    // would no-op the level change anyway, but skipping the call also
    // skips the event log entry which we'd rather keep tidy.
    if (config.starLevel < config.starMaximum) {
      await adjustStarLevel(0.25, "distraction-visit");
    }
    return;
  }
  if (decision.verdict === "allowed") {
    console.log(`Nihlus allowed ${hostname} (matched "${decision.matchedEntry ?? ""}")`);
    return;
  }
  if (config.focusModeActive) {
    console.debug(`Nihlus neutral: ${hostname} (no list match, blacklist mode)`);
  }
}

async function maybeSendBanter(tabId: number, url: string): Promise<void> {
  const hostname = extractHostname(url);
  if (hostname === null) return;

  const cooldownExpiry = tabCooldownExpiresAt.get(tabId) ?? 0;
  if (Date.now() < cooldownExpiry) {
    console.debug(`Nihlus banter suppressed: tab ${tabId} cooldown active`);
    return;
  }
  // Re-fire on refresh of the same URL only if a firm countdown is
  // active (the user refreshed mid-countdown and needs to see the new
  // remaining time). Otherwise dedupe.
  const sameUrlAsLast = lastBanterUrlByTab.get(tabId) === url;
  const activeCountdown = countdownByTab.get(tabId);
  const countdownStillRunning =
    activeCountdown !== undefined && activeCountdown.url === url;
  if (sameUrlAsLast && !countdownStillRunning) return;

  const config = await loadConfig();
  const decision = classifyUrl(config, url);
  if (decision.verdict !== "distracting") return;

  const behavior = getStarBehavior(config.starLevel);
  if (behavior.overlay === "none") {
    // Level 0: silent. Worker still logs above, but the page is left
    // alone.
    return;
  }

  const { message, banterId, source } = await pickAnyBanter(config, url);
  lastBanterUrlByTab.set(tabId, url);

  // Countdown bookkeeping. If a countdown is already running for this
  // URL we keep the existing deadline; otherwise arm a new timer.
  let countdownSeconds: number | null = null;
  if (behavior.countdown !== null) {
    if (countdownStillRunning && activeCountdown !== undefined) {
      countdownSeconds = Math.max(
        0,
        Math.ceil((activeCountdown.deadline - Date.now()) / 1000),
      );
    } else {
      countdownSeconds = behavior.countdown;
      armCountdown(tabId, url, behavior);
    }
  }

  const out: ShowBanterMessage = {
    type: "nihlus/show-banter",
    message,
    banterId,
    soundEnabled: config.overlaySoundEnabled,
    overlay: behavior.overlay,
    countdownSeconds,
    starLevel: config.starLevel,
  };

  await sendBanterWithRetry(tabId, out, source);
}

function armCountdown(tabId: number, url: string, behavior: StarBehavior): void {
  if (behavior.countdown === null) return;
  const ms = behavior.countdown * 1000;
  const deadline = Date.now() + ms;
  const timeoutId = setTimeout(() => {
    void fireCountdown(tabId, url, behavior);
  }, ms) as unknown as number;
  countdownByTab.set(tabId, { url, deadline, timeoutId });
}

function clearCountdown(tabId: number, reason: string): void {
  const entry = countdownByTab.get(tabId);
  if (entry === undefined) return;
  clearTimeout(entry.timeoutId);
  countdownByTab.delete(tabId);
  console.log(`Nihlus countdown canceled for tab ${tabId} (${reason})`);
}

async function fireCountdown(
  tabId: number,
  url: string,
  behavior: StarBehavior,
): Promise<void> {
  // Cancellation race: between the setTimeout fire and now, the user
  // may have dismissed or navigated. Re-check that the entry we armed
  // is still the active one.
  const entry = countdownByTab.get(tabId);
  if (entry === undefined || entry.url !== url) return;
  countdownByTab.delete(tabId);

  const hostname = extractHostname(url) ?? "";

  if (behavior.onTimeout === "interrupt-page") {
    const interruptUrl = chrome.runtime.getURL(INTERRUPT_PAGE_PATH);
    try {
      await chrome.tabs.update(tabId, { url: interruptUrl });
      console.log(`Nihlus countdown fired on tab ${tabId}: navigated to interrupt page`);
    } catch (err) {
      console.warn(`Nihlus countdown navigate failed for tab ${tabId}:`, err);
    }
    return;
  }
  if (behavior.onTimeout === "close-with-blacklist") {
    if (hostname.length > 0 && behavior.blacklistDurationMin !== null) {
      await pushTemporaryBlock(hostname, behavior.blacklistDurationMin);
      recentlyClosedHostnames.set(hostname, Date.now());
    }
    try {
      await chrome.tabs.remove(tabId);
      console.log(
        `Nihlus countdown fired on tab ${tabId}: closed + blacklisted ${hostname} ` +
          `for ${behavior.blacklistDurationMin ?? 0}m`,
      );
    } catch (err) {
      console.warn(`Nihlus countdown close failed for tab ${tabId}:`, err);
    }
  }
}

async function pushTemporaryBlock(hostname: string, durationMin: number): Promise<void> {
  const config = await loadConfig();
  const expiresAt = Date.now() + durationMin * 60_000;
  // Replace any existing entry for this host so the longest active
  // block wins (level 6 = 1440 minutes overwrites a stale level-5
  // entry).
  const filtered = config.temporaryBlacklist.filter((b) => b.hostname !== hostname);
  const entry: TemporaryBlock = { hostname, expiresAt };
  const updated: UserConfig = {
    ...config,
    temporaryBlacklist: [...filtered, entry],
  };
  await saveConfig(updated);
}

// Issue 1 (race): tabs.onUpdated fires status="complete" before the
// content script's chrome.runtime.onMessage listener has finished
// registering on some pages. The send then rejects with "Could not
// establish connection. Receiving end does not exist." Sleep 250ms
// and retry once.
async function sendBanterWithRetry(
  tabId: number,
  out: ShowBanterMessage,
  source: "ai" | "static",
): Promise<void> {
  if (await trySend(tabId, out)) {
    console.debug(`Nihlus sent ${source} banter (id ${out.banterId}) to tab ${tabId}`);
    return;
  }
  await sleep(250);
  if (await trySend(tabId, out)) {
    console.debug(
      `Nihlus sent ${source} banter (id ${out.banterId}) to tab ${tabId} on retry`,
    );
    return;
  }
  console.debug(
    `Nihlus banter undeliverable to tab ${tabId} (no content script after retry).`,
  );
}

async function trySend(tabId: number, out: ShowBanterMessage): Promise<boolean> {
  try {
    await chrome.tabs.sendMessage(tabId, out);
    return true;
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

interface BanterChoice {
  message: string;
  banterId: number;
  source: "ai" | "static";
}

async function pickAnyBanter(config: UserConfig, url: string): Promise<BanterChoice> {
  if (config.aiBanterEnabled && config.claudeApiKey.length > 0) {
    const session = await getSessionState();
    const ctx: BanterContext = {
      url,
      commitmentOfTheDay: session.commitmentOfTheDay,
      commitmentOfTheHour: config.commitmentOfTheHour,
      dismissalCountToday: countDismissalsToday(session),
      timeOfDay: deriveTimeOfDay(),
      recentlyDismissedSites: session.recentlyDismissedSites,
      recentBanters: recentAiBanters,
    };
    const result = await generateBanter(ctx, {
      apiKey: config.claudeApiKey,
      model: config.claudeModel,
    });
    if (result.ok) {
      pushRecentAiBanter(result.message);
      return { message: result.message, banterId: -1, source: "ai" };
    }
    logAiFallback(result);
  }
  const pick = pickBanter();
  return { message: pick.message, banterId: pick.id, source: "static" };
}

function pushRecentAiBanter(message: string): void {
  recentAiBanters.push(message);
  while (recentAiBanters.length > RECENT_BANTER_CACHE) {
    recentAiBanters.shift();
  }
}

function logAiFallback(result: GenerateBanterResult & { ok: false }): void {
  console.warn(`Nihlus AI banter failed (${result.reason}); using static pool.`);
}

function pickUrl(
  changeInfo: chrome.tabs.TabChangeInfo,
  tab: chrome.tabs.Tab,
): string | null {
  if (changeInfo.url !== undefined) return changeInfo.url;
  if (changeInfo.status === "complete" && typeof tab.url === "string") {
    return tab.url;
  }
  return null;
}

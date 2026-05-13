import {
  isShowBanterMessage,
  type BanterDismissedMessage,
  type RepulseFiredMessage,
  type ShowBanterMessage,
} from "../lib/messages.ts";
import {
  DISMISS_REASONS,
  type DismissReason,
} from "../lib/session-state.ts";

// Page-injected banter overlay. Lives in a closed shadow DOM so the
// host page's CSS can't restyle it and the host's JS can't query it.
// Single instance per page; a fresh ShowBanterMessage replaces the
// existing overlay rather than stacking.
//
// Phase 6 variants:
//   - "small":    320 px, condensed padding, neutral border.
//   - "standard": 440 px, the post-calibration card (purple accent).
//   - "large":    560 px, 4 px warning border, slightly louder header.
// All three share the same DOM tree; the variant modifier class
// switches the styling.

console.log("Nihlus content script active on:", window.location.href);

const REPULSE_TIMEOUT_MS = 45_000;
const REPULSE_MOUSEMOVE_GRACE_MS = 5_000;
const REPULSE_ANIMATION_MS = 700;

interface OverlayHandle {
  host: HTMLDivElement;
  card: HTMLDivElement;
  banterId: number;
  repulseTimeoutId: number;
  lastMoveMs: number;
  onMouseMove: () => void;
  countdownIntervalId: number | null;
  countdownEl: HTMLDivElement | null;
}

let current: OverlayHandle | null = null;

chrome.runtime.onMessage.addListener((message: unknown) => {
  if (!isShowBanterMessage(message)) return;
  if (current !== null && current.banterId === message.banterId) {
    // Same banter id, but the worker may have re-sent it because the
    // user refreshed mid-countdown — update the countdown display in
    // place rather than re-mounting (which would replay slide-in and
    // the chime).
    updateCountdown(current, message.countdownSeconds);
    return;
  }
  showOverlay(message);
});

function showOverlay(msg: ShowBanterMessage): void {
  removeCurrent();

  const widthByVariant: Record<typeof msg.overlay, string> = {
    small: "320px",
    standard: "440px",
    large: "560px",
  };

  const host = document.createElement("div");
  host.style.all = "initial";
  host.style.position = "fixed";
  host.style.right = "16px";
  host.style.bottom = "16px";
  host.style.width = widthByVariant[msg.overlay];
  host.style.zIndex = "2147483647";
  host.setAttribute("data-nihlus-overlay", "true");

  const shadow = host.attachShadow({ mode: "closed" });

  const style = document.createElement("style");
  style.textContent = OVERLAY_CSS;
  shadow.appendChild(style);

  const card = document.createElement("div");
  card.className = `nihlus-banter nihlus-banter--${msg.overlay}`;

  const header = document.createElement("div");
  header.className = "nihlus-banter__header";
  const headerLabel = document.createElement("span");
  headerLabel.textContent = "Nihlus";
  header.appendChild(headerLabel);
  const headerStars = document.createElement("span");
  headerStars.className = "nihlus-banter__stars";
  headerStars.textContent = renderHeaderStars(msg.starLevel);
  header.appendChild(headerStars);
  card.appendChild(header);

  const message = document.createElement("p");
  message.className = "nihlus-banter__message";
  message.textContent = msg.message;
  card.appendChild(message);

  let countdownEl: HTMLDivElement | null = null;
  if (msg.countdownSeconds !== null) {
    countdownEl = document.createElement("div");
    countdownEl.className = "nihlus-banter__countdown";
    countdownEl.textContent = formatCountdown(msg.countdownSeconds);
    card.appendChild(countdownEl);
  }

  const actionArea = document.createElement("div");
  actionArea.className = "nihlus-banter__action";

  const dismissBtn = document.createElement("button");
  dismissBtn.type = "button";
  dismissBtn.className = "nihlus-banter__dismiss";
  dismissBtn.textContent = "Dismiss";
  dismissBtn.addEventListener("click", () => {
    renderChips(actionArea, msg.banterId);
  });
  actionArea.appendChild(dismissBtn);
  card.appendChild(actionArea);

  shadow.appendChild(card);
  (document.body ?? document.documentElement).appendChild(host);

  const onMouseMove = (): void => {
    if (current !== null) current.lastMoveMs = Date.now();
  };
  document.addEventListener("mousemove", onMouseMove, { passive: true });

  const repulseTimeoutId = window.setTimeout(() => {
    maybeFireRepulse(msg.banterId);
  }, REPULSE_TIMEOUT_MS);

  let countdownIntervalId: number | null = null;
  if (countdownEl !== null && msg.countdownSeconds !== null) {
    countdownIntervalId = startCountdownInterval(countdownEl, msg.countdownSeconds);
  }

  current = {
    host,
    card,
    banterId: msg.banterId,
    repulseTimeoutId,
    lastMoveMs: Date.now(),
    onMouseMove,
    countdownIntervalId,
    countdownEl,
  };

  if (msg.soundEnabled) {
    playMountChime();
  }
}

function startCountdownInterval(el: HTMLDivElement, initial: number): number {
  let remaining = initial;
  return window.setInterval(() => {
    remaining = Math.max(0, remaining - 1);
    el.textContent = formatCountdown(remaining);
    if (remaining <= 0) {
      // Worker is about to act (navigate or close). Stop ticking; the
      // tab navigation will tear down the content script naturally.
      if (current !== null && current.countdownIntervalId !== null) {
        window.clearInterval(current.countdownIntervalId);
        current.countdownIntervalId = null;
      }
    }
  }, 1000);
}

function updateCountdown(handle: OverlayHandle, seconds: number | null): void {
  if (seconds === null || handle.countdownEl === null) return;
  handle.countdownEl.textContent = formatCountdown(seconds);
  if (handle.countdownIntervalId !== null) {
    window.clearInterval(handle.countdownIntervalId);
  }
  handle.countdownIntervalId = startCountdownInterval(handle.countdownEl, seconds);
}

function formatCountdown(seconds: number): string {
  if (seconds <= 0) return "Tab closing now";
  return `Closing in ${seconds}s`;
}

function renderHeaderStars(level: number): string {
  const filled = Math.max(0, Math.min(6, Math.floor(level)));
  // Use unicode block stars for a tight monospaced look. Empty slots
  // render as dimmed glyphs.
  let out = "";
  for (let i = 0; i < 6; i++) {
    out += i < filled ? "★" : "☆";
  }
  return out;
}

function renderChips(actionArea: HTMLDivElement, banterId: number): void {
  while (actionArea.firstChild !== null) {
    actionArea.removeChild(actionArea.firstChild);
  }

  const prompt = document.createElement("div");
  prompt.className = "nihlus-banter__prompt";
  prompt.textContent = "Why? Pick one:";
  actionArea.appendChild(prompt);

  const chipRow = document.createElement("div");
  chipRow.className = "nihlus-banter__chips";

  for (const reason of DISMISS_REASONS) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "nihlus-banter__chip";
    chip.textContent = reason;
    chip.dataset["reason"] = reason;
    chip.addEventListener("click", () => {
      void notifyDismiss(banterId, reason);
      removeCurrent();
    });
    chipRow.appendChild(chip);
  }

  actionArea.appendChild(chipRow);
}

function removeCurrent(): void {
  if (current === null) return;
  window.clearTimeout(current.repulseTimeoutId);
  if (current.countdownIntervalId !== null) {
    window.clearInterval(current.countdownIntervalId);
  }
  document.removeEventListener("mousemove", current.onMouseMove);
  current.host.remove();
  current = null;
}

function maybeFireRepulse(banterId: number): void {
  if (current === null || current.banterId !== banterId) return;
  const movedRecently =
    Date.now() - current.lastMoveMs < REPULSE_MOUSEMOVE_GRACE_MS;
  if (movedRecently) return;
  const card = current.card;
  card.classList.add("nihlus-banter--repulse");
  window.setTimeout(() => {
    card.classList.remove("nihlus-banter--repulse");
  }, REPULSE_ANIMATION_MS + 50);

  const out: RepulseFiredMessage = {
    type: "nihlus/repulse-fired",
    banterId,
  };
  void chrome.runtime.sendMessage(out).catch(() => {});
}

async function notifyDismiss(banterId: number, reason: DismissReason): Promise<void> {
  const message: BanterDismissedMessage = {
    type: "nihlus/banter-dismissed",
    banterId,
    reason,
  };
  try {
    await chrome.runtime.sendMessage(message);
  } catch (err) {
    console.debug("Nihlus dismiss notify failed:", err);
  }
}

function playMountChime(): void {
  try {
    const AudioCtor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext;
    if (AudioCtor === undefined) return;
    const ctx = new AudioCtor();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = 440;
    osc.connect(gain);
    gain.connect(ctx.destination);

    const now = ctx.currentTime;
    const peak = 0.12;
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(peak, now + 0.01);
    gain.gain.setValueAtTime(peak, now + 0.11);
    gain.gain.linearRampToValueAtTime(0, now + 0.15);

    osc.start(now);
    osc.stop(now + 0.16);
    osc.addEventListener("ended", () => {
      void ctx.close().catch(() => {});
    });
  } catch (err) {
    console.debug("Nihlus mount chime failed:", err);
  }
}

const OVERLAY_CSS = `
:host {
  all: initial;
}
@keyframes nihlus-slide-in {
  from { translate: 100% 0; opacity: 0; }
  to { translate: 0 0; opacity: 1; }
}
@keyframes nihlus-mount-pulse {
  0% { scale: 1; }
  50% { scale: 1.02; }
  100% { scale: 1; }
}
@keyframes nihlus-fade-in {
  from { opacity: 0; }
  to { opacity: 1; }
}
@keyframes nihlus-repulse {
  0% { scale: 1; }
  50% { scale: 1.05; }
  100% { scale: 1; }
}
.nihlus-banter {
  font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  color: #e6e6e6;
  background: #0e1116;
  border: 1px solid #2a313c;
  border-left: 4px solid #6ea8ff;
  border-radius: 8px;
  padding: 14px 16px 16px;
  box-shadow: 0 6px 24px rgba(0, 0, 0, 0.35);
  box-sizing: border-box;
  width: 100%;
  transform-origin: bottom right;
  animation:
    nihlus-slide-in 280ms ease-out,
    nihlus-mount-pulse 600ms ease-in-out 280ms 1;
}
@media (prefers-reduced-motion: reduce) {
  .nihlus-banter {
    animation: nihlus-fade-in 150ms ease-out;
  }
}
.nihlus-banter--small {
  border-left-color: #6ea8ff;
  padding: 12px 14px 14px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.3);
}
.nihlus-banter--standard {
  border-left-color: #b388ff;
  padding: 18px 21px 21px;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
}
.nihlus-banter--large {
  border-left: 4px solid #ff7a45;
  padding: 22px 26px 26px;
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.5);
}
.nihlus-banter--repulse {
  animation: nihlus-repulse 700ms ease-in-out 1;
}
@media (prefers-reduced-motion: reduce) {
  .nihlus-banter--repulse {
    animation: none;
  }
}
.nihlus-banter__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: #6ea8ff;
  margin-bottom: 8px;
}
.nihlus-banter--small .nihlus-banter__header { color: #6ea8ff; font-size: 11px; }
.nihlus-banter--standard .nihlus-banter__header { color: #b388ff; }
.nihlus-banter--large .nihlus-banter__header { color: #ff7a45; font-size: 13px; }
.nihlus-banter__stars {
  letter-spacing: 0.1em;
  font-size: 13px;
  opacity: 0.9;
}
.nihlus-banter__message {
  margin: 0 0 12px;
  font-size: 14px;
  line-height: 1.45;
  color: #f3f4f6;
}
.nihlus-banter--small .nihlus-banter__message { font-size: 13px; margin-bottom: 10px; }
.nihlus-banter--standard .nihlus-banter__message { font-size: 16px; margin-bottom: 16px; }
.nihlus-banter--large .nihlus-banter__message { font-size: 18px; margin-bottom: 18px; }
.nihlus-banter__countdown {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
  color: #ffb37a;
  margin-bottom: 12px;
  letter-spacing: 0.02em;
}
.nihlus-banter--large .nihlus-banter__countdown {
  font-size: 14px;
  color: #ff7a45;
  font-weight: 600;
}
.nihlus-banter__action {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.nihlus-banter__dismiss {
  appearance: none;
  background: transparent;
  color: #9ca3af;
  border: 1px solid #2a313c;
  border-radius: 4px;
  padding: 6px 12px;
  font-size: 12px;
  font-family: inherit;
  cursor: pointer;
  align-self: flex-start;
}
.nihlus-banter--standard .nihlus-banter__dismiss { padding: 7px 14px; font-size: 13px; }
.nihlus-banter--large .nihlus-banter__dismiss { padding: 8px 16px; font-size: 14px; }
.nihlus-banter__dismiss:hover {
  color: #f3f4f6;
  border-color: #4a5263;
}
.nihlus-banter__dismiss:focus-visible {
  outline: 2px solid #b388ff;
  outline-offset: 2px;
}
.nihlus-banter__prompt {
  font-size: 12px;
  color: #9ca3af;
  letter-spacing: 0.02em;
}
.nihlus-banter__chips {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
}
.nihlus-banter__chip {
  appearance: none;
  background: #161a21;
  color: #cbd5e1;
  border: 1px solid #2a313c;
  border-radius: 999px;
  padding: 5px 12px;
  font-size: 12px;
  font-family: inherit;
  cursor: pointer;
  text-transform: lowercase;
  letter-spacing: 0.02em;
}
.nihlus-banter__chip:hover {
  background: #1c2129;
  color: #f3f4f6;
  border-color: #4a5263;
}
.nihlus-banter__chip:focus-visible {
  outline: 2px solid #b388ff;
  outline-offset: 2px;
}
`;

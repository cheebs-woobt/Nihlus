import {
  isShowBanterMessage,
  type BanterDismissedMessage,
  type RepulseFiredMessage,
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
// Phase 5 behavior: dismiss is two-step (Dismiss button → 5-chip
// reason row → close + send reason).
//
// Phase 6 calibration:
//   - Width 440px, 4px left accent border, drop shadow.
//   - Slide-in animation (280ms) + one-time mount pulse (600ms).
//   - prefers-reduced-motion: skip slide, 150ms fade.
//   - Soft 440 Hz chime on mount (if soundEnabled per UserConfig).
//   - 45-second auto-pulse: if the overlay is still mounted and the
//     user hasn't mousemoved on the page in the last 5 seconds, play
//     a single 700ms scale 1.0 → 1.05 → 1.0 pulse and notify the
//     worker. Single fire only.

console.log("Nihlus content script active on:", window.location.href);

const REPULSE_TIMEOUT_MS = 45_000;
const REPULSE_MOUSEMOVE_GRACE_MS = 5_000;
const REPULSE_ANIMATION_MS = 700;

interface OverlayHandle {
  host: HTMLDivElement;
  card: HTMLDivElement;
  banterId: number;
  repulseTimeoutId: number;
  // Updated by the mousemove listener; read at the 45s mark. A move
  // within REPULSE_MOUSEMOVE_GRACE_MS of the deadline suppresses the
  // repulse (user is reading / interacting, not waiting it out).
  lastMoveMs: number;
  onMouseMove: () => void;
}

let current: OverlayHandle | null = null;

chrome.runtime.onMessage.addListener((message: unknown) => {
  if (!isShowBanterMessage(message)) return;
  if (current !== null && current.banterId === message.banterId) return;
  showOverlay(message.message, message.banterId, message.soundEnabled);
});

function showOverlay(text: string, banterId: number, soundEnabled: boolean): void {
  removeCurrent();

  const host = document.createElement("div");
  host.style.all = "initial";
  host.style.position = "fixed";
  host.style.right = "16px";
  host.style.bottom = "16px";
  host.style.width = "440px";
  host.style.zIndex = "2147483647";
  host.setAttribute("data-nihlus-overlay", "true");

  const shadow = host.attachShadow({ mode: "closed" });

  const style = document.createElement("style");
  style.textContent = OVERLAY_CSS;
  shadow.appendChild(style);

  const card = document.createElement("div");
  card.className = "nihlus-banter";

  const header = document.createElement("div");
  header.className = "nihlus-banter__header";
  header.textContent = "Nihlus";
  card.appendChild(header);

  const msg = document.createElement("p");
  msg.className = "nihlus-banter__message";
  msg.textContent = text;
  card.appendChild(msg);

  const actionArea = document.createElement("div");
  actionArea.className = "nihlus-banter__action";

  const dismissBtn = document.createElement("button");
  dismissBtn.type = "button";
  dismissBtn.className = "nihlus-banter__dismiss";
  dismissBtn.textContent = "Dismiss";
  dismissBtn.addEventListener("click", () => {
    renderChips(actionArea, banterId);
  });
  actionArea.appendChild(dismissBtn);

  card.appendChild(actionArea);
  shadow.appendChild(card);

  (document.body ?? document.documentElement).appendChild(host);

  // Mousemove tracking. Passive so we don't slow scrolling on the
  // host page. lastMoveMs ticks every move; the timer's check reads
  // it once.
  const onMouseMove = (): void => {
    if (current !== null) {
      current.lastMoveMs = Date.now();
    }
  };
  document.addEventListener("mousemove", onMouseMove, { passive: true });

  const repulseTimeoutId = window.setTimeout(() => {
    maybeFireRepulse(banterId);
  }, REPULSE_TIMEOUT_MS);

  current = {
    host,
    card,
    banterId,
    repulseTimeoutId,
    lastMoveMs: Date.now(),
    onMouseMove,
  };

  if (soundEnabled) {
    playMountChime();
  }
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
  document.removeEventListener("mousemove", current.onMouseMove);
  current.host.remove();
  current = null;
}

function maybeFireRepulse(banterId: number): void {
  if (current === null || current.banterId !== banterId) return;
  const movedRecently =
    Date.now() - current.lastMoveMs < REPULSE_MOUSEMOVE_GRACE_MS;
  if (movedRecently) {
    // User is interacting elsewhere on the page; skip the pulse.
    return;
  }
  const card = current.card;
  card.classList.add("nihlus-banter--repulse");
  // Remove the class after the animation completes so it can re-arm
  // if a future phase ever needs to repulse more than once.
  window.setTimeout(() => {
    card.classList.remove("nihlus-banter--repulse");
  }, REPULSE_ANIMATION_MS + 50);

  const out: RepulseFiredMessage = {
    type: "nihlus/repulse-fired",
    banterId,
  };
  void chrome.runtime.sendMessage(out).catch(() => {
    // Worker may have been torn down; the visual pulse still fired.
  });
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

// Soft 440 Hz mount chime. AudioContext creation can throw on pages
// that haven't received a user gesture yet (browser autoplay policy);
// wrapped in try/catch so a silent failure doesn't disrupt the visual
// overlay. Envelope: 10ms attack → 100ms hold → 40ms release.
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
    // Close the context shortly after the sound ends so we don't leak
    // AudioContexts across many banters.
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
  border-left: 4px solid #b388ff;
  border-radius: 8px;
  padding: 18px 21px 21px;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
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
.nihlus-banter--repulse {
  animation: nihlus-repulse 700ms ease-in-out 1;
}
@media (prefers-reduced-motion: reduce) {
  .nihlus-banter--repulse {
    animation: none;
  }
}
.nihlus-banter__header {
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: #b388ff;
  margin-bottom: 10px;
}
.nihlus-banter__message {
  margin: 0 0 16px;
  font-size: 16px;
  line-height: 1.45;
  color: #f3f4f6;
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
  padding: 7px 14px;
  font-size: 13px;
  font-family: inherit;
  cursor: pointer;
  align-self: flex-start;
}
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

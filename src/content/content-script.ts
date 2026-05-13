import {
  isShowBanterMessage,
  type BanterDismissedMessage,
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
// Phase 5: dismiss is two-step. The single "Dismiss" button is replaced
// after click by a reason chip row (break / work / stuck / tired /
// later). The chip click is the actual dismissal and carries the
// reason on the wire so the worker can log it.

console.log("Nihlus content script active on:", window.location.href);

interface OverlayHandle {
  host: HTMLDivElement;
  banterId: number;
}

let current: OverlayHandle | null = null;

chrome.runtime.onMessage.addListener((message: unknown) => {
  if (!isShowBanterMessage(message)) return;
  // Defensive: a duplicate show for the same banterId is a no-op so a
  // background re-send (e.g. SPA route flip) doesn't visually re-mount
  // and reset the user's progress through the dismiss flow.
  if (current !== null && current.banterId === message.banterId) return;
  showOverlay(message.message, message.banterId);
});

function showOverlay(text: string, banterId: number): void {
  removeCurrent();

  const host = document.createElement("div");
  host.style.all = "initial";
  host.style.position = "fixed";
  host.style.right = "16px";
  host.style.bottom = "16px";
  host.style.width = "280px";
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

  // Action area: starts in "dismiss" state (single button); flips to
  // "chips" state on first click. The chip click is the real dismissal.
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

  // Append to documentElement instead of body: body may be absent on
  // some pages mid-load, or restyled with overflow:hidden + transforms
  // that re-anchor fixed-position children. documentElement is more
  // forgiving.
  (document.body ?? document.documentElement).appendChild(host);

  current = { host, banterId };
}

function renderChips(actionArea: HTMLDivElement, banterId: number): void {
  // Empty the action area and re-render as chips.
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
  current.host.remove();
  current = null;
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

const OVERLAY_CSS = `
:host {
  all: initial;
}
.nihlus-banter {
  font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  color: #e6e6e6;
  background: #0e1116;
  border: 1px solid #2a313c;
  border-radius: 8px;
  padding: 12px 14px 14px;
  box-shadow: 0 6px 24px rgba(0, 0, 0, 0.45);
  box-sizing: border-box;
  width: 100%;
}
.nihlus-banter__header {
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: #6ea8ff;
  margin-bottom: 6px;
}
.nihlus-banter__message {
  margin: 0 0 10px;
  font-size: 13px;
  line-height: 1.4;
  color: #f3f4f6;
}
.nihlus-banter__action {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.nihlus-banter__dismiss {
  appearance: none;
  background: transparent;
  color: #9ca3af;
  border: 1px solid #2a313c;
  border-radius: 4px;
  padding: 5px 12px;
  font-size: 12px;
  font-family: inherit;
  cursor: pointer;
  align-self: flex-start;
}
.nihlus-banter__dismiss:hover {
  color: #f3f4f6;
  border-color: #4a5263;
}
.nihlus-banter__dismiss:focus-visible {
  outline: 2px solid #6ea8ff;
  outline-offset: 2px;
}
.nihlus-banter__prompt {
  font-size: 11px;
  color: #9ca3af;
  letter-spacing: 0.02em;
}
.nihlus-banter__chips {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.nihlus-banter__chip {
  appearance: none;
  background: #161a21;
  color: #cbd5e1;
  border: 1px solid #2a313c;
  border-radius: 999px;
  padding: 4px 10px;
  font-size: 11px;
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
  outline: 2px solid #6ea8ff;
  outline-offset: 2px;
}
`;

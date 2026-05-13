import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  CLAUDE_MODEL_OPTIONS,
  defaultUserConfig,
  loadConfig,
  saveConfig,
  subscribeConfig,
  type ClaudeModelId,
  type UserConfig,
} from "../lib/config.ts";
import "./popup.css";

// Save-button state. "idle" is the default. "saving" briefly while the
// chrome.storage write is in flight. "saved" for ~1.2 seconds after a
// successful save so the user sees confirmation; resets to "idle" on
// any field edit afterwards.
type SaveState = "idle" | "saving" | "saved";

function Popup(): React.ReactElement {
  const [config, setConfig] = useState<UserConfig>(defaultUserConfig);
  const [allowedText, setAllowedText] = useState<string>("");
  const [blockedText, setBlockedText] = useState<string>("");
  const [loaded, setLoaded] = useState<boolean>(false);
  const [saveState, setSaveState] = useState<SaveState>("idle");

  // Initial load. The popup is recreated every time the user clicks the
  // toolbar icon so this effect runs exactly once per popup lifetime.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const initial = await loadConfig();
      if (cancelled) return;
      setConfig(initial);
      setAllowedText(initial.allowedSites.join("\n"));
      setBlockedText(initial.blockedSites.join("\n"));
      setLoaded(true);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Stay in sync with storage changes from other surfaces (e.g. the
  // service worker writing defaults on install). Without this the popup
  // would display stale state if a user opens it right after install.
  useEffect(() => {
    const unsubscribe = subscribeConfig((next) => {
      setConfig(next);
      setAllowedText(next.allowedSites.join("\n"));
      setBlockedText(next.blockedSites.join("\n"));
    });
    return unsubscribe;
  }, []);

  const markDirty = (): void => {
    if (saveState === "saved") setSaveState("idle");
  };

  const handleToggleFocus = (): void => {
    setConfig((prev) => ({ ...prev, focusModeActive: !prev.focusModeActive }));
    markDirty();
  };

  const handleCommitmentChange = (e: React.ChangeEvent<HTMLInputElement>): void => {
    setConfig((prev) => ({ ...prev, commitmentOfTheHour: e.target.value }));
    markDirty();
  };

  const handleAllowedChange = (e: React.ChangeEvent<HTMLTextAreaElement>): void => {
    setAllowedText(e.target.value);
    markDirty();
  };

  const handleBlockedChange = (e: React.ChangeEvent<HTMLTextAreaElement>): void => {
    setBlockedText(e.target.value);
    markDirty();
  };

  const handleAiToggle = (): void => {
    setConfig((prev) => ({ ...prev, aiBanterEnabled: !prev.aiBanterEnabled }));
    markDirty();
  };

  const handleModelChange = (e: React.ChangeEvent<HTMLSelectElement>): void => {
    // The select only renders options from CLAUDE_MODEL_OPTIONS, so the
    // narrow is sound: e.target.value is always a member of the union.
    const v = e.target.value as ClaudeModelId;
    setConfig((prev) => ({ ...prev, claudeModel: v }));
    markDirty();
  };

  const handleApiKeyChange = (e: React.ChangeEvent<HTMLInputElement>): void => {
    setConfig((prev) => ({ ...prev, claudeApiKey: e.target.value }));
    markDirty();
  };

  const handleSave = async (): Promise<void> => {
    setSaveState("saving");
    const next: UserConfig = {
      ...config,
      allowedSites: parseSiteList(allowedText),
      blockedSites: parseSiteList(blockedText),
    };
    try {
      await saveConfig(next);
      // Reflect the sanitized lists back into the textareas so a user
      // who typed duplicates or blank lines sees them collapse on save.
      setConfig(next);
      setAllowedText(next.allowedSites.join("\n"));
      setBlockedText(next.blockedSites.join("\n"));
      setSaveState("saved");
      window.setTimeout(() => {
        setSaveState((cur) => (cur === "saved" ? "idle" : cur));
      }, 1200);
    } catch (err) {
      console.warn("Nihlus popup save failed:", err);
      setSaveState("idle");
    }
  };

  return (
    <div className="nihlus-popup">
      <header className="nihlus-popup__header">
        <h1 className="nihlus-popup__title">Nihlus v0.0.1</h1>
        <p className="nihlus-popup__subtitle">
          {loaded ? "Configure focus" : "Loading..."}
        </p>
      </header>

      <section className="nihlus-popup__row">
        <label className="nihlus-popup__toggle">
          <input
            type="checkbox"
            checked={config.focusModeActive}
            onChange={handleToggleFocus}
            disabled={!loaded}
          />
          <span>Focus mode</span>
        </label>
      </section>

      <section className="nihlus-popup__field">
        <label htmlFor="commitment" className="nihlus-popup__label">
          Commitment of the hour
        </label>
        <input
          id="commitment"
          type="text"
          value={config.commitmentOfTheHour}
          onChange={handleCommitmentChange}
          placeholder="e.g. finish the migration plan"
          disabled={!loaded}
        />
      </section>

      <section className="nihlus-popup__field">
        <label htmlFor="allowed" className="nihlus-popup__label">
          Allowed sites <span className="nihlus-popup__hint">(one per line)</span>
        </label>
        <textarea
          id="allowed"
          rows={4}
          value={allowedText}
          onChange={handleAllowedChange}
          placeholder={"github.com\ndocs.google.com"}
          disabled={!loaded}
        />
      </section>

      <section className="nihlus-popup__field">
        <label htmlFor="blocked" className="nihlus-popup__label">
          Blocked sites <span className="nihlus-popup__hint">(one per line)</span>
        </label>
        <textarea
          id="blocked"
          rows={4}
          value={blockedText}
          onChange={handleBlockedChange}
          placeholder={"youtube.com\nreddit.com"}
          disabled={!loaded}
        />
      </section>

      <hr className="nihlus-popup__divider" />

      <section className="nihlus-popup__row">
        <label className="nihlus-popup__toggle">
          <input
            type="checkbox"
            checked={config.aiBanterEnabled}
            onChange={handleAiToggle}
            disabled={!loaded}
          />
          <span>AI banter (Claude)</span>
        </label>
      </section>

      <section className="nihlus-popup__field">
        <label htmlFor="model" className="nihlus-popup__label">
          Model
        </label>
        <select
          id="model"
          value={config.claudeModel}
          onChange={handleModelChange}
          disabled={!loaded}
        >
          {CLAUDE_MODEL_OPTIONS.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
      </section>

      <section className="nihlus-popup__field">
        <label htmlFor="apikey" className="nihlus-popup__label">
          Anthropic API key{" "}
          <span className="nihlus-popup__hint">
            {config.aiBanterEnabled && config.claudeApiKey.length === 0
              ? "(required for AI banter)"
              : "(stored locally only)"}
          </span>
        </label>
        <input
          id="apikey"
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={config.claudeApiKey}
          onChange={handleApiKeyChange}
          placeholder="sk-ant-..."
          disabled={!loaded}
        />
      </section>

      <footer className="nihlus-popup__footer">
        <button
          type="button"
          className="nihlus-popup__save"
          onClick={() => {
            void handleSave();
          }}
          disabled={!loaded || saveState === "saving"}
        >
          {saveButtonLabel(saveState)}
        </button>
      </footer>
    </div>
  );
}

function saveButtonLabel(state: SaveState): string {
  if (state === "saving") return "Saving...";
  if (state === "saved") return "Saved";
  return "Save";
}

// Split a textarea blob into a list of normalized entries. Same shape
// as the sanitizer in config.ts but lives here too so the popup can
// preview the sanitized list without waiting on a chrome.storage round
// trip. config.ts's sanitizeSiteList re-runs server-side as a safety
// net, so any divergence collapses on read.
function parseSiteList(blob: string): string[] {
  const out: string[] = [];
  for (const line of blob.split(/\r?\n/)) {
    const cleaned = line.trim().toLowerCase();
    if (cleaned.length === 0) continue;
    if (out.includes(cleaned)) continue;
    out.push(cleaned);
  }
  return out;
}

const rootEl = document.getElementById("root");
if (rootEl === null) {
  throw new Error("Popup root element not found");
}

createRoot(rootEl).render(
  <StrictMode>
    <Popup />
  </StrictMode>,
);

# Nihlus

AI focus extension for high-functioning procrastinators. Friendly accountability for people who tend to drift, designed to adapt when someone tries to work around it. Chrome MV3 extension.

## Local development

Requirements: Node 20+ and npm 10+ (this scaffold was built and tested on Node 24 / npm 11).

```
npm install
npm run dev    # Vite dev server with crxjs HMR
npm run build  # production build into dist/
```

`npm run dev` keeps Vite running with crxjs hot-reload. `npm run build` emits a fully bundled extension under `dist/` (manifest at the root, popup HTML + JS, service worker, content script).

## Load the extension in Chrome

1. Run `npm run build` once so `dist/` exists.
2. Open `chrome://extensions/`.
3. Toggle **Developer mode** (top-right).
4. Click **Load unpacked**.
5. Select the `dist/` folder.

The extension icon will appear in the toolbar; click it to open the popup. Each subsequent `npm run build` rewrites `dist/`; hit the reload arrow on the extension card in `chrome://extensions/` after a rebuild.

For day-to-day dev iteration: `npm run dev` and rely on crxjs HMR for the popup, then reload the extension card when you change the service worker or content script (Chrome only re-reads those on extension reload).

### DevTools-blocked Chrome profiles

If the Chrome profile you're developing in has policy restrictions that disable DevTools (some managed school / work profiles ship with `DeveloperToolsAvailability` set to disallow), the console logs the scaffold emits won't be visible. Two workarounds:

- Use Microsoft Edge or Firefox with a personal profile for development. Edge accepts the same `dist/` unpacked via `edge://extensions/`; Firefox needs `about:debugging#/runtime/this-firefox` → **Load Temporary Add-on** pointed at `dist/manifest.json` (Firefox auto-translates most MV3 surfaces).
- Or use a separate non-managed Chrome user profile (`chrome://settings/manageProfile`).

## Project layout

```
manifest.json              MV3 manifest (read by @crxjs/vite-plugin at build time)
vite.config.ts             Vite + React + crxjs wiring
src/popup/                 Popup UI (React 19, TS strict)
  popup.html
  popup.tsx                inline <Popup /> component + createRoot
  popup.css
src/background/
  service-worker.ts        onInstalled + tabs.onUpdated smoke checks
src/content/
  content-script.ts        single console.log per page load
```

## Stack

- Vite 8 + `@vitejs/plugin-react` + `@crxjs/vite-plugin`
- React 19 + TypeScript (strict, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`)
- Chrome Manifest V3 (service worker as ES module)

Per Wyatt's scope, Phase 1 is scaffold-only: no AI integration, no storage usage beyond declared permissions, no UI beyond hello-world.

import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { crx } from "@crxjs/vite-plugin";
import manifest from "./manifest.json" with { type: "json" };

// crxjs wires the MV3 manifest entry points (popup.html, service worker,
// content scripts) into Vite's build graph so HMR + bundling work without
// hand-maintained rollupOptions. The popup is a standard React SPA from
// crxjs's perspective; background + content scripts are bundled as
// individual ESM entries.
export default defineConfig({
  plugins: [react(), crx({ manifest })],
});

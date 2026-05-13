import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { crx } from "@crxjs/vite-plugin";
import manifest from "./manifest.json" with { type: "json" };

// crxjs wires the MV3 manifest entry points (popup.html, service worker,
// content scripts) into Vite's build graph. Auxiliary HTML pages declared
// only in web_accessible_resources (Phase 6: the interrupt page) are not
// auto-discovered by crxjs as entries, so we add them to rollupOptions.input
// explicitly. Without this the HTML ships with its raw <script src="x.tsx">
// tag and Chrome refuses to load the page.
export default defineConfig({
  plugins: [react(), crx({ manifest })],
  build: {
    rollupOptions: {
      input: {
        interrupt: fileURLToPath(new URL("./src/interrupt/interrupt.html", import.meta.url)),
      },
    },
  },
});

import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import agents from "agents/vite";
import { defineConfig } from "vite";

// `agents()` handles the TC39 decorator transforms used by `@callable()` (Oxc
// doesn't support them yet) — required because this example uses decorators.
export default defineConfig({
  plugins: [agents(), react(), cloudflare(), tailwindcss()]
});

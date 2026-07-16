import { defineConfig } from "vite";

const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env;

export default defineConfig({
  // GitHub Pages serves this repo at /FarmGame/, not the domain root.
  base: env?.GITHUB_PAGES ? "/FarmGame/" : "/",
  // PORT lets tooling (e.g. the Claude Code preview pane) assign a free port.
  server: { port: Number(env?.PORT) || 5173 },
});

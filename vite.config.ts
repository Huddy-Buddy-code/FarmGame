import { defineConfig } from "vite";

export default defineConfig({
  // PORT lets tooling (e.g. the Claude Code preview pane) assign a free port.
  // (globalThis dance: this config runs in Node, but the app tsconfig has no node types.)
  server: { port: Number((globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env.PORT) || 5173 },
});

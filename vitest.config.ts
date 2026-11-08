import { defineConfig } from "vitest/config";

// node:sqlite is a Node 24 builtin that Vite's resolver does not know yet;
// keep every node: import external so tests load it from Node itself.
export default defineConfig({
  test: {
    server: {
      deps: {
        external: [/^node:/],
      },
    },
  },
});

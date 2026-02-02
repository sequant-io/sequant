import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Use forks instead of threads - more stable for long-running tests
    // Threads can hit RPC timeouts on tests taking >60s (semgrep: ~120s)
    pool: "forks",

    // Increase hook timeout for setup/teardown
    hookTimeout: 60000,

    // Increase teardown timeout for cleanup after long-running tests
    teardownTimeout: 10000,
  },
});

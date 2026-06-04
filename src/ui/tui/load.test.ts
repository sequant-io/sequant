import { describe, it, expect, afterEach } from "vitest";
import { loadTui } from "./load.js";

/**
 * Guards the leak fix in `load.ts`. The dangerous regression is NOT "fails to
 * load" (TypeScript catches that) — it's `loadTui()` leaving
 * `NODE_ENV=production` set after it returns, which spawned phase children
 * would then inherit (making, e.g., `npm install` skip devDependencies). These
 * tests pin the restore behavior for every prior `NODE_ENV` state.
 */
describe("loadTui", () => {
  const original = process.env.NODE_ENV;
  afterEach(() => {
    if (original === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = original;
  });

  it("returns the TUI module with renderTui", async () => {
    const mod = await loadTui();
    expect(typeof mod.renderTui).toBe("function");
  });

  it("restores an unset NODE_ENV (children must not inherit production)", async () => {
    delete process.env.NODE_ENV;
    await loadTui();
    expect("NODE_ENV" in process.env).toBe(false);
  });

  it("preserves an explicit NODE_ENV (test/development is respected)", async () => {
    process.env.NODE_ENV = "test";
    await loadTui();
    expect(process.env.NODE_ENV).toBe("test");
  });
});

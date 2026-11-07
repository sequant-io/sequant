import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  detectHookChannels,
  isHookChannelPath,
  withoutHookChannel,
} from "./hook-channels.js";

describe("hook channels (#1603)", () => {
  describe("isHookChannelPath", () => {
    it("matches the hook scripts and their registration, nothing else", () => {
      expect(isHookChannelPath(".claude/hooks/pre-tool.sh")).toBe(true);
      expect(isHookChannelPath(".claude\\hooks\\post-tool.sh")).toBe(true);
      expect(isHookChannelPath(".claude/settings.json")).toBe(true);
      expect(isHookChannelPath(".claude/settings.local.json")).toBe(false);
      expect(isHookChannelPath(".claude/skills/exec/SKILL.md")).toBe(false);
      expect(isHookChannelPath(".sequant/settings.json")).toBe(false);
    });
  });

  describe("withoutHookChannel", () => {
    const changes = [
      { path: ".claude/hooks/pre-tool.sh" },
      { path: ".claude/settings.json" },
      { path: ".claude/skills/qa/SKILL.md" },
    ];

    it("drops hook paths only when the manifest records the plugin channel", () => {
      expect(withoutHookChannel(changes, { hooks: "plugin" })).toEqual([
        { path: ".claude/skills/qa/SKILL.md" },
      ]);
      expect(withoutHookChannel(changes, {})).toEqual(changes);
      expect(withoutHookChannel(changes, null)).toEqual(changes);
    });
  });

  describe("detectHookChannels", () => {
    let cwd: string;
    let home: string;
    let pluginDir: string;

    beforeEach(() => {
      cwd = mkdtempSync(join(tmpdir(), "hook-channels-cwd-"));
      home = mkdtempSync(join(tmpdir(), "hook-channels-home-"));
      pluginDir = mkdtempSync(join(tmpdir(), "hook-channels-plugin-"));
      mkdirSync(join(cwd, ".claude"), { recursive: true });
      mkdirSync(join(home, ".claude", "plugins"), { recursive: true });
      mkdirSync(join(pluginDir, "hooks"), { recursive: true });
      writeFileSync(
        join(pluginDir, "hooks", "hooks.json"),
        JSON.stringify({
          hooks: {
            PreToolUse: [
              {
                hooks: [
                  { command: '"${CLAUDE_PLUGIN_ROOT}/hooks/pre-tool.sh"' },
                ],
              },
            ],
          },
        }),
      );
      writeFileSync(
        join(home, ".claude", "plugins", "installed_plugins.json"),
        JSON.stringify({
          version: 2,
          plugins: {
            "dev@mods": [{ scope: "user", installPath: pluginDir }],
          },
        }),
      );
    });

    afterEach(() => {
      for (const dir of [cwd, home, pluginDir]) {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("reads enabledPlugins from the project's .claude/settings.json too", () => {
      writeFileSync(
        join(cwd, ".claude", "settings.json"),
        JSON.stringify({ enabledPlugins: { "dev@mods": true } }),
      );

      const channels = detectHookChannels({ cwd, home });

      expect(channels.repo).toBeNull();
      expect(channels.plugins).toEqual([
        {
          id: "dev@mods",
          installPath: pluginDir,
          hooksJson: join(pluginDir, "hooks", "hooks.json"),
        },
      ]);
    });

    it("does not count a plugin whose hooks.json registers no pre-tool.sh", () => {
      writeFileSync(
        join(pluginDir, "hooks", "hooks.json"),
        JSON.stringify({
          hooks: { Stop: [{ hooks: [{ command: "notify.sh" }] }] },
        }),
      );
      writeFileSync(
        join(home, ".claude", "settings.json"),
        JSON.stringify({ enabledPlugins: { "dev@mods": true } }),
      );

      expect(detectHookChannels({ cwd, home }).plugins).toEqual([]);
    });

    it("returns no channels for a checkout and home with nothing in them", () => {
      rmSync(join(home, ".claude"), { recursive: true, force: true });

      expect(detectHookChannels({ cwd, home })).toEqual({
        repo: null,
        plugins: [],
      });
    });
  });
});

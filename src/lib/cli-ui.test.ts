import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  configureUI,
  getUIConfig,
  colors,
  logo,
  banner,
  box,
  successBox,
  errorBox,
  warningBox,
  headerBox,
  table,
  keyValueTable,
  statusIcon,
  printStatus,
  divider,
  sectionHeader,
  phaseProgress,
  progressBar,
  spinner,
  ui,
} from "./cli-ui.js";

describe("cli-ui", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    // Reset environment
    process.env = { ...originalEnv };
    // Reset UI config to defaults
    configureUI({
      noColor: false,
      jsonMode: false,
      verbose: false,
      isTTY: true,
      isCI: false,
      minimal: false,
    });
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe("configureUI", () => {
    it("should set configuration options", () => {
      configureUI({
        noColor: true,
        jsonMode: false,
        verbose: true,
        isTTY: false,
        isCI: true,
        minimal: false,
      });

      const config = getUIConfig();
      expect(config.noColor).toBe(true);
      expect(config.verbose).toBe(true);
      expect(config.isTTY).toBe(false);
      expect(config.isCI).toBe(true);
    });

    it("should merge partial configuration", () => {
      configureUI({ noColor: true });
      const config1 = getUIConfig();
      expect(config1.noColor).toBe(true);

      configureUI({ verbose: true });
      const config2 = getUIConfig();
      expect(config2.noColor).toBe(true); // Preserved from first call
      expect(config2.verbose).toBe(true);
    });
  });

  describe("getUIConfig", () => {
    it("should return current configuration", () => {
      const config = getUIConfig();
      expect(config).toHaveProperty("noColor");
      expect(config).toHaveProperty("jsonMode");
      expect(config).toHaveProperty("verbose");
      expect(config).toHaveProperty("isTTY");
      expect(config).toHaveProperty("isCI");
      expect(config).toHaveProperty("minimal");
    });
  });

  describe("colors", () => {
    it("should provide color functions", () => {
      expect(typeof colors.success).toBe("function");
      expect(typeof colors.error).toBe("function");
      expect(typeof colors.warning).toBe("function");
      expect(typeof colors.info).toBe("function");
      expect(typeof colors.muted).toBe("function");
    });

    it("success should return a string", () => {
      const result = colors.success("test");
      expect(typeof result).toBe("string");
      expect(result).toContain("test");
    });

    it("error should return a string", () => {
      const result = colors.error("test");
      expect(typeof result).toBe("string");
      expect(result).toContain("test");
    });

    it("warning should return a string", () => {
      const result = colors.warning("test");
      expect(typeof result).toBe("string");
      expect(result).toContain("test");
    });

    it("info should return a string", () => {
      const result = colors.info("test");
      expect(typeof result).toBe("string");
      expect(result).toContain("test");
    });

    it("muted should return a string", () => {
      const result = colors.muted("test");
      expect(typeof result).toBe("string");
      expect(result).toContain("test");
    });

    it("header should return a string", () => {
      const result = colors.header("test");
      expect(typeof result).toBe("string");
      expect(result).toContain("test");
    });
  });

  describe("logo", () => {
    it("should return ASCII logo string", () => {
      const result = logo();
      expect(typeof result).toBe("string");
      expect(result.length).toBeGreaterThan(0);
    });

    it("should contain SEQUANT text pattern", () => {
      configureUI({ noColor: true }); // Use plain ASCII
      const result = logo();
      // The logo uses block characters for ASCII art
      expect(result).toContain("██");
    });
  });

  describe("banner", () => {
    it("should return banner string with logo", () => {
      const result = banner();
      expect(typeof result).toBe("string");
      expect(result.length).toBeGreaterThan(0);
    });

    it("should return empty string in minimal mode", () => {
      configureUI({ minimal: true });
      const result = banner();
      expect(result).toBe("");
    });
  });

  describe("box", () => {
    it("should create a boxed message", () => {
      const result = box("Test content");
      expect(typeof result).toBe("string");
      expect(result).toContain("Test content");
    });

    it("should support padding option", () => {
      const result = box("Content", { padding: 2 });
      expect(typeof result).toBe("string");
      expect(result).toContain("Content");
    });

    it("should support borderColor option", () => {
      const result = box("Content", { borderColor: "green" });
      expect(typeof result).toBe("string");
      expect(result).toContain("Content");
    });
  });

  describe("successBox", () => {
    it("should create a success-styled box", () => {
      const result = successBox("Success!", "Operation completed");
      expect(typeof result).toBe("string");
      expect(result).toContain("Success!");
    });

    it("should work without message", () => {
      const result = successBox("Title only");
      expect(typeof result).toBe("string");
      expect(result).toContain("Title only");
    });
  });

  describe("errorBox", () => {
    it("should create an error-styled box", () => {
      const result = errorBox("Error!", "Something went wrong");
      expect(typeof result).toBe("string");
      expect(result).toContain("Error!");
    });

    it("should work without message", () => {
      const result = errorBox("Error title");
      expect(typeof result).toBe("string");
      expect(result).toContain("Error title");
    });
  });

  describe("warningBox", () => {
    it("should create a warning-styled box", () => {
      const result = warningBox("Warning!", "Be careful");
      expect(typeof result).toBe("string");
      expect(result).toContain("Warning!");
    });

    it("should work without message", () => {
      const result = warningBox("Warning title");
      expect(typeof result).toBe("string");
      expect(result).toContain("Warning title");
    });
  });

  describe("headerBox", () => {
    it("should create a header box", () => {
      const result = headerBox("HEADER");
      expect(typeof result).toBe("string");
      expect(result).toContain("HEADER");
    });
  });

  describe("table", () => {
    it("should create a table from data with columns", () => {
      const data = [
        ["Row 1", "Value 1"],
        ["Row 2", "Value 2"],
      ];
      const result = table(data, {
        columns: [
          { header: "Name", width: 10 },
          { header: "Value", width: 15 },
        ],
      });
      expect(typeof result).toBe("string");
      expect(result).toContain("Row 1");
      expect(result).toContain("Value 1");
      expect(result).toContain("Name");
      expect(result).toContain("Value");
    });

    it("should handle empty data with columns", () => {
      const result = table([], {
        columns: [
          { header: "Col 1", width: 10 },
          { header: "Col 2", width: 10 },
        ],
      });
      expect(typeof result).toBe("string");
    });

    it("should return empty string in jsonMode", () => {
      configureUI({ jsonMode: true });
      const result = table([["a", "b"]], {
        columns: [
          { header: "A", width: 10 },
          { header: "B", width: 10 },
        ],
      });
      expect(result).toBe("");
    });
  });

  describe("keyValueTable", () => {
    it("should create a key-value table", () => {
      const data = {
        Name: "Test",
        Version: "1.0.0",
      };
      const result = keyValueTable(data);
      expect(typeof result).toBe("string");
      expect(result).toContain("Name");
      expect(result).toContain("Test");
      expect(result).toContain("Version");
      expect(result).toContain("1.0.0");
    });

    it("should handle empty object", () => {
      const result = keyValueTable({});
      expect(typeof result).toBe("string");
    });

    it("should return empty string in jsonMode", () => {
      configureUI({ jsonMode: true });
      const result = keyValueTable({ key: "value" });
      expect(result).toBe("");
    });
  });

  describe("statusIcon", () => {
    it("should return success icon", () => {
      const result = statusIcon("success");
      expect(typeof result).toBe("string");
      expect(result.length).toBeGreaterThan(0);
    });

    it("should return error icon", () => {
      const result = statusIcon("error");
      expect(typeof result).toBe("string");
      expect(result.length).toBeGreaterThan(0);
    });

    it("should return warning icon", () => {
      const result = statusIcon("warning");
      expect(typeof result).toBe("string");
      expect(result.length).toBeGreaterThan(0);
    });

    it("should return pending icon", () => {
      const result = statusIcon("pending");
      expect(typeof result).toBe("string");
      expect(result.length).toBeGreaterThan(0);
    });

    it("should return running icon", () => {
      const result = statusIcon("running");
      expect(typeof result).toBe("string");
      expect(result.length).toBeGreaterThan(0);
    });

    it("should return text fallback when noColor", () => {
      configureUI({ noColor: true });
      const success = statusIcon("success");
      expect(success).toBe("[OK]");
      const error = statusIcon("error");
      expect(error).toBe("[FAIL]");
    });
  });

  describe("printStatus", () => {
    let consoleSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    });

    afterEach(() => {
      consoleSpy.mockRestore();
    });

    it("should print status message", () => {
      printStatus("success", "Test message");
      expect(consoleSpy).toHaveBeenCalled();
    });

    it("should print error status", () => {
      printStatus("error", "Error message");
      expect(consoleSpy).toHaveBeenCalled();
    });

    it("should print warning status", () => {
      printStatus("warning", "Warning message");
      expect(consoleSpy).toHaveBeenCalled();
    });
  });

  describe("divider", () => {
    it("should return a divider string", () => {
      const result = divider();
      expect(typeof result).toBe("string");
      expect(result.length).toBeGreaterThan(0);
    });

    it("should support custom width", () => {
      const result = divider(20);
      // The result might have ANSI codes, but underlying char count should be 20
      expect(result.replace(/\x1b\[[0-9;]*m/g, "").length).toBe(20);
    });

    it("should return empty string in jsonMode", () => {
      configureUI({ jsonMode: true });
      const result = divider();
      expect(result).toBe("");
    });
  });

  describe("sectionHeader", () => {
    it("should create a section header", () => {
      const result = sectionHeader("Section Title");
      expect(typeof result).toBe("string");
      expect(result).toContain("Section Title");
    });
  });

  describe("phaseProgress", () => {
    it("should show phase progress icons and labels", () => {
      const phases = [
        { name: "spec", status: "completed" as const },
        { name: "exec", status: "running" as const },
        { name: "qa", status: "pending" as const },
      ];
      const result = phaseProgress(phases);
      expect(typeof result).toBe("string");
      // Shows first letter labels
      expect(result).toContain("S");
      expect(result).toContain("E");
      expect(result).toContain("Q");
    });

    it("should handle empty phases", () => {
      const result = phaseProgress([]);
      expect(typeof result).toBe("string");
    });

    it("should show failure status icon", () => {
      configureUI({ noColor: true });
      const phases = [{ name: "exec", status: "failure" as const }];
      const result = phaseProgress(phases);
      expect(result).toContain("[X]");
    });

    it("should show skipped status", () => {
      configureUI({ noColor: true });
      const phases = [{ name: "test", status: "skipped" as const }];
      const result = phaseProgress(phases);
      expect(result).toContain("[-]");
    });

    it("should return empty string in jsonMode", () => {
      configureUI({ jsonMode: true });
      const result = phaseProgress([
        { name: "spec", status: "pending" as const },
      ]);
      expect(result).toBe("");
    });
  });

  describe("progressBar", () => {
    it("should create a progress bar at 0%", () => {
      const result = progressBar(0, 100);
      expect(typeof result).toBe("string");
    });

    it("should create a progress bar at 50%", () => {
      const result = progressBar(50, 100);
      expect(typeof result).toBe("string");
    });

    it("should create a progress bar at 100%", () => {
      const result = progressBar(100, 100);
      expect(typeof result).toBe("string");
    });

    it("should support custom width", () => {
      const result = progressBar(50, 100, 30);
      expect(typeof result).toBe("string");
    });

    it("should handle edge case of 0 total", () => {
      const result = progressBar(0, 0);
      expect(typeof result).toBe("string");
    });

    it("should return empty string in jsonMode", () => {
      configureUI({ jsonMode: true });
      const result = progressBar(50, 100);
      expect(result).toBe("");
    });
  });

  describe("spinner", () => {
    it("should return spinner interface", () => {
      const spin = spinner("Loading...");
      expect(spin).toHaveProperty("start");
      expect(spin).toHaveProperty("stop");
      expect(spin).toHaveProperty("succeed");
      expect(spin).toHaveProperty("fail");
      expect(spin).toHaveProperty("warn");
      expect(spin).toHaveProperty("text");
      expect(typeof spin.start).toBe("function");
      expect(typeof spin.stop).toBe("function");
      expect(typeof spin.succeed).toBe("function");
      expect(typeof spin.fail).toBe("function");
    });

    it("should start and stop without error", () => {
      const spin = spinner("Test");
      spin.start();
      spin.stop();
    });

    it("should support succeed", () => {
      const spin = spinner("Test");
      spin.start();
      spin.succeed("Done!");
    });

    it("should support fail", () => {
      const spin = spinner("Test");
      spin.start();
      spin.fail("Failed!");
    });

    it("should support warn", () => {
      const spin = spinner("Test");
      spin.start();
      spin.warn("Warning!");
    });

    it("should allow setting text", () => {
      const spin = spinner("Initial");
      spin.text = "Updated";
      // Just verify no error is thrown
    });

    it("should use static fallback in non-TTY mode", () => {
      configureUI({ isTTY: false });
      const spin = spinner("Non-TTY spinner");
      expect(spin).toHaveProperty("start");
      spin.start();
      spin.succeed("Done");
    });

    it("should use static fallback in verbose mode", () => {
      configureUI({ verbose: true });
      const spin = spinner("Verbose spinner");
      expect(spin).toHaveProperty("start");
      spin.start();
      spin.succeed("Done");
    });

    it("should use static fallback in CI mode", () => {
      configureUI({ isCI: true });
      const spin = spinner("CI spinner");
      expect(spin).toHaveProperty("start");
      spin.start();
      spin.succeed("Done");
    });
  });

  describe("ui namespace", () => {
    it("should expose all utilities", () => {
      expect(ui.logo).toBe(logo);
      expect(ui.banner).toBe(banner);
      expect(ui.box).toBe(box);
      expect(ui.successBox).toBe(successBox);
      expect(ui.errorBox).toBe(errorBox);
      expect(ui.warningBox).toBe(warningBox);
      expect(ui.headerBox).toBe(headerBox);
      expect(ui.table).toBe(table);
      expect(ui.keyValueTable).toBe(keyValueTable);
      expect(ui.statusIcon).toBe(statusIcon);
      expect(ui.printStatus).toBe(printStatus);
      expect(ui.divider).toBe(divider);
      expect(ui.sectionHeader).toBe(sectionHeader);
      expect(ui.phaseProgress).toBe(phaseProgress);
      expect(ui.progressBar).toBe(progressBar);
      expect(ui.spinner).toBe(spinner);
    });
  });

  describe("graceful degradation", () => {
    it("should work with noColor mode", () => {
      configureUI({ noColor: true });

      // All functions should still work
      expect(typeof logo()).toBe("string");
      expect(typeof box("test")).toBe("string");
      expect(typeof statusIcon("success")).toBe("string");
    });

    it("should work with jsonMode", () => {
      configureUI({ jsonMode: true });

      // Banner should be suppressed
      expect(banner()).toBe("");

      // Other functions should still work
      expect(typeof box("test")).toBe("string");
    });

    it("should work with minimal mode", () => {
      configureUI({ minimal: true });

      // Banner and logo should be suppressed
      expect(banner()).toBe("");
      expect(logo()).toBe("");

      // Essential functions should still work
      expect(typeof box("test")).toBe("string");
    });
  });

  describe("Windows compatibility", () => {
    it("should provide ASCII fallback characters", () => {
      // The status icons should work regardless of platform
      const success = statusIcon("success");
      const error = statusIcon("error");
      const warning = statusIcon("warning");

      expect(success.length).toBeGreaterThan(0);
      expect(error.length).toBeGreaterThan(0);
      expect(warning.length).toBeGreaterThan(0);
    });
  });

  describe("edge cases", () => {
    it("should handle empty strings", () => {
      expect(typeof box("")).toBe("string");
      expect(typeof sectionHeader("")).toBe("string");
    });

    it("should handle very long strings", () => {
      const longString = "A".repeat(1000);
      expect(typeof box(longString)).toBe("string");
      expect(typeof sectionHeader(longString)).toBe("string");
    });

    it("should handle special characters", () => {
      const special = "Test <script>alert('xss')</script> & more";
      expect(typeof box(special)).toBe("string");
      expect(box(special)).toContain("Test");
    });

    it("should handle unicode characters", () => {
      const unicode = "Test 🚀 émoji ñ 中文";
      expect(typeof box(unicode)).toBe("string");
    });

    it("should handle newlines in content", () => {
      const multiline = "Line 1\nLine 2\nLine 3";
      expect(typeof box(multiline)).toBe("string");
    });
  });
});

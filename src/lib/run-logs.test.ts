import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { resolveLogDir, listLogFiles, parseLogFile } from "./run-logs.js";
import { formatDuration } from "./cli-ui/format.js";
import { LOG_PATHS } from "./workflow/run-log-schema.js";

describe("run-logs", () => {
  let tmp: string;
  let cwd: string;
  let home: string | undefined;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "run-logs-"));
    cwd = process.cwd();
    home = process.env.HOME;
    process.env.HOME = tmp;
    const proj = path.join(tmp, "proj");
    fs.mkdirSync(proj);
    process.chdir(proj);
  });

  afterEach(() => {
    process.chdir(cwd);
    if (home === undefined) delete process.env.HOME;
    else process.env.HOME = home;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("expands ~ in a custom path", () => {
    expect(resolveLogDir("~/x")).toBe(path.join(os.homedir(), "x"));
  });

  it("prefers the project log dir when it exists", () => {
    fs.mkdirSync(path.join(tmp, "proj", LOG_PATHS.project), {
      recursive: true,
    });
    fs.mkdirSync(LOG_PATHS.user.replace("~", os.homedir()), {
      recursive: true,
    });
    expect(resolveLogDir()).toBe(LOG_PATHS.project);
  });

  it("falls back to the global log dir when the project one is absent", () => {
    const user = LOG_PATHS.user.replace("~", os.homedir());
    fs.mkdirSync(user, { recursive: true });
    expect(resolveLogDir()).toBe(user);
  });

  it("defaults to the project path when neither exists", () => {
    expect(resolveLogDir()).toBe(LOG_PATHS.project);
  });

  it("lists run logs newest first and ignores other files", () => {
    fs.writeFileSync(path.join(tmp, "run-a.json"), "{}");
    fs.writeFileSync(path.join(tmp, "run-b.json"), "{}");
    fs.writeFileSync(path.join(tmp, "other.json"), "{}");
    expect(listLogFiles(tmp)).toEqual(["run-b.json", "run-a.json"]);
    expect(listLogFiles(path.join(tmp, "missing"))).toEqual([]);
  });

  it("returns null from parseLogFile for unreadable or invalid JSON", () => {
    const bad = path.join(tmp, "run-bad.json");
    fs.writeFileSync(bad, "not json");
    expect(parseLogFile(bad)).toBeNull();
    expect(parseLogFile(path.join(tmp, "nope.json"))).toBeNull();
  });

  it("formats durations", () => {
    expect(formatDuration(65)).toBe("1m 5s");
    expect(formatDuration(5)).toBe("5.0s");
  });
});

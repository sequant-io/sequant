/**
 * #1387 AC-1: the local-install warning is suppressed when the project's
 * package.json declares `sequant`, and kept for an undeclared (stray) install.
 */

import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  isDeclaredDependency,
  isLocalNodeModulesInstall,
  shouldWarnLocalInstall,
} from "./version-check.js";

let root: string;
let installPath: string;

function writeProject(pkg: string | object | null): void {
  if (pkg !== null) {
    fs.writeFileSync(
      path.join(root, "package.json"),
      typeof pkg === "string" ? pkg : JSON.stringify(pkg),
    );
  }
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "sequant-1387-"));
  installPath = path.join(
    root,
    "node_modules",
    "sequant",
    "dist",
    "src",
    "lib",
  );
  fs.mkdirSync(installPath, { recursive: true });
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("shouldWarnLocalInstall (#1387)", () => {
  describe("AC-1: declared dependency suppresses the local-install warning", () => {
    it.each(["dependencies", "devDependencies", "optionalDependencies"])(
      "does not warn when package.json lists sequant in %s",
      (field) => {
        writeProject({ name: "app", [field]: { sequant: "^2.19.0" } });
        expect(isLocalNodeModulesInstall(installPath)).toBe(true);
        expect(shouldWarnLocalInstall(installPath)).toBe(false);
      },
    );

    describe("error handling", () => {
      it("still warns when sequant is not declared (stray install)", () => {
        writeProject({ name: "app", dependencies: { chalk: "^5.0.0" } });
        expect(shouldWarnLocalInstall(installPath)).toBe(true);
      });

      it.each([
        ["invalid JSON", "{not json"],
        ["no package.json", null],
        ["non-object dependencies", { dependencies: "sequant" }],
      ])("warns when package.json is unusable (%s)", (_label, pkg) => {
        writeProject(pkg);
        expect(shouldWarnLocalInstall(installPath)).toBe(true);
      });
    });

    describe("assumptions", () => {
      it("derives the project root from the install path, not process.cwd()", () => {
        writeProject({ devDependencies: { sequant: "*" } });
        // process.cwd() is the repo checkout, whose package.json is sequant itself.
        expect(process.cwd()).not.toBe(root);
        expect(isDeclaredDependency(installPath)).toBe(true);
      });

      it("uses the nearest node_modules/sequant for nested installs", () => {
        const inner = path.join(root, "node_modules", "foo");
        const nested = path.join(inner, "node_modules", "sequant", "dist");
        fs.mkdirSync(nested, { recursive: true });
        writeProject({ dependencies: { sequant: "*" } });
        fs.writeFileSync(path.join(inner, "package.json"), "{}");
        expect(isDeclaredDependency(nested)).toBe(false);
      });

      it("leaves isLocalNodeModulesInstall and global/npx exclusions unchanged", () => {
        expect(isLocalNodeModulesInstall(installPath)).toBe(true);
        expect(
          shouldWarnLocalInstall("/usr/local/lib/node_modules/sequant"),
        ).toBe(false);
        expect(
          shouldWarnLocalInstall("/home/u/.npm/_npx/abc/node_modules/sequant"),
        ).toBe(false);
      });
    });
  });
});

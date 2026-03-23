/**
 * Version utility - reads version from package.json
 */

import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
import { readFileSync } from "fs";

export function getVersion(): string {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  let dir = __dirname;
  while (dir !== dirname(dir)) {
    const candidate = resolve(dir, "package.json");
    try {
      const content = readFileSync(candidate, "utf-8");
      const pkg = JSON.parse(content);
      if (pkg.name === "sequant") {
        return pkg.version;
      }
    } catch {
      // Not found, continue searching
    }
    dir = dirname(dir);
  }
  return "0.0.0";
}

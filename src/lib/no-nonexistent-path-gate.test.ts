/**
 * Gate test (#1141 AC-3): no test hardcodes the absolute "assumed absent"
 * fixture path. Run as root, a code path that mkdirs it makes it real and
 * poisons every other test that assumes it is missing. Absent paths come from
 * `path.join(os.tmpdir(), <unique>)` and are never created.
 *
 * The banned literal is assembled at runtime so this file doesn't trip its own
 * grep.
 */

import { describe, it, expect } from "vitest";
import { execFileSync } from "child_process";

const BANNED = ["/non", "existent/path"].join("");

describe("#1141: hardcoded absent-path fixture gate", () => {
  it("1141: no file under src hardcodes the absent-path literal", () => {
    let output = "";
    try {
      output = execFileSync("grep", ["-rnF", BANNED, "src"], {
        encoding: "utf-8",
      });
    } catch (err) {
      // grep exits 1 when there are no matches — that's the passing case.
      const execErr = err as { status?: number };
      if (execErr.status !== 1) throw err;
    }
    expect(output.trim().split("\n").filter(Boolean)).toEqual([]);
  });
});

import { describe, it, expect } from "vitest";
import {
  scanWriteSites,
  checkWriteSites,
  formatWriteSiteFailures,
} from "./ownership-gate.js";

// Gate side (b) scan (#1106). Synthetic sources only — the real writers are
// exercised by the "ownership policy covers" block in templates.test.ts.
const gate = (
  source: string,
  registry: Record<string, string>,
  declared: string[] = [],
) => {
  const sites = scanWriteSites(source, "x.ts");
  return {
    sites,
    message: formatWriteSiteFailures(
      checkWriteSites(sites, registry, declared, []),
    ),
  };
};

describe("ownership gate write-site scan", () => {
  it("1106 AC-1: registers a non-awaited writeFile( and names its destination", () => {
    const source = `
      function save(d) {
        void writeFile(join(d, "x.json"), "{}");
        writeFile(join(d, "y.json"), "{}");
        fs.writeFile(join(d, "z.json"), "{}");
      }
    `;
    const { sites, message } = gate(source, {});
    expect(sites.map((s) => s.destExpr)).toEqual([
      'join(d, "x.json")',
      'join(d, "y.json")',
      'join(d, "z.json")',
    ]);
    expect(message).toContain('join(d, "x.json")');
    expect(message).toContain('join(d, "y.json")');
  });

  it("1106 AC-2: a second write in a registered function to a new destination fails", () => {
    const source = `
      async function save(d) {
        await writeFile(join(d, "a"), "1");
        await writeFile(join(d, "b"), "2");
      }
    `;
    const { message } = gate(source, { 'x.ts#save#join(d, "a")': ".a" }, [
      ".a",
    ]);
    expect(message).toContain('join(d, "b")');
    expect(message).not.toContain('join(d, "a")');
  });

  it("1106 AC-3: an arrow-const writer is attributed to itself, not the previous function", () => {
    const source = `
      function first() {
        return 1;
      }
      const second = async (d: string): Promise<void> => {
        await writeFile(join(d, "s"), "1");
      };
      const third = async function () {
        await writeFile(join(d, "t"), "1");
      };
    `;
    const sites = scanWriteSites(source, "x.ts");
    expect(sites.map((s) => s.site)).toEqual(["x.ts#second", "x.ts#third"]);
  });

  it("1106: a closure that closes does not leak its name onto the next write", () => {
    const source = `
      async function outer(d) {
        const inner = () => { return 1; };
        inner();
        await writeFile(join(d, "o"), "1");
      }
      await writeFile("top", "1");
    `;
    expect(scanWriteSites(source, "x.ts").map((s) => s.site)).toEqual([
      "x.ts#outer",
      "x.ts#(top-level)",
    ]);
  });

  it("1106: strings, comments and regex literals do not hide or invent sites", () => {
    const source = `
      function f(d) {
        const re = /["'{]/;
        // await writeFile("commented", "x")
        const s = "writeFile(\\"quoted\\")";
        await writeFile(
          join(d, \`\${name}.md\`),
          body,
        );
      }
    `;
    const sites = scanWriteSites(source, "x.ts");
    expect(sites).toHaveLength(1);
    expect(sites[0].destExpr).toBe("join(d, `${name}.md`)");
    expect(sites[0].site).toBe("x.ts#f");
  });

  it("1106: a registered, declared destination passes clean", () => {
    const source = `async function save(d) { await writeFile(p, "1"); }`;
    expect(gate(source, { "x.ts#save#p": ".p" }, [".p"]).message).toBe("");
  });
});

/**
 * CI gate for the public trust contract (issue #980).
 *
 * `SECURITY.md` and `docs/THREAT-MODEL.md` are prose with no runtime twin, so
 * these tests gate the properties that make them *checkable* rather than
 * merely present:
 *
 * - AC-1: `SECURITY.md` carries the three required sections and a live contact
 *   line, and `README.md` links it.
 * - AC-2: every defense row names an enforcer that resolves on disk — path,
 *   `§` skill anchor, settings key, or symbol — and classifies itself as
 *   exactly `deterministic` or `model-dependent`.
 * - AC-3: the OWASP Agentic Top 10 (2026) mapping covers ASI01–ASI10 with no
 *   empty disposition and cites its source URL.
 * - AC-4: the guard count in the doc is recomputed from `pre-tool.sh`, not
 *   typed. A prose count drifts silently; this one cannot.
 * - AC-5: neither document makes an immunity claim.
 * - AC-6: `README.md` gains exactly one line linking both documents.
 *
 * What this gate does NOT prove: that a `Class` cell is *correct*. Nothing in
 * CI can check that a control labelled `deterministic` actually holds when the
 * model is compromised — a wrong label is a public misstatement that passes
 * every assertion here. Re-deriving each Class from its enforcer is a review
 * obligation (#980 Derived AC-8), not a test.
 *
 * Every assertion is scoped to the HTML-delimited span or `##` section it
 * means to check. Matching the whole file is the #830 defect: there, a
 * fixture's own explanatory header satisfied an assertion about the fixture
 * payload, so deleting the payload left the suite green.
 */

import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";

const SECURITY_MD = "SECURITY.md";
const THREAT_MODEL_MD = "docs/THREAT-MODEL.md";
const README_MD = "README.md";
const PRE_TOOL_HOOK = "templates/hooks/pre-tool.sh";
const SETTINGS_TS = "src/lib/settings.ts";

const read = (rel: string): string =>
  fs.readFileSync(path.join(process.cwd(), rel), "utf-8");
const exists = (rel: string): boolean =>
  fs.existsSync(path.join(process.cwd(), rel));

/**
 * Body of a `## <heading>` section, from the heading to the next `^## ` (or
 * EOF). Returns "" when the heading is absent, so a missing section fails as
 * an empty span rather than throwing.
 */
function sectionSpan(md: string, heading: string): string {
  const lines = md.split("\n");
  const start = lines.findIndex(
    (l) => l.trim().toLowerCase() === `## ${heading}`.toLowerCase(),
  );
  if (start === -1) return "";
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^## /.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(start + 1, end).join("\n");
}

/** Raw text between two HTML comment delimiters, "" if either is absent. */
function delimitedSpan(md: string, begin: string, end: string): string {
  const b = md.indexOf(begin);
  const e = md.indexOf(end);
  if (b === -1 || e === -1 || e < b) return "";
  return md.slice(b + begin.length, e);
}

/**
 * Data rows of the markdown table inside a delimited span: pipe rows minus the
 * separator row and minus the header row, each split into trimmed cells.
 */
function delimitedRows(md: string, begin: string, end: string): string[][] {
  const pipeRows = delimitedSpan(md, begin, end)
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("|"))
    .filter((l) => !/^\|[\s:|-]+\|$/.test(l));
  return pipeRows.slice(1).map((row) =>
    row
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      .map((c) => c.trim()),
  );
}

/** Every `` `backticked` `` token in a cell. */
const backticked = (cell: string): string[] =>
  [...cell.matchAll(/`([^`]+)`/g)].map((m) => m[1]);

/** A token is path-ish when it has a slash and only path-safe characters. */
const isPathish = (token: string): boolean =>
  /^[\w.@-]+(?:\/[\w.@-]+)+$/.test(token);

const DEFENSES = ["<!-- defenses:begin -->", "<!-- defenses:end -->"] as const;
const OWASP = ["<!-- owasp:begin -->", "<!-- owasp:end -->"] as const;
const SURFACES = ["<!-- surfaces:begin -->", "<!-- surfaces:end -->"] as const;

describe("AC-1: SECURITY.md sections, contact, and README link", () => {
  it("exists at the repository root", () => {
    expect(exists(SECURITY_MD)).toBe(true);
  });

  it.each([
    "Reporting a vulnerability",
    "Response expectations",
    "Supported versions",
  ])("has a non-empty `## %s` section", (heading) => {
    expect(
      sectionSpan(read(SECURITY_MD), heading).trim().length,
    ).toBeGreaterThan(0);
  });

  it("names a non-empty contact channel inside the reporting section", () => {
    const span = sectionSpan(read(SECURITY_MD), "Reporting a vulnerability");
    // Scoped to the marker so an unrelated URL elsewhere in the section
    // cannot satisfy this — the contact line is the thing being gated.
    const contact = delimitedSpan(
      span,
      "<!-- security-contact -->",
      "<!-- /security-contact -->",
    ).trim();
    expect(contact.length).toBeGreaterThan(0);
    expect(contact).toMatch(/https?:\/\/\S+|[\w.+-]+@[\w-]+\.[\w.]+/);
  });

  it("lists supported versions as a table", () => {
    const span = sectionSpan(read(SECURITY_MD), "Supported versions");
    const rows = span
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.startsWith("|") && !/^\|[\s:|-]+\|$/.test(l));
    // Header + at least one version row.
    expect(rows.length).toBeGreaterThanOrEqual(2);
  });

  it("is linked from README.md", () => {
    expect(read(README_MD)).toContain(SECURITY_MD);
  });
});

describe("AC-2: threat model surfaces and citation-resolving defenses table", () => {
  it("exists at docs/THREAT-MODEL.md", () => {
    expect(exists(THREAT_MODEL_MD)).toBe(true);
  });

  it.each([
    ["issue bodies", /issue bod(y|ies)/i],
    ["issue and PR comments", /comment/i],
    ["repository file contents", /file contents|repo(sitory)? files?/i],
    ["tool output", /tool output/i],
    ["dependencies", /dependenc(y|ies)/i],
  ])("names the %s untrusted-input surface", (_label, pattern) => {
    const span = delimitedSpan(read(THREAT_MODEL_MD), SURFACES[0], SURFACES[1]);
    expect(span).toMatch(pattern);
  });

  it("has a defenses table with the required columns", () => {
    const md = read(THREAT_MODEL_MD);
    const header = delimitedSpan(md, DEFENSES[0], DEFENSES[1])
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.startsWith("|"));
    expect(header).toBeDefined();
    expect(
      header!
        .replace(/^\|/, "")
        .replace(/\|$/, "")
        .split("|")
        .map((c) => c.trim()),
    ).toEqual(["Defense", "Enforcer", "Class", "Residual risk"]);
  });

  it("has at least one defense row", () => {
    expect(
      delimitedRows(read(THREAT_MODEL_MD), DEFENSES[0], DEFENSES[1]).length,
    ).toBeGreaterThan(0);
  });

  it("cites at least one on-disk path in every Enforcer cell", () => {
    for (const row of delimitedRows(
      read(THREAT_MODEL_MD),
      DEFENSES[0],
      DEFENSES[1],
    )) {
      const [defense, enforcer] = row;
      const paths = backticked(enforcer).filter(isPathish);
      expect(paths.length, `no path cited for "${defense}"`).toBeGreaterThan(0);
      for (const p of paths) {
        expect(exists(p), `"${defense}" cites missing path ${p}`).toBe(true);
      }
    }
  });

  it("resolves every `§` skill anchor to a heading in the cited SKILL.md", () => {
    let anchorsChecked = 0;
    for (const row of delimitedRows(
      read(THREAT_MODEL_MD),
      DEFENSES[0],
      DEFENSES[1],
    )) {
      const [defense, enforcer] = row;
      const anchors = [...enforcer.matchAll(/§([0-9]+[a-z]?)/g)].map(
        (m) => m[1],
      );
      if (anchors.length === 0) continue;
      const skill = backticked(enforcer)
        .filter(isPathish)
        .find((p) => p.endsWith("SKILL.md"));
      expect(skill, `"${defense}" uses § but cites no SKILL.md`).toBeDefined();
      const content = read(skill!);
      for (const anchor of anchors) {
        anchorsChecked++;
        expect(
          new RegExp(`^#+\\s*${anchor}\\.`, "m").test(content),
          `"${defense}": ${skill} has no heading for §${anchor}`,
        ).toBe(true);
      }
    }
    // A regex that silently matched nothing would pass the loop vacuously.
    expect(anchorsChecked).toBeGreaterThan(0);
  });

  it("resolves every cited settings key in src/lib/settings.ts", () => {
    const settings = read(SETTINGS_TS);
    let keysChecked = 0;
    for (const row of delimitedRows(
      read(THREAT_MODEL_MD),
      DEFENSES[0],
      DEFENSES[1],
    )) {
      const [defense, enforcer] = row;
      for (const m of enforcer.matchAll(/\bkey\s+`([^`]+)`/g)) {
        keysChecked++;
        const leaf = m[1].split(".").pop()!;
        expect(
          settings.includes(leaf),
          `"${defense}" cites settings key ${m[1]}, absent from ${SETTINGS_TS}`,
        ).toBe(true);
      }
    }
    expect(keysChecked).toBeGreaterThan(0);
  });

  it("resolves every non-path citation verbatim in one of the row's files", () => {
    // Derived AC-9: symbols and guard messages are stable anchors where a
    // `:LINE` reference would rot. They only count as anchors if they resolve.
    for (const row of delimitedRows(
      read(THREAT_MODEL_MD),
      DEFENSES[0],
      DEFENSES[1],
    )) {
      const [defense, enforcer] = row;
      const tokens = backticked(enforcer);
      const paths = tokens.filter(isPathish);
      const sources = paths.map((p) => read(p));
      for (const token of tokens.filter((t) => !isPathish(t))) {
        expect(
          sources.some((src) => src.includes(token)),
          `"${defense}" cites \`${token}\`, absent from ${paths.join(", ")}`,
        ).toBe(true);
      }
    }
  });

  it("classifies every defense as exactly deterministic or model-dependent", () => {
    for (const row of delimitedRows(
      read(THREAT_MODEL_MD),
      DEFENSES[0],
      DEFENSES[1],
    )) {
      const [defense, , cls] = row;
      expect(
        cls.replace(/[`*]/g, "").trim(),
        `unclassifiable Class cell for "${defense}"`,
      ).toMatch(/^(deterministic|model-dependent)$/);
    }
  });

  it("states a residual risk for every defense", () => {
    for (const row of delimitedRows(
      read(THREAT_MODEL_MD),
      DEFENSES[0],
      DEFENSES[1],
    )) {
      expect(
        row[3]?.trim().length,
        `empty residual risk for "${row[0]}"`,
      ).toBeGreaterThan(0);
    }
  });

  it("follows the table with a non-empty `## Residual risks` section", () => {
    const md = read(THREAT_MODEL_MD);
    expect(sectionSpan(md, "Residual risks").trim().length).toBeGreaterThan(0);
    expect(md.indexOf("## Residual risks")).toBeGreaterThan(
      md.indexOf(DEFENSES[1]),
    );
  });
});

describe("AC-3: OWASP Agentic Top 10 (2026) mapping", () => {
  const OWASP_IDS = Array.from(
    { length: 10 },
    (_, i) => `ASI${String(i + 1).padStart(2, "0")}`,
  );

  it("cites the OWASP source URL above the table", () => {
    const md = read(THREAT_MODEL_MD);
    const urlIndex = md.indexOf(
      "https://genai.owasp.org/resource/owasp-top-10-for-agentic-applications-for-2026/",
    );
    expect(urlIndex).toBeGreaterThan(-1);
    expect(urlIndex).toBeLessThan(md.indexOf(OWASP[0]));
  });

  it("has exactly 10 data rows", () => {
    expect(
      delimitedRows(read(THREAT_MODEL_MD), OWASP[0], OWASP[1]).length,
    ).toBe(10);
  });

  it("covers ASI01 through ASI10, each exactly once", () => {
    const ids = delimitedRows(read(THREAT_MODEL_MD), OWASP[0], OWASP[1]).map(
      (row) => (row[0].match(/ASI\d{2}/) ?? [""])[0],
    );
    expect(ids.sort()).toEqual(OWASP_IDS);
  });

  it("gives every category a non-empty disposition", () => {
    for (const row of delimitedRows(
      read(THREAT_MODEL_MD),
      OWASP[0],
      OWASP[1],
    )) {
      expect(
        row[1]?.trim().length,
        `empty disposition for "${row[0]}"`,
      ).toBeGreaterThan(0);
    }
  });

  it("marks every unmitigated category with the owning layer", () => {
    for (const row of delimitedRows(
      read(THREAT_MODEL_MD),
      OWASP[0],
      OWASP[1],
    )) {
      const disposition = row[1];
      if (!/out of scope/i.test(disposition)) continue;
      // "out of scope" alone names no owner; the AC requires whose layer.
      expect(
        disposition,
        `"${row[0]}" is out of scope but names no owner`,
      ).toMatch(/out of scope\s+—\s+\S+/i);
    }
  });

  it("resolves every path cited in a disposition", () => {
    for (const row of delimitedRows(
      read(THREAT_MODEL_MD),
      OWASP[0],
      OWASP[1],
    )) {
      for (const p of backticked(row[1]).filter(isPathish)) {
        expect(exists(p), `"${row[0]}" cites missing path ${p}`).toBe(true);
      }
    }
  });
});

describe("AC-4: the guard count is computed, not typed", () => {
  /**
   * JS equivalent of the AC's shell pipeline:
   *   grep -o 'HOOK_BLOCKED: [A-Za-z][^"]*' <hook> | sort -u | wc -l
   * `[^"\n]` rather than `[^"]` because grep is line-oriented — without the
   * newline exclusion the JS match would run past the end of the line.
   */
  const distinctGuards = (): number =>
    new Set(read(PRE_TOOL_HOOK).match(/HOOK_BLOCKED: [A-Za-z][^"\n]*/g) ?? [])
      .size;

  it("computes a plausible number of guards from the hook source", () => {
    // Floor: a broken regex returning 0 must not silently agree with a doc
    // that also says 0.
    expect(distinctGuards()).toBeGreaterThan(10);
  });

  it("matches the number in the doc's <!-- guards:count --> slot", () => {
    const slot = read(THREAT_MODEL_MD).match(/<!-- guards:count -->\s*(\d+)/);
    expect(slot, "no <!-- guards:count --> slot in the threat model").not.toBe(
      null,
    );
    expect(Number(slot![1])).toBe(distinctGuards());
  });
});

describe("AC-5: no immunity claims", () => {
  // The first five are the AC's closed list; the rest are #980 Derived AC-10,
  // which widens it to the synonyms that would otherwise pass.
  const BANNED = [
    "injection-proof",
    "prevents prompt injection",
    "immune",
    "cannot be jailbroken",
    "guaranteed",
    "bulletproof",
    "unbreakable",
    "eliminates prompt injection",
    "100% safe",
  ];

  it.each([SECURITY_MD, THREAT_MODEL_MD])(
    "%s makes no immunity claim",
    (doc) => {
      const lower = read(doc).toLowerCase();
      const found = BANNED.filter((phrase) => lower.includes(phrase));
      expect(
        found,
        `${doc} contains immunity claim(s): ${found.join(", ")}`,
      ).toEqual([]);
    },
  );
});

describe("AC-6: README links both documents on exactly one line", () => {
  const matchingLines = (needle: string): string[] =>
    read(README_MD)
      .split("\n")
      .filter((l) => l.includes(needle));

  it.each([SECURITY_MD, "THREAT-MODEL.md"])(
    "README.md has exactly one line containing %s",
    (needle) => {
      expect(matchingLines(needle).length).toBe(1);
    },
  );

  it("links both documents from the same single line", () => {
    expect(matchingLines(SECURITY_MD)).toEqual(
      matchingLines("THREAT-MODEL.md"),
    );
  });
});

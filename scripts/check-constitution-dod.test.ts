/**
 * Tests for the constitution DoD generator and drift check.
 *
 * Gate tests (AC-1 drift check, AC-2 spec cross-link, AC-6 docs coverage)
 * use the real files as the passing fixture and targeted mutations as the
 * failing fixture — no synthetic fixtures that can silently satisfy the wrong
 * thing (see CLAUDE.md gate-test scoping rule and #830).
 *
 * Related: #943
 */
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

import {
  generateDodTable,
  parseStep4Branches,
  PROJECT_ROOT,
  resolveQaSkillPath,
} from "./generate-constitution-dod.js";
import { DEFAULT_SETTINGS } from "../src/lib/settings.js";
import {
  extractDodSection,
  BEGIN_MARKER,
  END_MARKER,
} from "./check-constitution-dod.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const QA_SKILL_PATH = resolveQaSkillPath(PROJECT_ROOT);
const CONSTITUTION_PATH = join(
  PROJECT_ROOT,
  "templates",
  "memory",
  "constitution.md",
);
const SPEC_SKILL_PATHS = [
  join(PROJECT_ROOT, ".claude", "skills", "spec", "SKILL.md"),
  join(PROJECT_ROOT, "templates", "skills", "spec", "SKILL.md"),
  join(PROJECT_ROOT, "skills", "spec", "SKILL.md"),
];
const README_PATH = join(PROJECT_ROOT, "README.md");
const MARKETPLACE_SCRIPT_PATH = join(
  PROJECT_ROOT,
  "scripts",
  "prepare-marketplace.ts",
);
const CUSTOMIZATION_GUIDE_PATH = join(
  PROJECT_ROOT,
  "docs",
  "guides",
  "customization.md",
);

/** Phrase the spec cross-link must contain — scoped to the AC Quality Check step. */
const SPEC_CROSSLINK_PHRASE = "constitution's §2 AC Authoring Standard";

/** Phrases the docs must contain to describe the constitution as agent contract. */
const AGENT_CONTRACT_PHRASES = ["agent contract", "Definition of Done"];

// ---------------------------------------------------------------------------
// Generator unit tests
// ---------------------------------------------------------------------------

describe("generateDodTable", () => {
  it("produces a non-empty table from the real qa skill", () => {
    const content = readFileSync(QA_SKILL_PATH, "utf-8");
    const table = generateDodTable(content);

    expect(table).toContain("| Gate | Trigger | Verdict impact |");
    expect(table).toContain("AC_NOT_MET");
    expect(table).toContain("AC_MET_BUT_NOT_A_PLUS");
  });

  it("throws when the algorithm marker is absent", () => {
    expect(() => generateDodTable("# No algorithm here\n")).toThrow(
      /Algorithm marker not found/,
    );
  });

  it("throws when no step-4 branches are found", () => {
    // Algorithm marker present but step-4 block is empty
    const content =
      "Verdict Determination Algorithm (REQUIRED):\n\n```text\n1. Count\n```\n";
    expect(() => generateDodTable(content)).toThrow(/No step-4 branches found/);
  });
});

describe("parseStep4Branches", () => {
  it("extracts at least 7 AC_NOT_MET branches from the real qa skill", () => {
    const content = readFileSync(QA_SKILL_PATH, "utf-8");
    // Re-extract the algorithm text (same path as generateDodTable)
    const markerIdx = content.indexOf(
      "Verdict Determination Algorithm (REQUIRED):",
    );
    const afterMarker = content.slice(markerIdx);
    const fenceOpen = afterMarker.indexOf("```");
    const newlineAfterOpen = afterMarker.indexOf("\n", fenceOpen);
    const fenceClose = afterMarker.indexOf("```", fenceOpen + 3);
    const algorithmText = afterMarker.slice(newlineAfterOpen + 1, fenceClose);

    const branches = parseStep4Branches(algorithmText);
    const blocking = branches.filter((b) => b.verdict === "AC_NOT_MET");

    expect(blocking.length).toBeGreaterThanOrEqual(7);
  });
});

describe("extractDodSection", () => {
  it("returns null when begin marker is absent", () => {
    expect(extractDodSection("no markers here")).toBeNull();
  });

  it("returns null when end marker is absent", () => {
    expect(extractDodSection(`${BEGIN_MARKER}\nsome content`)).toBeNull();
  });

  it("returns the content between the markers", () => {
    const content = `before\n${BEGIN_MARKER}\nthe table\n${END_MARKER}\nafter`;
    expect(extractDodSection(content)).toBe("the table");
  });
});

// ---------------------------------------------------------------------------
// AC-1: drift check gate test (mutation-verified in PR body)
// ---------------------------------------------------------------------------

describe("AC-1: DoD table matches §7 gates", () => {
  // Scoped to the <!-- BEGIN:DOD-GATES --> ... <!-- END:DOD-GATES --> region.
  // Assertion: the generated table equals the committed region content.
  // Mutation: delete one row from the region → this test fails.
  it("constitution DoD region matches what the generator produces from qa/SKILL.md", () => {
    const qaContent = readFileSync(QA_SKILL_PATH, "utf-8");
    const constitutionContent = readFileSync(CONSTITUTION_PATH, "utf-8");

    const committed = extractDodSection(constitutionContent);
    expect(
      committed,
      "DoD markers not found in templates/memory/constitution.md",
    ).not.toBeNull();

    const generated = generateDodTable(qaContent);

    expect(committed!.trim(), "DoD table drifted from §7 gates").toBe(
      generated.trim(),
    );
  });
});

// ---------------------------------------------------------------------------
// AC-2: spec cross-link gate test (mutation-verified in PR body)
// ---------------------------------------------------------------------------

describe("AC-2: spec skill cross-references the constitution AC standard", () => {
  // Scoped to the AC Quality Check step of each spec SKILL.md copy.
  // Assertion: each copy contains the cross-link phrase near the AC lint table.
  // Mutation: delete the cross-link line → the matching test fails.
  for (const skillPath of SPEC_SKILL_PATHS) {
    const label = skillPath.replace(PROJECT_ROOT + "/", "");

    it(`${label} contains the constitution AC-standard cross-link`, () => {
      const content = readFileSync(skillPath, "utf-8");

      // Scope assertion to the AC Quality Check step region.
      // Find the AC Quality Check section and scan forward to the next step.
      const sectionStart = content.indexOf("2. **AC Quality Check**");
      expect(
        sectionStart,
        `AC Quality Check step not found in ${label}`,
      ).toBeGreaterThan(-1);

      const nextStep = content.indexOf("\n3. **", sectionStart);
      const region =
        nextStep === -1
          ? content.slice(sectionStart)
          : content.slice(sectionStart, nextStep);

      expect(
        region,
        `${label}: cross-link to constitution AC standard not found in AC Quality Check step`,
      ).toContain(SPEC_CROSSLINK_PHRASE);
    });
  }
});

// ---------------------------------------------------------------------------
// AC-6: docs coverage gate tests
// ---------------------------------------------------------------------------

describe("AC-6: docs describe the constitution as the agent contract", () => {
  function assertContainsAll(
    content: string,
    phrases: string[],
    location: string,
  ): void {
    for (const phrase of phrases) {
      expect(
        content,
        `${location}: missing required phrase "${phrase}"`,
      ).toContain(phrase);
    }
  }

  it("README.md describes the constitution as the agent contract", () => {
    const content = readFileSync(README_PATH, "utf-8");
    assertContainsAll(content, AGENT_CONTRACT_PHRASES, "README.md");
    expect(content).toContain("constitution");
  });

  it("marketplace prepare-marketplace.ts README_CONTENT describes the constitution", () => {
    const content = readFileSync(MARKETPLACE_SCRIPT_PATH, "utf-8");
    // Scope to the README_CONTENT constant region
    const start = content.indexOf("const README_CONTENT");
    expect(start, "README_CONTENT constant not found").toBeGreaterThan(-1);
    const region = content.slice(start);

    assertContainsAll(region, AGENT_CONTRACT_PHRASES, "README_CONTENT");
    expect(region).toContain("constitution");
  });

  it("docs/guides/customization.md describes the constitution as the agent contract", () => {
    const content = readFileSync(CUSTOMIZATION_GUIDE_PATH, "utf-8");
    assertContainsAll(
      content,
      AGENT_CONTRACT_PHRASES,
      "docs/guides/customization.md",
    );
    expect(content).toContain("constitution");
  });
});

describe("AC-3: cited enforcers in §3–§4 resolve to real mechanisms", () => {
  // The QA finding behind this gate: the template shipped citing
  // `settings.riskPaths` (no such key) and `ready.maxIterations` (real key is
  // `run.maxIterations`). A contract that cites nonexistent enforcers is
  // exactly the "unenforced aspirational statement" AC-3 forbids, so every
  // backticked settings key and hook path in the Boundaries/Budgets region
  // must resolve. Scoped to §3–§4 per the gate-test scoping rule.
  const CONSTITUTION_FILES = [
    "templates/memory/constitution.md",
    "memory/constitution.md",
  ];

  function boundariesAndBudgetsRegion(relPath: string): string {
    const content = readFileSync(join(PROJECT_ROOT, relPath), "utf-8");
    const start = content.indexOf("## 3. Boundaries");
    const end = content.indexOf("## 5.");
    expect(start, `${relPath}: §3 header missing`).toBeGreaterThan(-1);
    expect(end, `${relPath}: §5 header missing`).toBeGreaterThan(start);
    return content.slice(start, end);
  }

  for (const relPath of CONSTITUTION_FILES) {
    it(`${relPath}: every cited settings key resolves in DEFAULT_SETTINGS`, () => {
      const region = boundariesAndBudgetsRegion(relPath);
      const keys = [
        ...region.matchAll(
          /`((?:run|ready|agents|scopeAssessment)\.[A-Za-z0-9.]+)`/g,
        ),
      ].map((m) => m[1]);
      expect(keys.length, "no settings keys cited — region regressed").toBeGreaterThan(0);
      for (const key of keys) {
        let node: unknown = DEFAULT_SETTINGS;
        for (const part of key.split(".")) {
          expect(
            typeof node === "object" && node !== null && part in node,
            `cited settings key \`${key}\` does not resolve (stopped at \`${part}\`)`,
          ).toBe(true);
          node = (node as Record<string, unknown>)[part];
        }
      }
    });

    it(`${relPath}: every cited hook/script path exists`, () => {
      const region = boundariesAndBudgetsRegion(relPath);
      const paths = [
        ...region.matchAll(/`((?:templates|scripts)\/[\w/.-]+\.(?:sh|ts))`/g),
      ].map((m) => m[1]);
      expect(paths.length, "no hook/script paths cited — region regressed").toBeGreaterThan(0);
      for (const p of paths) {
        expect(
          existsSync(join(PROJECT_ROOT, p)),
          `cited enforcer path \`${p}\` does not exist`,
        ).toBe(true);
      }
    });
  }
});

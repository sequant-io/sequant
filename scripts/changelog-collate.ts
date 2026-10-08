/**
 * Collate changelog fragments (`changelog.d/<issue>-<slug>.md`) into a version
 * section of CHANGELOG.md (#1351).
 *
 * Fragment: first line `kind: Added|Changed|Fixed|Removed|Security`, then a
 * blank line is optional, and the rest is the entry text (without a leading
 * "- "). Each PR adds its own file, so two PRs never touch the same lines.
 *
 * Usage:
 *   npx tsx scripts/changelog-collate.ts <version> [--date YYYY-MM-DD] [--check]
 *
 * `--check` validates the fragments and writes nothing. Any malformed fragment
 * exits non-zero before a file is written or deleted.
 */
import {
  existsSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { join } from "path";
import { fileURLToPath } from "url";

export const KINDS = ["Added", "Changed", "Fixed", "Removed", "Security"];
const FILENAME = /^(\d+)-[a-z0-9][a-z0-9-]*\.md$/;

export interface Fragment {
  file: string;
  issue: number;
  kind: string;
  body: string;
}

/** Parse one fragment; throws an Error naming the file on any malformation. */
export function parseFragment(file: string, content: string): Fragment {
  const m = FILENAME.exec(file);
  if (!m) {
    throw new Error(`${file}: name must be <issue>-<slug>.md (lowercase)`);
  }
  const [first, ...rest] = content.replace(/\r\n/g, "\n").split("\n");
  const k = /^kind:\s*(\S+)\s*$/.exec(first);
  if (!k) throw new Error(`${file}: first line must be "kind: <Kind>"`);
  if (!KINDS.includes(k[1])) {
    throw new Error(
      `${file}: unknown kind "${k[1]}" (allowed: ${KINDS.join(", ")})`,
    );
  }
  const body = rest.join("\n").trim();
  if (!body) throw new Error(`${file}: empty entry text`);
  return { file, issue: Number(m[1]), kind: k[1], body };
}

/** Read and validate every fragment; all errors are reported together. */
export function readFragments(dir: string): Fragment[] {
  if (!existsSync(dir)) return [];
  const out: Fragment[] = [];
  const errors: string[] = [];
  for (const f of readdirSync(dir).sort()) {
    if (!f.endsWith(".md") || f.toLowerCase() === "readme.md") continue;
    try {
      out.push(parseFragment(f, readFileSync(join(dir, f), "utf-8")));
    } catch (e) {
      errors.push((e as Error).message);
    }
  }
  if (errors.length) throw new Error(errors.join("\n"));
  return out.sort((a, b) => a.issue - b.issue || a.file.localeCompare(b.file));
}

/**
 * Split the `[Unreleased]` block into leftover bullets per kind (rollover).
 * Throws on any line it cannot place: a bullet before the first `### Kind`
 * heading, or text that is neither a heading, a bullet nor a bullet's
 * continuation. Dropping it would delete an entry from the changelog.
 */
export function unreleasedBullets(block: string): Map<string, string[]> {
  const by = new Map<string, string[]>();
  const stray: string[] = [];
  let kind = "";
  let inBullet = false;
  for (const line of block.split("\n")) {
    const h = /^### (.+)$/.exec(line);
    if (h) {
      kind = h[1].trim();
      inBullet = false;
    } else if (/^- /.test(line) && kind) {
      inBullet = true;
      by.set(kind, [...(by.get(kind) ?? []), line.slice(2)]);
    } else if (inBullet && /^\s+\S/.test(line)) {
      const arr = by.get(kind)!;
      arr[arr.length - 1] += "\n" + line;
    } else if (line.trim() !== "") {
      stray.push(line);
    }
  }
  if (stray.length) {
    throw new Error(
      "CHANGELOG.md [Unreleased] has lines collate cannot place (a bullet " +
        "needs a ### Kind heading above it; move them into fragments):\n" +
        stray.map((l) => `  ${l}`).join("\n"),
    );
  }
  return by;
}

/** Render a version section from bullets grouped by kind. */
export function renderSection(
  version: string,
  date: string,
  byKind: Map<string, string[]>,
): string {
  const kinds = [
    ...KINDS.filter((k) => byKind.has(k)),
    ...[...byKind.keys()].filter((k) => !KINDS.includes(k)),
  ];
  const parts = [`## [${version}] - ${date}`];
  for (const k of kinds) {
    parts.push(
      `### ${k}\n\n${byKind
        .get(k)!
        .map((b) => `- ${b}`)
        .join("\n")}`,
    );
  }
  return parts.join("\n\n") + "\n";
}

/**
 * Collate fragments into CHANGELOG.md under a new version heading and delete
 * them. Bullets still sitting in `## [Unreleased]` (PRs opened before the
 * switch) are carried into the section so none is lost. Throws, writing and
 * deleting nothing, if any fragment is malformed.
 */
export function collate(
  root: string,
  version: string,
  date: string,
  opts: { check?: boolean } = {},
): { section: string; count: number } {
  const dir = join(root, "changelog.d");
  const fragments = readFragments(dir);
  const path = join(root, "CHANGELOG.md");
  const log = readFileSync(path, "utf-8");
  const m = /^## \[Unreleased\][^\n]*\n/m.exec(log);
  if (!m) throw new Error("CHANGELOG.md has no ## [Unreleased] heading");
  const start = m.index + m[0].length;
  const next = log.slice(start).search(/^## \[/m);
  const end = next === -1 ? log.length : start + next;

  const byKind = unreleasedBullets(log.slice(start, end));
  for (const f of fragments) {
    byKind.set(f.kind, [...(byKind.get(f.kind) ?? []), f.body]);
  }
  const count = [...byKind.values()].reduce((n, a) => n + a.length, 0);
  if (count === 0) throw new Error("no fragments and no [Unreleased] entries");
  const section = renderSection(version, date, byKind);
  if (opts.check) return { section, count };

  const updated =
    log.slice(0, m.index) +
    "## [Unreleased]\n\n" +
    section +
    "\n" +
    log.slice(end);
  writeFileSync(path, updated);
  for (const f of fragments) unlinkSync(join(dir, f.file));
  return { section, count };
}

function main(argv: string[]): number {
  const version = argv.find((a) => /^\d+\.\d+\.\d+/.test(a));
  const di = argv.indexOf("--date");
  const date = di !== -1 ? argv[di + 1] : new Date().toISOString().slice(0, 10);
  if (!version) {
    console.error(
      "usage: changelog-collate.ts <version> [--date YYYY-MM-DD] [--check]",
    );
    return 2;
  }
  try {
    const r = collate(process.cwd(), version, date, {
      check: argv.includes("--check"),
    });
    console.log(
      `${argv.includes("--check") ? "OK" : "Collated"}: ${r.count} entries for ${version}`,
    );
    return 0;
  } catch (e) {
    console.error((e as Error).message);
    return 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}

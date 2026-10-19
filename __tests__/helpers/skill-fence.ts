/**
 * Extract runnable text from a skill so a test runs the skill's own command,
 * not a hand-copied snippet that can drift from it (#1512, the #1290 pattern).
 *
 * Reads `.claude/skills/<skill>/SKILL.md` only; byte parity of the other two
 * mirrors is `lint:skill-sync`'s job. Every extractor throws when its anchor
 * is missing or ambiguous, so a renamed heading or a deleted fence fails the
 * test loudly instead of turning it vacuous.
 *
 * The extractors never spawn anything: the test file runs the skill's
 * command, so it stays visible where the assertion is. The only spawn here is
 * `git` inside the `makeDiffRepo` fixture builder.
 */

import { execFileSync } from "child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";

export const REPO_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../..",
);

const CLI_PATH = join(REPO_ROOT, "dist/bin/cli.js");

interface Fence {
  lang: string;
  body: string;
}

interface Scope {
  /** Heading text the section starts with, e.g. `"### 6e. Behavior-Rule"`. */
  section?: string;
  /** Name of a `<!-- BEGIN: name -->` / `<!-- END: name -->` region. */
  region?: string;
}

function skillText(skill: string): string {
  const file = join(REPO_ROOT, ".claude/skills", skill, "SKILL.md");
  if (!existsSync(file)) throw new Error(`skill not found: ${file}`);
  return readFileSync(file, "utf-8");
}

const FENCE_OPEN = /^(\s*)(`{3,}|~{3,})\s*([\w-]*)/;

/** Line indexes that sit inside a fenced block (fence lines included). */
function fencedLines(lines: string[]): Set<number> {
  const inside = new Set<number>();
  let close: string | null = null;
  lines.forEach((line, i) => {
    if (close) {
      inside.add(i);
      if (line.trim().startsWith(close)) close = null;
      return;
    }
    const open = FENCE_OPEN.exec(line);
    if (open) {
      inside.add(i);
      close = open[2];
    }
  });
  return inside;
}

/**
 * The part of the skill a test means to check: a heading's section (up to the
 * next heading of the same or a higher level, outside fences), a delimited
 * region, or the whole file.
 */
export function skillSection(skill: string, scope: Scope = {}): string {
  const text = skillText(skill);
  if (scope.region) {
    const begin = text.indexOf(`<!-- BEGIN: ${scope.region}`);
    const end = text.indexOf(`<!-- END: ${scope.region}`);
    if (begin === -1 || end <= begin) {
      throw new Error(`${skill}: region "${scope.region}" not found`);
    }
    return text.slice(begin, end);
  }
  if (!scope.section) return text;

  const lines = text.split("\n");
  const fenced = fencedLines(lines);
  const starts = lines
    .map((line, i) =>
      !fenced.has(i) && line.startsWith(scope.section!) ? i : -1,
    )
    .filter((i) => i !== -1);
  if (starts.length !== 1) {
    throw new Error(
      `${skill}: expected one heading starting "${scope.section}", found ${starts.length}`,
    );
  }
  const start = starts[0];
  const level = /^#+/.exec(lines[start])?.[0].length ?? 0;
  if (level === 0)
    throw new Error(`${skill}: "${scope.section}" is not a heading`);
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const hashes = /^(#+) /.exec(lines[i]);
    if (!fenced.has(i) && hashes && hashes[1].length <= level) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
}

function fences(text: string): Fence[] {
  const out: Fence[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const open = FENCE_OPEN.exec(lines[i]);
    if (!open) continue;
    const [, indent, marker, lang] = open;
    const body: string[] = [];
    for (i++; i < lines.length && !lines[i].trim().startsWith(marker); i++) {
      body.push(
        lines[i].startsWith(indent) ? lines[i].slice(indent.length) : lines[i],
      );
    }
    out.push({ lang, body: body.join("\n") + "\n" });
  }
  return out;
}

/** Every shell fence in scope (```bash or ```sh) whose body matches `contains`. */
export function skillFences(
  skill: string,
  scope: Scope & { contains?: string | RegExp } = {},
): string[] {
  const { contains } = scope;
  return fences(skillSection(skill, scope))
    .filter((f) => f.lang === "bash" || f.lang === "sh")
    .map((f) => f.body)
    .filter((body) =>
      contains === undefined
        ? true
        : typeof contains === "string"
          ? body.includes(contains)
          : contains.test(body),
    );
}

/** The one shell fence in scope that matches `contains`; throws on 0 or 2+. */
export function skillFence(
  skill: string,
  scope: Scope & { contains: string | RegExp },
): string {
  const hits = skillFences(skill, scope);
  if (hits.length !== 1) {
    throw new Error(
      `${skill}: expected one shell fence matching ${String(scope.contains)}, found ${hits.length}`,
    );
  }
  return hits[0];
}

/**
 * Substitute the skill's `<placeholder>` tokens. Throws when a placeholder is
 * absent, so a renamed one fails here rather than running with the literal.
 */
export function fill(script: string, values: Record<string, string>): string {
  let out = script;
  for (const [token, value] of Object.entries(values)) {
    if (!out.includes(token))
      throw new Error(`placeholder ${token} not in:\n${script}`);
    out = out.split(token).join(value);
  }
  return out;
}

/**
 * The one rewrite a test may make: `npx sequant` runs the built CLI of this
 * checkout, as `locks-cli.integration.test.ts` does. Throws without a build.
 */
export function withBuiltCli(script: string): string {
  if (!existsSync(CLI_PATH)) {
    throw new Error(
      `dist/bin/cli.js not found at ${CLI_PATH}. Run 'npm run build' first.`,
    );
  }
  if (!script.includes("npx sequant ")) {
    throw new Error(`no \`npx sequant\` call in:\n${script}`);
  }
  return script.split("npx sequant ").join(`node "${CLI_PATH}" `);
}

/**
 * The environment a skill command sees outside an orchestrated run: every
 * `SEQUANT_*` variable removed (a phase agent's own would leak in, #1086),
 * this checkout's `node_modules/.bin` first on PATH so `npx tsx` resolves
 * locally, then `extra`.
 */
export function skillEnv(
  extra: Record<string, string> = {},
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith("SEQUANT_")) env[key] = value;
  }
  env.PATH = `${join(REPO_ROOT, "node_modules/.bin")}:${process.env.PATH ?? ""}`;
  return { ...env, ...extra };
}

function git(cwd: string, ...args: string[]): void {
  execFileSync(
    "git",
    [
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@t",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    { cwd, stdio: "ignore" },
  );
}

/**
 * A temp repo where `git diff origin/main...HEAD --name-only` lists exactly
 * `changed`. `base` files are committed on `origin/main` first.
 */
export function makeDiffRepo(
  changed: Record<string, string>,
  base: Record<string, string> = {},
): string {
  const dir = mkdtempSync(join(tmpdir(), "sequant-skill-fence-"));
  const write = (files: Record<string, string>) => {
    for (const [rel, body] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, rel)), { recursive: true });
      writeFileSync(join(dir, rel), body);
    }
  };
  git(dir, "init", "-q");
  write(base);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "--allow-empty", "-m", "base");
  git(dir, "update-ref", "refs/remotes/origin/main", "HEAD");
  write(changed);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "--allow-empty", "-m", "change");
  return dir;
}

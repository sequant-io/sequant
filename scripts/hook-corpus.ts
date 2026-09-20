/**
 * Golden corpus for `pre-tool.sh` (#1094).
 *
 * `__tests__/fixtures/hook-corpus.jsonl` holds one line per Bash command the
 * hook has been asked to judge, with the verdict it gives today. The replay
 * core here is shared by the snapshot test (`__tests__/hook-corpus.integration.test.ts`)
 * and by `--diff`, so the verdicts CI checks and the verdicts a reviewer reads
 * cannot drift apart.
 *
 *   npx tsx scripts/hook-corpus.ts --diff <ref>
 *   npx tsx scripts/hook-corpus.ts --harvest [--transcripts <dir>] [--hook-log <file>]
 *
 * Replays run against a pinned git state (see `ReplayState`) because verdicts
 * for commit guards depend on what is staged.
 */
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, "..");
export const CORPUS_PATH = join(
  REPO_ROOT,
  "__tests__",
  "fixtures",
  "hook-corpus.jsonl",
);

/** Longest command kept. Truncating would change the verdict, so drop instead. */
export const MAX_COMMAND_LENGTH = 2000;

/**
 * `staged`: repo with one staged file (default; what commit guards see mid-work).
 * `clean`: empty repo, nothing staged.
 * `dirty`: one untracked file, nothing staged (what `git reset --hard` guards on).
 */
export type ReplayState = "staged" | "clean" | "dirty";

export interface CorpusCase {
  command: string;
  tool: "Bash";
  exit: number;
  block: string | null;
  source: string;
  state: ReplayState;
}

export interface Verdict {
  exit: number;
  block: string | null;
}

// ---------------------------------------------------------------------------
// Serialization — the ACs grep `"source": "#1064"`, so JSON.stringify's compact
// separators are not usable for the whole line.
// ---------------------------------------------------------------------------

export function serializeCase(c: CorpusCase): string {
  const parts = [
    `"command": ${JSON.stringify(c.command)}`,
    `"tool": ${JSON.stringify(c.tool)}`,
    `"exit": ${JSON.stringify(c.exit)}`,
    `"block": ${JSON.stringify(c.block)}`,
    `"source": ${JSON.stringify(c.source)}`,
  ];
  if (c.state !== "staged") parts.push(`"state": ${JSON.stringify(c.state)}`);
  return `{ ${parts.join(", ")} }`;
}

export function parseCorpus(text: string): CorpusCase[] {
  return text
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l, i) => {
      const raw = JSON.parse(l) as Partial<CorpusCase>;
      if (typeof raw.command !== "string" || typeof raw.exit !== "number") {
        throw new Error(`hook-corpus line ${i + 1}: missing command/exit`);
      }
      return {
        command: raw.command,
        tool: "Bash",
        exit: raw.exit,
        block: raw.block ?? null,
        source: raw.source ?? "manual",
        state: raw.state === "clean" || raw.state === "dirty" ? raw.state : "staged",
      };
    });
}

export function loadCorpus(path: string = CORPUS_PATH): CorpusCase[] {
  return existsSync(path) ? parseCorpus(readFileSync(path, "utf8")) : [];
}

export function writeCorpus(
  cases: CorpusCase[],
  path: string = CORPUS_PATH,
): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, cases.map(serializeCase).join("\n") + "\n");
}

export function caseKey(c: Pick<CorpusCase, "command" | "state">): string {
  return `${c.state}\u0000${c.command}`;
}

// ---------------------------------------------------------------------------
// Redaction — the repository is public, so every harvested command passes here
// before it is written.
// ---------------------------------------------------------------------------

const REDACTED = "<redacted>";

const REDACTION_RULES: Array<[RegExp, string]> = [
  // Header forms keep the header name and drop the value (and the scheme).
  [
    /(Authorization:\s*)(?:Bearer|Basic|token)?\s*[^\s"'\\]+/gi,
    `$1${REDACTED}`,
  ],
  [
    /(X-[A-Za-z-]*(?:Token|Key|Secret)[A-Za-z-]*:\s*)[^\s"'\\]+/gi,
    `$1${REDACTED}`,
  ],
  // Provider token shapes.
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, REDACTED],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, REDACTED],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, REDACTED],
  [/\bsk-[A-Za-z0-9_-]{20,}/g, REDACTED],
  [/\bsk_(?:live|test)_[A-Za-z0-9]{16,}/g, REDACTED],
  [/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, REDACTED],
  [/\bAIza[A-Za-z0-9_-]{30,}/g, REDACTED],
  [/\bnpm_[A-Za-z0-9]{30,}/g, REDACTED],
  [
    /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
    REDACTED,
  ],
  // KEY=value assignments and flags that name a secret.
  [
    /\b([A-Za-z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|PRIVATE_?KEY)[A-Za-z0-9_]*=)(?!<redacted>)[^\s"';&|)]+/gi,
    `$1${REDACTED}`,
  ],
  [/(--(?:token|password|api-key|secret)[= ])[^\s"']+/gi, `$1${REDACTED}`],
  [/(Bearer\s+)[A-Za-z0-9._~+/=-]{16,}/g, `$1${REDACTED}`],
  // Personal data: emails, and the maintainer's home directory (a PUBLIC repo).
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, REDACTED],
  [/\/(?:Users|home)\/[A-Za-z0-9._-]+/g, "/Users/user"],
];

export function redactCommand(command: string): string {
  let out = command;
  for (const [re, replacement] of REDACTION_RULES)
    out = out.replace(re, replacement);
  // The current user's name, if it appears outside a /Users path.
  const user = homedir().split("/").pop();
  if (user && user.length > 3) out = out.split(user).join("user");
  return out;
}

// ---------------------------------------------------------------------------
// Replay
// ---------------------------------------------------------------------------

export interface ReplayEnv {
  repos: Record<ReplayState, string>;
  home: string;
  logHome: string;
  cleanup(): void;
}

function git(cwd: string, ...args: string[]): void {
  spawnSync(
    "git",
    [
      "-c",
      "commit.gpgsign=false",
      "-c",
      "user.email=corpus@example.com",
      "-c",
      "user.name=corpus",
      ...args,
    ],
    { cwd },
  );
}

/** Build the two pinned git states plus an isolated HOME and log sink. */
export function createReplayEnv(): ReplayEnv {
  const base = mkdtempSync(join(tmpdir(), "hook-corpus-"));
  const home = join(base, "home");
  const logHome = join(base, "log");
  mkdirSync(home);
  mkdirSync(logHome);
  const repos = {} as Record<ReplayState, string>;
  for (const state of ["staged", "clean", "dirty"] as const) {
    const repo = join(base, state);
    mkdirSync(repo);
    git(repo, "init", "-q");
    git(repo, "config", "user.email", "corpus@example.com");
    git(repo, "config", "user.name", "corpus");
    git(repo, "config", "commit.gpgsign", "false");
    if (state !== "clean") writeFileSync(join(repo, "f.txt"), "hello\n");
    if (state === "staged") git(repo, "add", "f.txt");
    repos[state] = repo;
  }
  return {
    repos,
    home,
    logHome,
    cleanup: () => rmSync(base, { recursive: true, force: true }),
  };
}

/** Env with every orchestrator/worktree var removed, like the hook suite's cleanEnv. */
function replayProcessEnv(env: ReplayEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(out)) {
    if (key.startsWith("SEQUANT_")) delete out[key];
  }
  delete out.CLAUDE_HOOKS_DISABLED;
  delete out.CLAUDE_PROJECT_DIR;
  out.HOME = env.home;
  out.CLAUDE_PLUGIN_DATA = env.logHome;
  return out;
}

export function extractBlockReason(
  stderr: string,
  env?: ReplayEnv,
): string | null {
  const line = stderr.split("\n").find((l) => l.includes("HOOK_BLOCKED:"));
  if (!line) return null;
  let reason = line
    .slice(line.indexOf("HOOK_BLOCKED:") + "HOOK_BLOCKED:".length)
    .trim();
  if (env) reason = reason.split(dirname(env.repos.staged)).join("<tmp>");
  return reason;
}

/** Run one command through one hook copy and return its verdict. */
export function replayCase(
  hookPath: string,
  c: Pick<CorpusCase, "command" | "state" | "tool">,
  env: ReplayEnv,
): Verdict {
  const payload = JSON.stringify({
    tool_name: c.tool,
    tool_input: { command: c.command },
  });
  const result = spawnSync("bash", [hookPath], {
    input: payload,
    cwd: env.repos[c.state],
    env: replayProcessEnv(env),
    encoding: "utf8",
    timeout: 20_000,
  });
  return {
    exit: result.status ?? -1,
    block: extractBlockReason(result.stderr ?? "", env),
  };
}

// ---------------------------------------------------------------------------
// Diff
// ---------------------------------------------------------------------------

export interface VerdictChange {
  command: string;
  state: ReplayState;
  source: string;
  before: Verdict;
  after: Verdict;
}

export function diffVerdicts(
  cases: CorpusCase[],
  beforeHook: string,
  afterHook: string,
  env: ReplayEnv,
): VerdictChange[] {
  const changes: VerdictChange[] = [];
  for (const c of cases) {
    const before = replayCase(beforeHook, c, env);
    const after = replayCase(afterHook, c, env);
    if (before.exit !== after.exit || before.block !== after.block) {
      changes.push({
        command: c.command,
        state: c.state,
        source: c.source,
        before,
        after,
      });
    }
  }
  return changes;
}

function describeVerdict(v: Verdict): string {
  return v.exit === 0 ? "allow" : `block (${v.block ?? "no reason"})`;
}

export function formatDiff(changes: VerdictChange[]): string {
  const noun = changes.length === 1 ? "verdict change" : "verdict changes";
  const lines = [`${changes.length} ${noun}`];
  for (const ch of changes) {
    const shown =
      ch.command.length > 200 ? `${ch.command.slice(0, 200)}…` : ch.command;
    lines.push(
      `  [${ch.source}] ${describeVerdict(ch.before)} -> ${describeVerdict(ch.after)}`,
      `    ${JSON.stringify(shown)}`,
    );
  }
  return lines.join("\n");
}

/** Extract the whole `hooks/` dir at `ref` — the hook sources sibling scripts. */
export function extractHooksAt(ref: string, into: string): string {
  const archive = spawnSync("git", ["archive", ref, "hooks"], {
    cwd: REPO_ROOT,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (archive.status !== 0) {
    throw new Error(
      `git archive ${ref} failed: ${archive.stderr?.toString().trim()}`,
    );
  }
  const untar = spawnSync("tar", ["-x", "-C", into], { input: archive.stdout });
  if (untar.status !== 0) throw new Error("tar extract of hooks/ failed");
  return join(into, "hooks", "pre-tool.sh");
}

// ---------------------------------------------------------------------------
// Harvest
// ---------------------------------------------------------------------------

/** Bash `tool_use` commands from Claude Code transcript JSONL text. */
export function extractTranscriptCommands(jsonl: string): string[] {
  const out: string[] = [];
  for (const line of jsonl.split("\n")) {
    if (!line.includes('"tool_use"')) continue;
    let obj: { message?: { content?: unknown } };
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    const content = obj.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (
        block &&
        block.type === "tool_use" &&
        block.name === "Bash" &&
        typeof block.input?.command === "string"
      ) {
        out.push(block.input.command);
      }
    }
  }
  return out;
}

/**
 * Bash commands from the hook's own log. Each `BLOCKED` line carries one
 * command already run through the hook's redactor; non-Bash payloads (JSON
 * objects for Edit/Write) and continuation lines of multi-line commands are
 * skipped, since a fragment is not a command form the hook was given.
 */
export function extractHookLogCommands(log: string): string[] {
  const out: string[] = [];
  for (const line of log.split("\n")) {
    const m = /^\d+(?:\.\d+)? BLOCKED \[([a-z-]+)\] (.+)$/.exec(line);
    if (!m) continue;
    const command = m[2];
    if (m[1] === "worktree-boundary" || command.startsWith("{")) continue;
    out.push(command);
  }
  return out;
}

/** Tokens the guards care about; exit-0 commands without one add replay time, not coverage. */
export const GUARD_RELEVANT =
  /git\s+(commit|push|reset|checkout|switch|add|stash|clean)|gh\s|\benv\b|printenv|\bsudo\b|<<|\.env|secret|credential|\brm\b|deploy|workflow|&\s*$|run_in_background|--force|npm\s+(test|run)/;

export function normalizeCandidate(command: string): string | null {
  if (command.length === 0 || command.length > MAX_COMMAND_LENGTH) return null;
  if (command.includes("\u0000")) return null;
  return redactCommand(command);
}

function readTranscriptDir(dir: string): string[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .flatMap((f) =>
      extractTranscriptCommands(readFileSync(join(dir, f), "utf8")),
    );
}

function stableHash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++)
    h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

export interface HarvestOptions {
  transcripts?: string;
  hookLog?: string;
  /** Cap on exit-0 commands added in one run (all exit-2 commands are kept). */
  maxAllow?: number;
}

export function harvest(
  existing: CorpusCase[],
  opts: HarvestOptions,
  hookPath: string,
  env: ReplayEnv,
): { added: CorpusCase[]; sources: string[] } {
  const seen = new Set(existing.map(caseKey));
  const candidates: Array<{ command: string; source: string }> = [];
  const sources: string[] = [];
  if (opts.hookLog && existsSync(opts.hookLog)) {
    sources.push(opts.hookLog);
    for (const c of extractHookLogCommands(
      readFileSync(opts.hookLog, "utf8"),
    )) {
      candidates.push({ command: c, source: "hook-log" });
    }
  }
  if (opts.transcripts && existsSync(opts.transcripts)) {
    sources.push(opts.transcripts);
    for (const c of readTranscriptDir(opts.transcripts)) {
      candidates.push({ command: c, source: "transcript" });
    }
  }

  const fresh = new Map<string, { command: string; source: string }>();
  for (const cand of candidates) {
    const command = normalizeCandidate(cand.command);
    if (command === null) continue;
    const key = caseKey({ command, state: "staged" });
    if (seen.has(key) || fresh.has(key)) continue;
    // A hook-log command outranks the same command seen in a transcript.
    fresh.set(key, { command, source: cand.source });
  }

  const blocked: CorpusCase[] = [];
  const allowed: CorpusCase[] = [];
  for (const { command, source } of fresh.values()) {
    if (source === "transcript" && !GUARD_RELEVANT.test(command)) continue;
    const c: CorpusCase = {
      command,
      tool: "Bash",
      exit: 0,
      block: null,
      source,
      state: "staged",
    };
    const first = replayCase(hookPath, c, env);
    const second = replayCase(hookPath, c, env);
    // A verdict that changes between two identical replays depends on time or
    // locks, not on the command, and would make the snapshot flaky.
    if (first.exit !== second.exit || first.block !== second.block) continue;
    const settled = { ...c, exit: first.exit, block: first.block };
    (first.exit === 0 ? allowed : blocked).push(settled);
  }

  allowed.sort((a, b) => stableHash(a.command) - stableHash(b.command));
  const kept = allowed.slice(0, opts.maxAllow ?? 150);
  return { added: [...blocked, ...kept], sources };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function flagValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

export function main(args: string[]): number {
  const hookPath = join(REPO_ROOT, "hooks", "pre-tool.sh");

  if (args.includes("--diff")) {
    const ref = flagValue(args, "--diff");
    if (!ref) {
      console.error("--diff needs a git ref");
      return 2;
    }
    const scratch = mkdtempSync(join(tmpdir(), "hook-corpus-ref-"));
    const env = createReplayEnv();
    try {
      const beforeHook = extractHooksAt(ref, scratch);
      const changes = diffVerdicts(loadCorpus(), beforeHook, hookPath, env);
      console.log(formatDiff(changes));
      return changes.length === 0 ? 0 : 1;
    } finally {
      env.cleanup();
      rmSync(scratch, { recursive: true, force: true });
    }
  }

  if (args.includes("--harvest")) {
    const env = createReplayEnv();
    try {
      const existing = loadCorpus();
      const maxAllow = flagValue(args, "--max-allow");
      const { added, sources } = harvest(
        existing,
        {
          transcripts: flagValue(args, "--transcripts"),
          hookLog: flagValue(args, "--hook-log"),
          maxAllow: maxAllow ? Number(maxAllow) : undefined,
        },
        hookPath,
        env,
      );
      writeCorpus([...existing, ...added]);
      console.log(`sources: ${sources.join(", ") || "(none)"}`);
      console.log(
        `added ${added.length} commands (${existing.length + added.length} total)`,
      );
      return 0;
    } finally {
      env.cleanup();
    }
  }

  console.error(
    "usage: hook-corpus.ts --diff <ref> | --harvest [--transcripts <dir>] [--hook-log <file>] [--max-allow N]",
  );
  return 2;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  process.exit(main(process.argv.slice(2)));
}

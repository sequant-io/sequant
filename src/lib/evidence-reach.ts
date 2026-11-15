/**
 * Evidence reach: whether an AC's `Evidence:` command stays inside the
 * worktree or reaches something a person must run (#1652, D-8).
 *
 * The qa skill runs each Evidence command as written (§6h). In E2c the phase
 * agents tried production credentials in 6 of 15 runs because the Evidence
 * lines named `--env-file=.env.local`, `vercel env ls production` and live
 * URLs. This module classifies those lines by a fixed rule set (P-9) so the
 * orchestrator can tell the qa agent not to run them, and can name them in the
 * run log and the run summary whatever the agent did.
 *
 * Only the backticked spans of the clause are classified: qa runs commands,
 * not prose. A clause with no backticks is `worktree`.
 */

export type EvidenceReach = "worktree" | "needs-human";
export type EvidenceReachReason = "env-file" | "production-cli" | "live-url";

export interface EvidenceReachResult {
  reach: EvidenceReach;
  reasons: EvidenceReachReason[];
}

/** One AC whose Evidence needs a person, with the commands that make it so. */
export interface NeedsHumanAc {
  id: string;
  reasons: EvidenceReachReason[];
  /** The needs-human backticked spans, verbatim. */
  commands: string[];
}

/** Reasons in their reported order. */
const REASON_ORDER: readonly EvidenceReachReason[] = [
  "env-file",
  "production-cli",
  "live-url",
];

/** P-9's fixed list of CLIs that act on a deployed environment. */
const PRODUCTION_CLIS = new Set([
  "vercel",
  "supabase",
  "netlify",
  "fly",
  "heroku",
  "wrangler",
  "railway",
  "aws",
  "gcloud",
  "az",
]);

/** Tools whose URL arguments are search patterns, not requests (OQ-1). */
const TEXT_SEARCH_TOOLS = new Set(["grep", "egrep", "fgrep", "rg", "ag"]);

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "0.0.0.0", "[::1]"]);

const ENV_FILE_FLAG_RE = /--env-file\b/;
/** A `.env` path: `.env`, `.env.local`, `config/.env.production`, `='.env'`. */
const ENV_PATH_RE = /(?:^|[\s/'"=])\.env(?:\.[\w-]+)*(?![\w-])/;
const URL_RE = /\bhttps?:\/\/(\[[^\]]*\]|[^/\s'"`:?#)]+)/gi;
const BACKTICK_SPAN_RE = /`([^`]+)`/g;

/** The backticked spans of an Evidence clause, verbatim, in order. */
export function evidenceCommands(evidence: string): string[] {
  return [...evidence.matchAll(BACKTICK_SPAN_RE)]
    .map((m) => m[1].trim())
    .filter((span) => span.length > 0);
}

/**
 * Split a command on unquoted `&&`, `||`, `;` and `|`. Quotes are tracked so
 * a regex alternation inside a grep pattern stays in its segment.
 */
function splitSegments(command: string): string[] {
  const segments: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote) {
      if (ch === quote) quote = null;
      current += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === ";" || ch === "|" || (ch === "&" && command[i + 1] === "&")) {
      segments.push(current);
      current = "";
      if ((ch === "|" || ch === "&") && command[i + 1] === ch) i++;
      continue;
    }
    current += ch;
  }
  segments.push(current);
  return segments.map((s) => s.trim()).filter((s) => s.length > 0);
}

/**
 * The words a segment runs, after leading `VAR=x` assignments and a package
 * runner prefix (`npx [-flags]`, `bunx`, `pnpm dlx|exec`, `yarn dlx`).
 */
function commandWords(segment: string): string[] {
  const words = segment.split(/\s+/).filter(Boolean);
  let i = 0;
  while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i])) i++;
  if (words[i] === "npx" || words[i] === "bunx") {
    i++;
    while (i < words.length && words[i].startsWith("-")) i++;
  } else if (
    (words[i] === "pnpm" &&
      (words[i + 1] === "dlx" || words[i + 1] === "exec")) ||
    (words[i] === "yarn" && words[i + 1] === "dlx")
  ) {
    i += 2;
  }
  return words.slice(i);
}

function isTextSearch(words: string[]): boolean {
  if (TEXT_SEARCH_TOOLS.has(words[0])) return true;
  return words[0] === "git" && words[1] === "grep";
}

function hasLiveUrl(segment: string): boolean {
  for (const m of segment.matchAll(URL_RE)) {
    if (!LOCAL_HOSTS.has(m[1].toLowerCase())) return true;
  }
  return false;
}

/** The reasons one command reaches outside the worktree. */
function commandReasons(command: string): Set<EvidenceReachReason> {
  const reasons = new Set<EvidenceReachReason>();
  if (ENV_FILE_FLAG_RE.test(command) || ENV_PATH_RE.test(command)) {
    reasons.add("env-file");
  }
  for (const segment of splitSegments(command)) {
    const words = commandWords(segment);
    if (words.length === 0) continue;
    if (PRODUCTION_CLIS.has(words[0])) reasons.add("production-cli");
    if (!isTextSearch(words) && hasLiveUrl(segment)) reasons.add("live-url");
  }
  return reasons;
}

function ordered(reasons: Set<EvidenceReachReason>): EvidenceReachReason[] {
  return REASON_ORDER.filter((r) => reasons.has(r));
}

/**
 * Classify an Evidence clause (E-1). `needs-human` when any backticked command
 * names an env file (`--env-file`, a `.env` path), runs a listed production
 * CLI, or requests a non-local URL; `worktree` otherwise.
 */
export function classifyEvidenceReach(evidence: string): EvidenceReachResult {
  const reasons = new Set<EvidenceReachReason>();
  for (const command of evidenceCommands(evidence)) {
    for (const r of commandReasons(command)) reasons.add(r);
  }
  const list = ordered(reasons);
  return { reach: list.length > 0 ? "needs-human" : "worktree", reasons: list };
}

/** The ACs whose Evidence needs a person, in declaration order. */
export function needsHumanAcs(
  items: ReadonlyArray<{ id: string; evidence?: string }>,
): NeedsHumanAc[] {
  const out: NeedsHumanAc[] = [];
  for (const item of items) {
    if (!item.evidence) continue;
    const commands = evidenceCommands(item.evidence).filter(
      (c) => commandReasons(c).size > 0,
    );
    if (commands.length === 0) continue;
    out.push({
      id: item.id,
      reasons: classifyEvidenceReach(item.evidence).reasons,
      commands,
    });
  }
  return out;
}

/**
 * The qa prompt block for the needs-human ACs (E-2), or undefined when there
 * are none. `getPhasePrompt` wraps it in its one sentinel block.
 */
export function buildEvidenceReachContext(
  acs: readonly NeedsHumanAc[],
): string | undefined {
  if (acs.length === 0) return undefined;
  const lines = [
    "## Evidence a person runs (#1652)",
    "",
    "These Evidence commands reach outside the worktree (an env file, a production CLI or a live URL). Do not run them. Report each AC below as `PENDING` with the command shown, for a person to run.",
    "",
  ];
  for (const ac of acs) {
    for (const command of ac.commands) {
      lines.push(`- ${ac.id}: \`${command}\``);
    }
  }
  return lines.join("\n");
}

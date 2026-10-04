/**
 * Second-look QA miner (#1067)
 *
 * Reconstructs the 2026-05-30 "fresh second-look QA" study as data. For each
 * pre-study checkpoint whose session opens with `qa <N>`, it streams the
 * transcript from the LOCAL-ONLY `entire/checkpoints/v1` branch and emits
 * mechanical signals only — never transcript text:
 *
 *   - the verdicts the assistant stated, with the human turn they follow
 *   - the first human turn that asks about gaps ("any gaps?", "fix all gaps")
 *   - Edit/Write and `git commit` tool calls, bucketed before/after that turn
 *   - whether SEQUANT_ORCHESTRATOR appears set in the session
 *   - (with --github) whether an orchestrated QA phase marker was posted on the
 *     issue before the session started — i.e. whether this is a true second look
 *
 * The labels (caught y/n, defect class, primary mechanism) are assigned by a
 * human from these signals plus narrow reads; see
 * `docs/investigations/qa-second-look-dataset.md`.
 *
 * Output: `.sequant/qa-second-look.jsonl` (gitignored) + a stdout table.
 *
 * Usage:
 *   npx tsx scripts/analytics/qa-second-look-mine.ts [--github] [--out path]
 *
 * ⚠️ The output holds the first 80 chars of each human turn for local labeling.
 * Do not commit it: this repo is public and the transcripts are private.
 *
 * @see https://github.com/sequant-io/sequant/issues/1067
 */

import * as fs from "fs";
import * as path from "path";
import * as readline from "readline";
import { spawn, execFileSync } from "child_process";

export const CHECKPOINT_BRANCH = "entire/checkpoints/v1";

/** Pre-study (≤ 2026-05-30) sessions whose prompt opens with `qa <N>`. */
export const CANDIDATES: { path: string; issues: number[] }[] = [
  { path: "f9/389daebb2d/0", issues: [313] },
  { path: "a8/8566fd523c/0", issues: [299, 300] },
  { path: "1e/43716fecdd/2", issues: [336] },
  { path: "1e/43716fecdd/3", issues: [172] },
  { path: "1e/43716fecdd/4", issues: [248] },
  { path: "78/781336ea85/0", issues: [327] },
  { path: "78/781336ea85/1", issues: [94, 352] },
  { path: "78/781336ea85/12", issues: [368] },
  { path: "78/781336ea85/14", issues: [372] },
  { path: "78/781336ea85/15", issues: [369] },
  { path: "78/781336ea85/18", issues: [370] },
  { path: "78/781336ea85/22", issues: [395] },
  { path: "a9/ea4586305f/1", issues: [447] },
  { path: "a9/ea4586305f/0", issues: [448] },
  { path: "80/f7c4e77624/0", issues: [448] },
  { path: "37/2c9c4e609f/3", issues: [461] },
  { path: "f7/450c494650/3", issues: [460] },
  { path: "5b/588313b1b7/1", issues: [484] },
  { path: "7a/86e4a2ac1f/1", issues: [503] },
  { path: "d0/9462ed63c7/1", issues: [503] },
  { path: "27/f002f3c8e8/0", issues: [528] },
  { path: "dc/ef697be3a1/0", issues: [528] },
  { path: "44/b04e8aa7a7/1", issues: [529, 531] },
  { path: "4a/267c526c78/0", issues: [616] },
  { path: "e4/b2f746d002/0", issues: [605] },
  { path: "e4/b2f746d002/1", issues: [543] },
];

export const VERDICTS = [
  "READY_FOR_MERGE",
  "AC_MET_BUT_NOT_A_PLUS",
  "AC_NOT_MET",
  "NEEDS_VERIFICATION",
] as const;
export type Verdict = (typeof VERDICTS)[number];

const VERDICT_STATED =
  /verdict[^A-Z\n]{0,40}(READY_FOR_MERGE|AC_MET_BUT_NOT_A_PLUS|AC_NOT_MET|NEEDS_VERIFICATION)/i;
const GAP_PROMPT = /\bgaps?\b/i;

export interface TranscriptSignals {
  humanTurns: number;
  /** First 80 chars of each human turn — local labeling aid, never published. */
  humanTurnHeads: string[];
  /** Index (0-based) of the first human turn after the opener that asks about gaps. */
  firstGapTurn: number | null;
  verdicts: { turn: number; verdict: Verdict }[];
  editsBeforeGap: number;
  editsAfterGap: number;
  commitsBeforeGap: number;
  commitsAfterGap: number;
  orchestratorSet: boolean;
}

interface ContentBlock {
  type?: string;
  text?: string;
  name?: string;
  input?: { command?: string };
}

function humanText(entry: Record<string, unknown>): string | null {
  if (entry.type !== "user" || entry.isMeta || entry.isSidechain) return null;
  const msg = entry.message as { content?: unknown } | undefined;
  const content = msg?.content;
  let text: string | null = null;
  if (typeof content === "string") text = content;
  else if (Array.isArray(content)) {
    const blocks = content as ContentBlock[];
    if (blocks.some((b) => b.type === "tool_result")) return null;
    text = blocks
      .filter((b) => b.type === "text")
      .map((b) => b.text ?? "")
      .join("\n");
  }
  if (!text) return null;
  // Harness-injected turns, not something the human typed.
  if (
    /^\s*<(local-command|command-stdout|task-notification|system-reminder)/.test(text)
  )
    return null;
  if (/^\s*Caveat: The messages below/.test(text)) return null;
  return text;
}

/** Pure: derive the signals from an iterable of transcript JSONL lines. */
export function mineLines(lines: Iterable<string>): TranscriptSignals {
  const s: TranscriptSignals = {
    humanTurns: 0,
    humanTurnHeads: [],
    firstGapTurn: null,
    verdicts: [],
    editsBeforeGap: 0,
    editsAfterGap: 0,
    commitsBeforeGap: 0,
    commitsAfterGap: 0,
    orchestratorSet: false,
  };
  let turn = -1;
  for (const line of lines) {
    if (!line.trim()) continue;
    if (/SEQUANT_ORCHESTRATOR=[a-z]/.test(line)) s.orchestratorSet = true;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const human = humanText(entry);
    if (human !== null) {
      turn++;
      s.humanTurns++;
      s.humanTurnHeads.push(human.replace(/\s+/g, " ").slice(0, 80));
      if (turn > 0 && s.firstGapTurn === null && GAP_PROMPT.test(human)) {
        s.firstGapTurn = turn;
      }
      continue;
    }
    if (entry.type !== "assistant" || entry.isSidechain) continue;
    const content = (entry.message as { content?: unknown } | undefined)
      ?.content;
    if (!Array.isArray(content)) continue;
    const afterGap = s.firstGapTurn !== null;
    for (const b of content as ContentBlock[]) {
      if (b.type === "text" && b.text) {
        const m = b.text.match(VERDICT_STATED);
        if (m) {
          const verdict = m[1].toUpperCase() as Verdict;
          const last = s.verdicts[s.verdicts.length - 1];
          if (!last || last.turn !== turn || last.verdict !== verdict) {
            s.verdicts.push({ turn, verdict });
          }
        }
      } else if (b.type === "tool_use") {
        if (b.name === "Edit" || b.name === "Write" || b.name === "MultiEdit") {
          if (afterGap) s.editsAfterGap++;
          else s.editsBeforeGap++;
        } else if (
          b.name === "Bash" &&
          /\bgit commit\b/.test(b.input?.command ?? "")
        ) {
          if (afterGap) s.commitsAfterGap++;
          else s.commitsBeforeGap++;
        }
      }
    }
  }
  return s;
}

async function mineCheckpoint(p: string): Promise<TranscriptSignals> {
  const child = spawn("git", ["show", `${CHECKPOINT_BRANCH}:${p}/full.jsonl`], {
    stdio: ["ignore", "pipe", "ignore"],
  });
  const rl = readline.createInterface({ input: child.stdout });
  const lines: string[] = [];
  // Stream: keep only lines that can carry a signal, not the whole file.
  for await (const line of rl) {
    if (
      line.includes('"type":"user"') ||
      line.includes('"type":"assistant"') ||
      line.includes("SEQUANT_ORCHESTRATOR=")
    ) {
      lines.push(line);
    }
  }
  return mineLines(lines);
}

function gitShow(p: string): string {
  try {
    return execFileSync("git", ["show", `${CHECKPOINT_BRANCH}:${p}`], {
      encoding: "utf-8",
    }).trim();
  } catch {
    return "";
  }
}

/** Orchestrated QA phase markers posted on the issue before `before`. */
function priorQaMarkers(issue: number, before: string): number {
  try {
    const out = execFileSync(
      "gh",
      [
        "api",
        "--paginate",
        `repos/{owner}/{repo}/issues/${issue}/comments`,
        "--jq",
        ".[] | select(.created_at < \"" +
          before +
          '") | .body | select(test("SEQUANT_PHASE: \\\\{\\"phase\\":\\"qa\\"")) | "x"',
      ],
      { encoding: "utf-8" },
    );
    return out.split("\n").filter(Boolean).length;
  } catch {
    return -1;
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const github = args.includes("--github");
  const outIdx = args.indexOf("--out");
  const out =
    outIdx >= 0 ? args[outIdx + 1] : path.join(".sequant", "qa-second-look.jsonl");
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const rows: string[] = [];
  console.log(
    "path\tissues\tcreated\tturns\tgapTurn\tverdicts\tedits(b/a)\tcommits(b/a)\torch\tpriorQa",
  );
  for (const c of CANDIDATES) {
    const meta = JSON.parse(gitShow(`${c.path}/metadata.json`) || "{}");
    const createdAt: string = meta.created_at ?? "";
    const hash = gitShow(`${c.path}/content_hash.txt`);
    const sig = await mineCheckpoint(c.path);
    const priorQa = github ? priorQaMarkers(c.issues[0], createdAt) : null;
    rows.push(
      JSON.stringify({ ...c, createdAt, contentHash: hash, priorQa, ...sig }),
    );
    console.log(
      [
        c.path,
        c.issues.join("+"),
        createdAt.slice(0, 10),
        sig.humanTurns,
        sig.firstGapTurn ?? "-",
        sig.verdicts.map((v) => `${v.turn}:${v.verdict}`).join(",") || "-",
        `${sig.editsBeforeGap}/${sig.editsAfterGap}`,
        `${sig.commitsBeforeGap}/${sig.commitsAfterGap}`,
        sig.orchestratorSet ? "y" : "n",
        priorQa ?? "-",
      ].join("\t"),
    );
  }
  fs.writeFileSync(out, rows.join("\n") + "\n");
  console.error(`\nwrote ${rows.length} rows to ${out}`);
}

if (process.argv[1] && /qa-second-look-mine\.ts$/.test(process.argv[1])) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

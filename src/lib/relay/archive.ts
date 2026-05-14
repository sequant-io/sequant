/**
 * Archive the working relay directory to `.sequant/logs/relay/<issue>-<phase>-<ts>/`
 * at phase end so transcripts survive worktree teardown (AC-6, AC-D2, AC-D4).
 *
 * The archive copies inbox.jsonl + outbox.jsonl + meta.json, then clears the
 * working dir. Failures are non-fatal — teardown must still proceed.
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "fs";
import { join } from "path";
import {
  archiveDirFor,
  relayDirFor,
  RELAY_CURSOR,
  RELAY_INBOX,
  RELAY_OUTBOX,
  type RelayPathOptions,
} from "./paths.js";
import { RelayArchiveMetaSchema, type RelayArchiveMeta } from "./types.js";

export interface ArchiveOptions extends RelayPathOptions {
  /** Phase whose work just finished — used in the archive dir name. */
  phase: string;
  /** When the relay was activated. */
  startedAt: string;
  /** Total messages exchanged during the run. */
  messageCount: number;
  /** Override timestamp (test seam). */
  endedAt?: string;
  /** Main repo cwd for archive root (`.sequant/logs/relay/`). */
  archiveCwd?: string;
}

export interface ArchiveResult {
  archived: boolean;
  archivePath: string | null;
  error: string | null;
}

function countLines(path: string): number {
  if (!existsSync(path)) return 0;
  try {
    const st = statSync(path);
    if (st.size === 0) return 0;
    const text = readFileSync(path, "utf-8");
    return text.split("\n").filter((l) => l.trim() !== "").length;
  } catch {
    return 0;
  }
}

/**
 * Archive the relay directory for `issue` and clear it. Idempotent; if the
 * dir doesn't exist, returns `{ archived: false }` without error.
 */
export function archiveRelayDir(
  issue: number,
  options: ArchiveOptions,
): ArchiveResult {
  const srcDir = relayDirFor(issue, options);
  if (!existsSync(srcDir)) {
    return { archived: false, archivePath: null, error: null };
  }

  // Idempotent: if there are no transcripts to preserve, skip creating an
  // empty archive dir. Lets callers safely deactivate twice.
  const hasInbox = existsSync(join(srcDir, RELAY_INBOX));
  const hasOutbox = existsSync(join(srcDir, RELAY_OUTBOX));
  if (!hasInbox && !hasOutbox) {
    return { archived: false, archivePath: null, error: null };
  }

  const endedAt = options.endedAt ?? new Date().toISOString();
  let destDir = archiveDirFor(
    issue,
    options.phase,
    endedAt,
    options.archiveCwd ?? process.cwd(),
  );

  // If the dest exists (clock collision on same-second), append a suffix.
  if (existsSync(destDir)) {
    let n = 2;
    while (existsSync(`${destDir}.${n}`)) n++;
    destDir = `${destDir}.${n}`;
  }

  try {
    mkdirSync(destDir, { recursive: true });

    // Copy inbox/outbox if present.
    for (const name of [RELAY_INBOX, RELAY_OUTBOX]) {
      const src = join(srcDir, name);
      if (existsSync(src)) {
        copyFileSync(src, join(destDir, name));
      }
    }

    // Split inbox/outbox counts (#645, Gap 5). Surfaces unanswered queries
    // (inboxCount > outboxCount) when inspecting archives post-hoc.
    const inboxCount = countLines(join(srcDir, RELAY_INBOX));
    const outboxCount = countLines(join(srcDir, RELAY_OUTBOX));

    // Write meta.json.
    const meta: RelayArchiveMeta = RelayArchiveMetaSchema.parse({
      issue,
      phase: options.phase,
      startedAt: options.startedAt,
      endedAt,
      messageCount: options.messageCount,
      inboxCount,
      outboxCount,
    });
    writeFileSync(
      join(destDir, "meta.json"),
      JSON.stringify(meta, null, 2),
      "utf-8",
    );

    // Clear the working relay dir (inbox/outbox/cursor).
    for (const name of [RELAY_INBOX, RELAY_OUTBOX, RELAY_CURSOR]) {
      const p = join(srcDir, name);
      if (existsSync(p)) rmSync(p, { force: true });
    }

    return { archived: true, archivePath: destDir, error: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { archived: false, archivePath: null, error: message };
  }
}

/** Count messages currently in the inbox + outbox of a relay dir. */
export function tallyMessageCount(
  issue: number,
  options: RelayPathOptions = {},
): number {
  const dir = relayDirFor(issue, options);
  if (!existsSync(dir)) return 0;
  const inbox = countLines(join(dir, RELAY_INBOX));
  const outbox = countLines(join(dir, RELAY_OUTBOX));
  return inbox + outbox;
}

/** List archived relay directories for an issue (sorted newest first). */
export function listArchives(
  issue: number,
  archiveCwd: string = process.cwd(),
): string[] {
  const root = join(archiveCwd, ".sequant", "logs", "relay");
  if (!existsSync(root)) return [];
  try {
    return readdirSync(root)
      .filter((n) => n.startsWith(`${issue}-`))
      .sort()
      .reverse()
      .map((n) => join(root, n));
  } catch {
    return [];
  }
}

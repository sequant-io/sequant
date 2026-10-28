/**
 * The mutation-verification receipt (#1604): `.sequant/mutations/<N>.json`.
 *
 * `sequant mutation begin` creates the file on a clean tree and `sequant
 * mutation check` appends one record per real run — a run in which the named
 * test failed under the mutation and passed after the tree was restored. The
 * file is the only producer of `SEQUANT_MUTATION` markers: `sequant mutation
 * render` and the orchestrator's PR-body assembly both render it through
 * {@link renderMutationMarker}, so the marker grammar stays in
 * `mutation-marker.ts`.
 *
 * Paths resolve against the worktree that ran `begin`, never the main
 * checkout. `.sequant/mutations/` sits under the gitignored `.sequant/`, and
 * `mutation.ts` excludes it from its own `git status` and `git add` as well,
 * so the receipt never dirties the tree it describes.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "fs";
import { join } from "path";
import { z } from "zod";
import {
  latestMutationMarkerPerAc,
  renderMutationMarker,
  type MutationMarker,
} from "./mutation-marker.js";

/** Directory of the receipts, relative to the worktree root. */
export const MUTATION_STATE_DIR = ".sequant/mutations";

const MutationRecordSchema = z.object({
  ac: z.string().min(1),
  /** Test file, relative to the worktree root. */
  test: z.string().min(1),
  /** Full vitest name of the one test that ran: `<describe> > <case>`. */
  name: z.string().min(1),
  mutation: z.string().min(1),
  /** Exit code of the run under the mutation (non-zero). */
  mutatedExit: z.number().int(),
  /** Exit code of the run after the restore (zero). */
  restoredExit: z.number().int(),
  ranAt: z.string().min(1),
  /** HEAD the mutation was applied to. */
  sha: z.string().min(1),
});

const MutationStateSchema = z.object({
  issue: z.number().int().positive(),
  /** HEAD when `begin` ran; `check` refuses once HEAD moves. */
  sha: z.string().min(1),
  startedAt: z.string().min(1),
  records: z.array(MutationRecordSchema),
});

export type MutationRecord = z.infer<typeof MutationRecordSchema>;
export type MutationState = z.infer<typeof MutationStateSchema>;

/** Path of the receipt for `issue` under the worktree `root`. */
export function mutationStatePath(root: string, issue: number): string {
  return join(root, MUTATION_STATE_DIR, `${issue}.json`);
}

/** Path where `check` keeps the captured mutation patch. */
export function mutationPatchPath(root: string, issue: number): string {
  return join(root, MUTATION_STATE_DIR, `${issue}.patch`);
}

/**
 * Read the receipt for `issue`. Returns `undefined` when there is none;
 * throws when the file exists but is not a valid receipt, so a corrupted
 * file is reported rather than read as "no records".
 */
export function readMutationState(
  root: string,
  issue: number,
): MutationState | undefined {
  const path = mutationStatePath(root, issue);
  if (!existsSync(path)) return undefined;
  const parsed = MutationStateSchema.safeParse(
    JSON.parse(readFileSync(path, "utf8")),
  );
  if (!parsed.success) {
    throw new Error(
      `${path} is not a mutation receipt: ${parsed.error.message}`,
    );
  }
  return parsed.data;
}

/** Write the receipt atomically (temp file, then rename). */
export function writeMutationState(root: string, state: MutationState): void {
  const path = mutationStatePath(root, state.issue);
  mkdirSync(join(root, MUTATION_STATE_DIR), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
  renameSync(tmp, path);
}

/**
 * The marker a record certifies. `failedTest` starts with the test file path,
 * which is the only segment `/qa` §6i resolves against the diff.
 */
export function recordToMarker(record: MutationRecord): MutationMarker {
  return {
    ac: record.ac,
    mutation: record.mutation,
    failedTest: `${record.test} > ${record.name}`,
  };
}

/** One marker per AC, the latest record winning. */
export function mutationMarkersFromState(
  state: MutationState | undefined,
): MutationMarker[] {
  if (!state) return [];
  return [
    ...latestMutationMarkerPerAc(state.records.map(recordToMarker)).values(),
  ];
}

/** The marker lines `sequant mutation render` prints, one per AC. */
export function renderMutationMarkersFromState(
  state: MutationState | undefined,
): string[] {
  return mutationMarkersFromState(state).map(renderMutationMarker);
}

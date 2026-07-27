/**
 * Schema for `/assess` rendered output (#823).
 *
 * The `/assess` skill produces judgment (triage verdicts); this schema is the
 * contract it hands to the renderer, which produces geometry. Splitting the two
 * is the point of #823: the model stopped emitting the output block at all, and
 * when it did emit one the columns drifted, because deterministic formatting was
 * being done by hand in a prompt.
 *
 * Modeled on `src/lib/scope/types.ts` (the in-repo precedent for a zod schema
 * module). Deliberately carries no rendering logic — see `./renderer.ts`.
 */

import { z } from "zod";

/**
 * The fixed action vocabulary from `skills/assess/SKILL.md`. Every assessed
 * issue gets exactly one.
 */
export const AssessActionSchema = z.enum([
  "PROCEED",
  "CLOSE",
  "MERGE",
  "REWRITE",
  "CLARIFY",
  "PARK",
]);

export type AssessAction = z.infer<typeof AssessActionSchema>;

/**
 * A `sequant` invocation. `args` excludes the command prefix — the renderer
 * prepends the single resolved `commandPrefix` so one assessment can never mix
 * `sequant` and `npx sequant` (Commands Block Rule #9).
 */
export const AssessCommandSchema = z
  .object({
    /** Everything after the prefix, e.g. `run 820 819 -Q`. */
    args: z.string().min(1),
    /** Trailing `# ...` annotation, e.g. `resume`, `restart`, `fresh start`. */
    comment: z.string().optional(),
  })
  .strict();

export type AssessCommand = z.infer<typeof AssessCommandSchema>;

/**
 * A `Cleanup:` entry. These are `git`/`gh` commands, not `sequant` ones, so
 * they carry no prefix and are emitted verbatim.
 */
export const AssessCleanupSchema = z
  .object({
    command: z.string().min(1),
    reason: z.string().optional(),
  })
  .strict();

export type AssessCleanup = z.infer<typeof AssessCleanupSchema>;

/** A `Flags:` entry — one distinct flag plus its one-line justification. */
export const AssessFlagSchema = z
  .object({
    flag: z.string().min(1),
    reason: z.string().min(1),
  })
  .strict();

export type AssessFlag = z.infer<typeof AssessFlagSchema>;

/**
 * A `⚠` warning. In batch mode `issue` scopes it to a row (`⚠ #458 ...`); in a
 * posted single-mode comment the number is dropped because the comment is
 * already scoped to that issue.
 */
export const AssessWarningSchema = z
  .object({
    issue: z.number().int().positive().optional(),
    text: z.string().min(1),
  })
  .strict();

export type AssessWarning = z.infer<typeof AssessWarningSchema>;

/**
 * One assessed issue. Batch mode consumes the table fields; single mode
 * consumes the detail fields. Cross-field requirements are enforced per-mode in
 * {@link AssessResultSchema}'s refinement rather than by making fields
 * unconditionally required, so a batch payload is not forced to carry titles it
 * never renders.
 */
export const AssessIssueSchema = z
  .object({
    number: z.number().int().positive(),
    action: AssessActionSchema,
    /** Short `Reason` column text. The only column the renderer truncates. */
    reason: z.string().min(1),
    /** `Run` column value — a workflow (`spec → exec → qa`) or a symbol (`‖`). */
    run: z.string().min(1).optional(),
    /** Drives the conditional `ACs` column; omit when the issue has no checkbox ACs. */
    acCount: z.number().int().nonnegative().optional(),

    /** Resolved workflow, recorded in the HTML marker regardless of shorthand flags. */
    phases: z.array(z.string().min(1)).optional(),
    qualityLoop: z.boolean().optional(),

    // --- single mode / posted comment ---
    title: z.string().min(1).optional(),
    state: z.string().min(1).optional(),
    labels: z.array(z.string().min(1)).optional(),
    /** This issue's own single-issue invocation (PROCEED / REWRITE). */
    command: AssessCommandSchema.optional(),
    /** `buildSupersessionHeader(priors)` output, emitted above the verdict line. */
    supersession: z.string().min(1).optional(),
    /** Per-issue warnings with the leading `#N` already dropped. */
    warnings: z.array(z.string().min(1)).optional(),
    flags: z.array(AssessFlagSchema).optional(),
    cleanup: z.array(AssessCleanupSchema).optional(),

    // --- verdict-specific ---
    /** MERGE: the issue absorbing this one. */
    mergeTarget: z.number().int().positive().optional(),
    /** MERGE: this issue's scope summary. */
    scopeSelf: z.string().min(1).optional(),
    /** MERGE: the target's scope summary. */
    scopeTarget: z.string().min(1).optional(),
    /** CLARIFY: the specific information required. */
    need: z.string().min(1).optional(),
    /** CLARIFY: why the gap blocks work. */
    needDetail: z.string().min(1).optional(),
    /** PARK: the condition that unblocks this issue. */
    resumeAfter: z.string().min(1).optional(),
  })
  .strict();

export type AssessIssue = z.infer<typeof AssessIssueSchema>;

/** `Chain:` suggestion — an alternative execution topology, never auto-applied. */
export const AssessChainSchema = z
  .object({
    args: z.string().min(1),
    reason: z.string().min(1),
  })
  .strict();

export type AssessChain = z.infer<typeof AssessChainSchema>;

/**
 * The complete payload the `/assess` skill hands to the renderer.
 *
 * `.strict()` throughout is deliberate: a typo'd key is a silent data-loss bug
 * in a hand-built JSON payload, and naming the unknown key is exactly the
 * actionable error AC-2 asks for.
 */
export const AssessResultSchema = z
  .object({
    mode: z.enum(["batch", "single"]),
    /** Resolved in the skill's Step-1 probe: `sequant` or `npx sequant`. */
    commandPrefix: z.string().min(1),
    issues: z.array(AssessIssueSchema).min(1),

    // --- batch-only sections ---
    commands: z.array(AssessCommandSchema).optional(),
    /** `Order:` annotations, each carrying dependency reasoning. */
    orders: z.array(z.string().min(1)).optional(),
    warnings: z.array(AssessWarningSchema).optional(),
    chain: AssessChainSchema.optional(),
    flags: z.array(AssessFlagSchema).optional(),
    cleanup: z.array(AssessCleanupSchema).optional(),
  })
  .strict()
  .superRefine((result, ctx) => {
    if (result.mode === "batch") {
      result.issues.forEach((issue, i) => {
        if (!issue.run) {
          ctx.addIssue({
            code: "custom",
            path: ["issues", i, "run"],
            message: `batch mode requires a Run column value for issue #${issue.number}`,
          });
        }
      });
      return;
    }

    if (result.issues.length !== 1) {
      ctx.addIssue({
        code: "custom",
        path: ["issues"],
        message: `single mode renders exactly one issue, received ${result.issues.length}`,
      });
    }

    result.issues.forEach((issue, i) => {
      for (const field of ["title", "state"] as const) {
        if (!issue[field]) {
          ctx.addIssue({
            code: "custom",
            path: ["issues", i, field],
            message: `single mode requires ${field} for the #${issue.number} header line`,
          });
        }
      }
      if (issue.action === "MERGE" && issue.mergeTarget === undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["issues", i, "mergeTarget"],
          message: "MERGE requires the target issue number",
        });
      }
      if (issue.action === "PARK" && !issue.resumeAfter) {
        ctx.addIssue({
          code: "custom",
          path: ["issues", i, "resumeAfter"],
          message: "PARK requires a resume condition",
        });
      }
      if (issue.action === "CLARIFY" && !issue.need) {
        ctx.addIssue({
          code: "custom",
          path: ["issues", i, "need"],
          message: "CLARIFY requires the specific information needed",
        });
      }
    });
  });

export type AssessResult = z.infer<typeof AssessResultSchema>;

/** Raised by {@link parseAssessResult} when validation fails. */
export class AssessResultValidationError extends Error {
  constructor(
    message: string,
    readonly problems: string[],
  ) {
    super(message);
    this.name = "AssessResultValidationError";
  }
}

/**
 * Render a zod path as a readable field reference: `issues[2].action`.
 */
function formatPath(path: readonly PropertyKey[]): string {
  if (path.length === 0) return "(root)";
  return path.reduce<string>((acc, segment) => {
    if (typeof segment === "number") return `${acc}[${segment}]`;
    return acc === "" ? String(segment) : `${acc}.${String(segment)}`;
  }, "");
}

/**
 * Validate an untrusted payload against {@link AssessResultSchema}.
 *
 * @throws {AssessResultValidationError} naming every offending field.
 */
export function parseAssessResult(input: unknown): AssessResult {
  const result = AssessResultSchema.safeParse(input);
  if (result.success) return result.data;

  const problems = result.error.issues.map(
    (issue) => `${formatPath(issue.path)}: ${issue.message}`,
  );
  throw new AssessResultValidationError(
    `Invalid AssessResult:\n  ${problems.join("\n  ")}`,
    problems,
  );
}

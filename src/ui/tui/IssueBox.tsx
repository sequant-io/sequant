import type { JSX } from "react";
import { Box, Text } from "ink";
import type { IssueRuntimeState } from "../../lib/workflow/run-state.js";
import {
  DIVIDER_COLOR,
  PHASE_GLYPHS,
  borderColorForIssue,
  phaseStatusColor,
} from "./theme.js";
import { Spinner } from "./Spinner.js";
import { ElapsedTimer, formatSinceActivity } from "./ElapsedTimer.js";
import { truncateToWidth } from "./truncate.js";

/**
 * Three-cell rendering of a single issue's runtime state.
 *
 * Cells:
 *   1. header  — id, title, phase N/total, elapsed
 *   2. context — branch, phase progression, log path
 *   3. activity — current `now` line, last-activity stamp
 */
export function IssueBox({
  state,
  slot,
  width,
  now,
}: {
  state: IssueRuntimeState;
  slot: number;
  width: number;
  now: number;
}): JSX.Element {
  const border = borderColorForIssue(state.status, slot);
  const innerWidth = Math.max(10, width - 4);
  const doneCount = state.phases.filter(
    (p) => p.status === "done" || p.status === "failed",
  ).length;
  const activePhaseIndex = state.phases.findIndex(
    (p) => p.status === "running",
  );
  const displayPhaseN =
    activePhaseIndex >= 0 ? activePhaseIndex + 1 : doneCount;
  const total = state.phases.length;

  const headerTitle = truncateToWidth(
    `#${state.number}  ${state.title}`,
    Math.max(10, innerWidth - 20),
  );

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={border}
      paddingX={1}
      marginBottom={1}
      width={width}
    >
      {/* Cell 1: header */}
      <Box justifyContent="space-between">
        <Text color={border}>{headerTitle}</Text>
        <Text color={DIVIDER_COLOR}>
          phase {displayPhaseN}/{total} •{" "}
          <ElapsedTimer startedAt={state.startedAt} />
        </Text>
      </Box>

      <Divider width={innerWidth} color={DIVIDER_COLOR} />

      {/* Cell 2: context */}
      <Box flexDirection="column">
        <Box>
          <Text color={DIVIDER_COLOR}>branch </Text>
          <Text>{truncateToWidth(state.branch, innerWidth - 8)}</Text>
        </Box>
        <PhaseProgression phases={state.phases} borderColor={border} />
        {state.currentPhase?.logPath ? (
          <Box>
            <Text color={DIVIDER_COLOR}>log </Text>
            <Text>
              {truncateToWidth(state.currentPhase.logPath, innerWidth - 8)}
            </Text>
          </Box>
        ) : null}
      </Box>

      <Divider width={innerWidth} color={DIVIDER_COLOR} />

      {/* Cell 3: activity */}
      <Box flexDirection="column">
        {state.currentPhase ? (
          <>
            <Box>
              <Text color={DIVIDER_COLOR}>now </Text>
              <Spinner color={border} />
              <Text>
                {"  "}
                {truncateToWidth(state.currentPhase.nowLine, innerWidth - 12)}
              </Text>
            </Box>
            <Box>
              <Text color={DIVIDER_COLOR}>
                {"        └ last activity "}
                {formatSinceActivity(now, state.currentPhase.lastActivityAt)}
              </Text>
            </Box>
          </>
        ) : (
          <Text color={DIVIDER_COLOR}>{statusLine(state)}</Text>
        )}
      </Box>
    </Box>
  );
}

function statusLine(state: IssueRuntimeState): string {
  switch (state.status) {
    case "queued":
      return "queued";
    case "running":
      return "working…";
    case "passed":
      return "completed";
    case "failed":
      return "failed";
  }
}

function Divider({
  width,
  color,
}: {
  width: number;
  color: string;
}): JSX.Element {
  return <Text color={color}>{"─".repeat(Math.max(1, width))}</Text>;
}

function PhaseProgression({
  phases,
  borderColor,
}: {
  phases: IssueRuntimeState["phases"];
  borderColor: string;
}): JSX.Element {
  return (
    <Box flexWrap="wrap">
      <Text color={DIVIDER_COLOR}>phases </Text>
      {phases.map((p, i) => {
        const isLast = i === phases.length - 1;
        return (
          <Box key={`${p.name}-${i}`}>
            <PhaseGlyph
              status={p.status}
              label={p.name}
              activeColor={borderColor}
              elapsedMs={p.elapsedMs}
            />
            {!isLast ? (
              <Text color={DIVIDER_COLOR}>
                {"   "}
                {PHASE_GLYPHS.separator}
                {"   "}
              </Text>
            ) : null}
          </Box>
        );
      })}
    </Box>
  );
}

function PhaseGlyph({
  status,
  label,
  activeColor,
  elapsedMs,
}: {
  status: "pending" | "running" | "done" | "failed";
  label: string;
  activeColor: string;
  elapsedMs?: number;
}): JSX.Element {
  if (status === "running") {
    return (
      <Box>
        <Spinner color={activeColor as never} />
        <Text> {label}</Text>
      </Box>
    );
  }
  const glyph =
    status === "done"
      ? PHASE_GLYPHS.done
      : status === "failed"
        ? PHASE_GLYPHS.failed
        : PHASE_GLYPHS.pending;
  const glyphColor = phaseStatusColor(status);
  return (
    <Box>
      <Text color={glyphColor}>{glyph}</Text>
      <Text color={DIVIDER_COLOR}>
        {" "}
        {label}
        {elapsedMs != null ? ` ${formatShortDuration(elapsedMs)}` : ""}
      </Text>
    </Box>
  );
}

function formatShortDuration(ms: number): string {
  const secs = Math.max(0, Math.floor(ms / 1000));
  if (secs < 60) return `${secs.toString().padStart(2, "0")}s`;
  const mm = Math.floor(secs / 60)
    .toString()
    .padStart(2, "0");
  const ss = (secs % 60).toString().padStart(2, "0");
  return `${mm}:${ss}`;
}

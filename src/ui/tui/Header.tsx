import type { JSX } from "react";
import { Box, Text } from "ink";
import type { RunSnapshot } from "../../lib/workflow/run-state.js";
import { DIVIDER_COLOR } from "./theme.js";

/** Top-of-dashboard summary: count, concurrency, base, quality-loop. */
export function Header({ snapshot }: { snapshot: RunSnapshot }): JSX.Element {
  const { config, issues } = snapshot;
  const concurrency =
    config.concurrency > 1
      ? `parallel (${config.concurrency} concurrent)`
      : "sequential";
  const loop = config.qualityLoop ? "on" : "off";
  const base = config.baseSha
    ? `${config.baseBranch} @${config.baseSha.slice(0, 7)}`
    : config.baseBranch;

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box>
        <Text bold>sequant run</Text>
        <Text color={DIVIDER_COLOR}>
          {"  ─  "}
          {issues.length} issue{issues.length === 1 ? "" : "s"}
          {"  •  "}
          {concurrency}
          {"  •  "}
          quality loop {loop}
        </Text>
      </Box>
      <Box>
        <Text color={DIVIDER_COLOR}>base </Text>
        <Text>{base}</Text>
      </Box>
    </Box>
  );
}

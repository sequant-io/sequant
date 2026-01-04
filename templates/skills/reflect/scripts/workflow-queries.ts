/**
 * Workflow Analytics SQL Queries
 *
 * Use with Supabase MCP's execute_sql for /reflect workflow analysis.
 * The workflow_runs table stores phase completion data with duration, verdict, and errors.
 */

export const WORKFLOW_QUERIES = {
  /**
   * Success rate by phase (last 30 days)
   */
  successRateByPhase: `
    SELECT
      phase,
      COUNT(*) as total_runs,
      COUNT(*) FILTER (WHERE status = 'completed' AND verdict IN ('pass', 'pass_with_notes')) as successful,
      ROUND(COUNT(*) FILTER (WHERE status = 'completed' AND verdict IN ('pass', 'pass_with_notes')) * 100.0 / NULLIF(COUNT(*), 0), 1) as success_rate,
      ROUND(AVG(duration_seconds) FILTER (WHERE status = 'completed'), 0) as avg_duration_sec
    FROM workflow_runs
    WHERE started_at > now() - INTERVAL '30 days'
    GROUP BY phase
    ORDER BY phase;
  `,

  /**
   * Most common error categories
   */
  errorCategories: `
    SELECT
      error_category,
      COUNT(*) as occurrences,
      ROUND(COUNT(*) * 100.0 / (SELECT COUNT(*) FROM workflow_runs WHERE error_category IS NOT NULL), 1) as percentage
    FROM workflow_runs
    WHERE error_category IS NOT NULL
      AND started_at > now() - INTERVAL '30 days'
    GROUP BY error_category
    ORDER BY occurrences DESC
    LIMIT 10;
  `,

  /**
   * Issues requiring most loop iterations
   */
  highIterationIssues: `
    SELECT
      issue_number,
      COUNT(*) as total_loop_runs,
      MAX(iteration_number) as max_iterations_used,
      COUNT(*) FILTER (WHERE verdict = 'pass') as eventually_passed
    FROM workflow_runs
    WHERE retry_type = 'loop'
      AND started_at > now() - INTERVAL '30 days'
    GROUP BY issue_number
    ORDER BY total_loop_runs DESC
    LIMIT 10;
  `,

  /**
   * /exec verification failure rate
   */
  execVerificationRate: `
    SELECT
      verification_result,
      COUNT(*) as occurrences,
      ROUND(COUNT(*) * 100.0 / (SELECT COUNT(*) FROM workflow_runs WHERE phase = 'exec' AND verification_result IS NOT NULL), 1) as percentage
    FROM workflow_runs
    WHERE phase = 'exec'
      AND verification_result IS NOT NULL
      AND started_at > now() - INTERVAL '30 days'
    GROUP BY verification_result
    ORDER BY occurrences DESC;
  `,

  /**
   * Average time to completion by issue labels
   */
  durationByLabel: `
    SELECT
      unnest(labels) as label,
      COUNT(*) as issues_with_label,
      ROUND(AVG(duration_seconds) FILTER (WHERE status = 'completed'), 0) as avg_duration_sec
    FROM workflow_runs
    WHERE phase = 'exec'
      AND status = 'completed'
      AND labels IS NOT NULL
      AND started_at > now() - INTERVAL '30 days'
    GROUP BY label
    HAVING COUNT(*) > 2
    ORDER BY avg_duration_sec DESC;
  `,

  /**
   * Daily workflow volume (trend analysis)
   */
  dailyVolume: `
    SELECT
      DATE(started_at) as date,
      COUNT(*) as total_runs,
      COUNT(*) FILTER (WHERE verdict IN ('pass', 'pass_with_notes')) as passed,
      COUNT(*) FILTER (WHERE verdict = 'fail') as failed
    FROM workflow_runs
    WHERE started_at > now() - INTERVAL '14 days'
    GROUP BY DATE(started_at)
    ORDER BY date DESC;
  `,
};

/**
 * Example usage in /reflect workflow:
 *
 * 1. Run the analysis script (preferred):
 *    npx tsx --env-file=.env.local scripts/dev/analyze-workflow-patterns.ts --days 7 --skip-issue-creation
 *
 * 2. Or run queries individually via Supabase MCP:
 *    mcp__supabase__execute_sql({ query: WORKFLOW_QUERIES.successRateByPhase })
 */

export function formatWorkflowReport(results: {
  successRates: Array<{
    phase: string;
    success_rate: number;
    total_runs: number;
  }>;
  errorCategories: Array<{ error_category: string; occurrences: number }>;
  highIterationIssues: Array<{
    issue_number: number;
    total_loop_runs: number;
    eventually_passed: number;
  }>;
}): string {
  const lines: string[] = [];

  lines.push("📊 Workflow Analysis (Last 7 days)");
  lines.push("");
  lines.push("Success Rates:");

  for (const row of results.successRates) {
    const passCount = Math.round((row.total_runs * row.success_rate) / 100);
    lines.push(
      `  /${row.phase}: ${row.success_rate}% (${passCount}/${row.total_runs})`,
    );
  }

  lines.push("");
  lines.push("Top Failure Categories:");

  for (let i = 0; i < Math.min(results.errorCategories.length, 5); i++) {
    const row = results.errorCategories[i];
    lines.push(
      `  ${i + 1}. ${row.error_category} (${row.occurrences} occurrences)`,
    );
  }

  lines.push("");
  lines.push("Issues Requiring Most Retries:");

  for (const row of results.highIterationIssues.slice(0, 5)) {
    const status = row.eventually_passed > 0 ? "passed" : "failed";
    lines.push(
      `  #${row.issue_number} - ${row.total_loop_runs} iterations (${status})`,
    );
  }

  return lines.join("\n");
}

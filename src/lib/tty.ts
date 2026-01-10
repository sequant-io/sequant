/**
 * TTY and CI detection utilities for non-interactive mode handling
 */

/**
 * Check if stdin is a TTY (terminal)
 */
export function isStdinTTY(): boolean {
  return Boolean(process.stdin.isTTY);
}

/**
 * Check if stdout is a TTY (terminal)
 */
export function isStdoutTTY(): boolean {
  return Boolean(process.stdout.isTTY);
}

/**
 * Common CI environment variables that indicate non-interactive mode
 */
const CI_ENV_VARS = [
  "CI",
  "CONTINUOUS_INTEGRATION",
  "GITHUB_ACTIONS",
  "GITLAB_CI",
  "CIRCLECI",
  "TRAVIS",
  "JENKINS_URL",
  "BUILDKITE",
  "DRONE",
  "TEAMCITY_VERSION",
  "TF_BUILD", // Azure DevOps
  "CODEBUILD_BUILD_ID", // AWS CodeBuild
];

/**
 * Check if running in a CI environment
 */
export function isCI(): boolean {
  return CI_ENV_VARS.some((envVar) => Boolean(process.env[envVar]));
}

/**
 * Determine if interactive mode should be used
 *
 * Interactive mode is used when:
 * 1. --interactive flag is passed (forceInteractive = true)
 * 2. OR (stdin is TTY AND stdout is TTY AND not in CI)
 *
 * @param forceInteractive - Whether --interactive flag was passed
 * @returns true if interactive prompts should be shown
 */
export function shouldUseInteractiveMode(forceInteractive?: boolean): boolean {
  if (forceInteractive) {
    return true;
  }

  // Non-interactive if any of these conditions are met
  if (!isStdinTTY() || !isStdoutTTY() || isCI()) {
    return false;
  }

  return true;
}

/**
 * Get a human-readable reason for non-interactive mode
 */
export function getNonInteractiveReason(): string | null {
  if (!isStdinTTY()) {
    return "stdin is not a terminal (piped input detected)";
  }
  if (!isStdoutTTY()) {
    return "stdout is not a terminal";
  }
  if (isCI()) {
    // Find which CI environment
    for (const envVar of CI_ENV_VARS) {
      if (process.env[envVar]) {
        const ciName = envVar.replace(/_/g, " ").toLowerCase();
        return `running in CI environment (${ciName})`;
      }
    }
    return "running in CI environment";
  }
  return null;
}

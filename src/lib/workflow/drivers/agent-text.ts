/**
 * Joining an agent's text messages into one `output` string (#1311).
 *
 * Every driver returns the agent's text as a single `output`, and the PR body
 * is built from the `## Summary` heading in it (`extractExecSummary`, whose
 * heading regex is anchored to a line start). Joining messages with `""`
 * glues a message that ends mid-line onto the next one — `"Now the edits."`
 * followed by `"## Summary\n…"` became `"Now the edits.## Summary"`, so the
 * heading was never found and the PR got the placeholder body.
 */

/** Append `text` to `acc`, inserting a newline when `acc` ends mid-line. */
export function appendAgentText(acc: string, text: string): string {
  if (acc.length > 0 && text.length > 0 && !acc.endsWith("\n")) {
    return `${acc}\n${text}`;
  }
  return acc + text;
}

/** Join separate agent text messages so each starts on its own line. */
export function joinAgentTexts(texts: readonly string[]): string {
  return texts.reduce(appendAgentText, "");
}

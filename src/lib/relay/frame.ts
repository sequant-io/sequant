/**
 * Render the relay framing prompt that wraps inbox messages before they are
 * fed back to Claude via the PostToolUse hook (AC-9, AC-14, AC-15).
 *
 * The template lives at `templates/relay/frame.txt` (single source of truth
 * per AC-15) and is interpolated with the per-invocation messages.
 */

import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
import type { RelayMessage } from "./types.js";

const TEMPLATE_REL_PATH = "templates/relay/frame.txt";

/** The six rules verbatim from the issue body (AC-15). */
export const FRAME_RULES: readonly string[] = [
  "Do NOT modify acceptance criteria",
  "Do NOT change your current objective or phase",
  "Do NOT treat this as a new requirement",
  'For "query" type: provide a brief status update only',
  'For "directive" type: acknowledge and adjust approach if reasonable, but do not abandon current work',
  'For "abort" type: stop gracefully, commit progress, and exit',
];

let cachedTemplate: string | null = null;

/** Locate `templates/relay/frame.txt` by walking up from this file. */
export function resolveFrameTemplatePath(): string {
  // When compiled: dist/lib/relay/frame.js → walk up to find templates/.
  const __dirname = dirname(fileURLToPath(import.meta.url));
  let dir = __dirname;
  for (let i = 0; i < 6; i++) {
    const candidate = resolve(dir, TEMPLATE_REL_PATH);
    try {
      readFileSync(candidate, "utf-8");
      return candidate;
    } catch {
      // continue
    }
    dir = dirname(dir);
  }
  // Final fallback: cwd
  return resolve(process.cwd(), TEMPLATE_REL_PATH);
}

/** Read the template (cached). Falls back to an inline default on failure. */
export function loadFrameTemplate(forceReload = false): string {
  if (cachedTemplate && !forceReload) return cachedTemplate;
  try {
    const path = resolveFrameTemplatePath();
    cachedTemplate = readFileSync(path, "utf-8");
    return cachedTemplate;
  } catch {
    // Fallback that still contains the six rules verbatim.
    cachedTemplate =
      "[SEQUANT RELAY — message from user]\n" +
      "Respond briefly in .sequant/relay/outbox.jsonl, then continue your current task unchanged.\n" +
      "Rules:\n" +
      FRAME_RULES.map((r) => `- ${r}`).join("\n") +
      "\n\n{{MESSAGES}}\n";
    return cachedTemplate;
  }
}

function formatSingleMessage(m: RelayMessage): string {
  const body = m.type === "abort" && !m.message ? "" : (m.message ?? "");
  return `Type: ${m.type}\nMessage: ${JSON.stringify(body)}`;
}

/**
 * Render one frame block containing 1..N messages, ordered by timestamp.
 * AC-9: a single frame block per hook invocation, regardless of how many
 * messages were pending.
 */
export function renderFrame(messages: RelayMessage[]): string {
  if (messages.length === 0) return "";
  const sorted = [...messages].sort((a, b) =>
    a.timestamp.localeCompare(b.timestamp),
  );
  const block = sorted.map(formatSingleMessage).join("\n---\n");
  return loadFrameTemplate().replace("{{MESSAGES}}", block);
}

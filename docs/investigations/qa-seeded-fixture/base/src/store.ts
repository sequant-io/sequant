import * as fs from "node:fs";

export interface Note {
  id: string;
  title: string;
  body: string;
  createdAt: string; // ISO-8601
}

/** Read the note store. Throws if the file is missing or is not valid JSON. */
export function readNotesFile(file: string): Note[] {
  const raw = fs.readFileSync(file, "utf-8");
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error(`${file}: expected a JSON array of notes`);
  }
  return parsed as Note[];
}

export type ExportKind = "json" | "md";

export function formatNotes(notes: Note[], kind: ExportKind): string {
  if (kind === "md") {
    return notes.map((n) => `## ${n.title}\n\n${n.body}\n`).join("\n");
  }
  return JSON.stringify(notes, null, 2);
}

export function notesSince(notes: Note[], since: Date): Note[] {
  return notes.filter((n) => new Date(n.createdAt) >= since);
}

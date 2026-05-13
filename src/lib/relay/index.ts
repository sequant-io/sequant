/**
 * Interactive relay (#383): file-based IPC between the user terminal and a
 * headless `sequant run` session. See `src/lib/relay/types.ts` for the wire
 * format and `templates/relay/frame.txt` for the framing prompt.
 */

export * from "./types.js";
export * from "./paths.js";
export * from "./writer.js";
export * from "./reader.js";
export * from "./frame.js";
export * from "./pid.js";
export * from "./archive.js";
export * from "./activation.js";

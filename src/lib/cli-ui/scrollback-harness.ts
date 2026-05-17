/**
 * Virtual-terminal harness for renderer regression tests (#647).
 *
 * The test stub embedded in TTYRenderer (see {@link
 * ./run-renderer.ts#TTYTestStub}) mocks `log-update` itself — it cannot reveal
 * whether the real `log-update` actually erases prior frames once the terminal
 * scrolls. That gap is what allowed #624's fix to ship green while the
 * underlying duplicate-header bug remained.
 *
 * This harness models a real terminal:
 *   - bounded visible viewport (rows × cols)
 *   - unbounded scrollback that captures every line that scrolls off the top
 *   - the ANSI escape vocabulary that `log-update@7` + `ansi-escapes`
 *     actually emit (cursor up/down/forward/back, eraseLine variants,
 *     SGR colour stripping, private mode set/reset, save/restore)
 *
 * With it, a test can wire the production renderer through a real
 * `createLogUpdate` instance, replay an event sequence, and assert on
 * `(visible + scrollback)` to catch any duplicate-header rendering — the
 * exact regression #647 was opened for.
 */

import { createLogUpdate } from "log-update";

const ESC = "";

export interface VirtualTerminalOptions {
  rows: number;
  cols: number;
  /** Newline mode. POSIX shells default to ONLCR which translates `\n` to
   *  `\r\n`, so most apps see "move down + col 0". Default true. */
  onlcr?: boolean;
}

/**
 * Minimal vt100 model: visible grid + scrollback + cursor. Strips SGR colour
 * codes (they're styling, not content) and ignores private-mode toggles
 * (cursor hide/show). Implements the cursor and erase escapes that
 * `log-update@7` actually emits.
 */
export class VirtualTerminal {
  readonly rows: number;
  readonly cols: number;
  private readonly onlcr: boolean;
  /** visible[row][col] = char (always single-codepoint slot). */
  visible: string[][];
  /** Scrollback grows oldest-first as rows shift off the top. */
  scrollback: string[] = [];
  cursorRow = 0;
  cursorCol = 0;

  constructor(opts: VirtualTerminalOptions) {
    this.rows = opts.rows;
    this.cols = opts.cols;
    this.onlcr = opts.onlcr ?? true;
    this.visible = Array.from({ length: this.rows }, () =>
      Array(this.cols).fill(" "),
    );
  }

  // ---------------------------------------------------------------- input

  write(text: string): void {
    let i = 0;
    while (i < text.length) {
      const ch = text[i];
      if (ch === ESC) {
        i = this.handleEscape(text, i);
        continue;
      }
      if (ch === "\n") {
        this.linefeed();
        i++;
        continue;
      }
      if (ch === "\r") {
        this.cursorCol = 0;
        i++;
        continue;
      }
      if (ch === "\b") {
        if (this.cursorCol > 0) this.cursorCol--;
        i++;
        continue;
      }
      this.putChar(ch);
      i++;
    }
  }

  // ---------------------------------------------------------------- output

  /** Visible viewport as a list of trimmed-right rows. */
  getVisibleLines(): string[] {
    return this.visible.map((row) => row.join("").replace(/\s+$/, ""));
  }

  /** Single multi-line string of (scrollback + visible). */
  getAllText(): string {
    const visibleText = this.getVisibleLines().join("\n");
    if (this.scrollback.length === 0) return visibleText;
    return this.scrollback.join("\n") + "\n" + visibleText;
  }

  /** Match count of the regex against (scrollback + visible). */
  countOccurrences(pattern: RegExp): number {
    const text = this.getAllText();
    const flags = pattern.flags.includes("g")
      ? pattern.flags
      : pattern.flags + "g";
    const globalPattern = new RegExp(pattern.source, flags);
    const matches = text.match(globalPattern);
    return matches?.length ?? 0;
  }

  // ------------------------------------------------------- internal: text

  private putChar(ch: string): void {
    if (this.cursorCol >= this.cols) {
      // Auto-wrap into the next row. Most terminals do this; log-update wraps
      // upstream so this rarely triggers in practice.
      this.cursorCol = 0;
      this.linefeed();
    }
    this.visible[this.cursorRow][this.cursorCol] = ch;
    this.cursorCol++;
  }

  private linefeed(): void {
    if (this.cursorRow + 1 < this.rows) {
      this.cursorRow++;
    } else {
      // Bottom of viewport: scroll the top row into scrollback.
      const top = this.visible.shift()!;
      this.scrollback.push(top.join("").replace(/\s+$/, ""));
      this.visible.push(Array(this.cols).fill(" "));
      // Cursor stays clamped at last visible row.
    }
    if (this.onlcr) this.cursorCol = 0;
  }

  // --------------------------------------------------- internal: escapes

  /** Returns the index AFTER the consumed escape sequence. */
  private handleEscape(text: string, start: number): number {
    // Bare ESC at end → consume.
    if (start + 1 >= text.length) return text.length;
    const next = text[start + 1];

    // CSI: ESC [ ... <final>
    if (next === "[") {
      return this.handleCSI(text, start + 2);
    }

    // OSC: ESC ] ... BEL or ESC \
    if (next === "]") {
      let i = start + 2;
      while (i < text.length) {
        if (text[i] === "") return i + 1;
        if (text[i] === ESC && text[i + 1] === "\\") return i + 2;
        i++;
      }
      return text.length;
    }

    // 2-byte non-CSI escapes: ESC 7 / ESC 8 (save/restore — cursor only,
    // safe to ignore for our uses).
    return start + 2;
  }

  private handleCSI(text: string, start: number): number {
    let i = start;
    let isPrivate = false;
    if (text[i] === "?" || text[i] === ">" || text[i] === "<") {
      isPrivate = true;
      i++;
    }
    let params = "";
    while (i < text.length && /[0-9;]/.test(text[i])) {
      params += text[i];
      i++;
    }
    if (i >= text.length) return text.length;
    const final = text[i];
    i++;
    this.executeCSI(params, final, isPrivate);
    return i;
  }

  private executeCSI(params: string, final: string, isPrivate: boolean): void {
    const parts =
      params.length === 0 ? [] : params.split(";").map((p) => parseInt(p, 10));
    const n = (idx: number, def: number): number => {
      const v = parts[idx];
      return v === undefined || isNaN(v) ? def : v;
    };

    // Private modes (e.g. ?25l/?25h cursor hide/show) — ignore.
    if (isPrivate) return;

    switch (final) {
      case "A": // cursor up
        this.cursorRow = Math.max(0, this.cursorRow - n(0, 1));
        return;
      case "B": // cursor down (no scroll)
        this.cursorRow = Math.min(this.rows - 1, this.cursorRow + n(0, 1));
        return;
      case "C": // cursor forward
        this.cursorCol = Math.min(this.cols - 1, this.cursorCol + n(0, 1));
        return;
      case "D": // cursor back
        this.cursorCol = Math.max(0, this.cursorCol - n(0, 1));
        return;
      case "E": // cursor next line
        this.cursorRow = Math.min(this.rows - 1, this.cursorRow + n(0, 1));
        this.cursorCol = 0;
        return;
      case "F": // cursor prev line
        this.cursorRow = Math.max(0, this.cursorRow - n(0, 1));
        this.cursorCol = 0;
        return;
      case "G": // cursor absolute column (1-based)
        this.cursorCol = Math.min(this.cols - 1, Math.max(0, n(0, 1) - 1));
        return;
      case "H": // cursor position (1-based row;col)
      case "f":
        this.cursorRow = Math.min(this.rows - 1, Math.max(0, n(0, 1) - 1));
        this.cursorCol = Math.min(this.cols - 1, Math.max(0, n(1, 1) - 1));
        return;
      case "J": {
        // erase in display
        const mode = n(0, 0);
        if (mode === 0) this.eraseFromCursorToEndOfScreen();
        else if (mode === 1) this.eraseFromStartOfScreenToCursor();
        else if (mode === 2 || mode === 3) this.eraseScreen();
        return;
      }
      case "K": {
        // erase in line
        const mode = n(0, 0);
        if (mode === 0) this.eraseFromCursorToEndOfLine();
        else if (mode === 1) this.eraseFromStartOfLineToCursor();
        else if (mode === 2) this.eraseLine();
        return;
      }
      case "S": // scroll up
      case "T": // scroll down
      case "m": // SGR colour — ignore (we don't model styling)
      case "s": // save cursor
      case "u": // restore cursor
      case "n": // device status report — ignore
      case "h": // set mode — ignore
      case "l": // reset mode — ignore
        return;
    }
  }

  private eraseLine(): void {
    for (let c = 0; c < this.cols; c++) this.visible[this.cursorRow][c] = " ";
  }

  private eraseFromCursorToEndOfLine(): void {
    for (let c = this.cursorCol; c < this.cols; c++)
      this.visible[this.cursorRow][c] = " ";
  }

  private eraseFromStartOfLineToCursor(): void {
    for (let c = 0; c <= this.cursorCol; c++)
      this.visible[this.cursorRow][c] = " ";
  }

  private eraseFromCursorToEndOfScreen(): void {
    this.eraseFromCursorToEndOfLine();
    for (let r = this.cursorRow + 1; r < this.rows; r++) {
      for (let c = 0; c < this.cols; c++) this.visible[r][c] = " ";
    }
  }

  private eraseFromStartOfScreenToCursor(): void {
    for (let r = 0; r < this.cursorRow; r++) {
      for (let c = 0; c < this.cols; c++) this.visible[r][c] = " ";
    }
    this.eraseFromStartOfLineToCursor();
  }

  private eraseScreen(): void {
    for (let r = 0; r < this.rows; r++) {
      for (let c = 0; c < this.cols; c++) this.visible[r][c] = " ";
    }
  }
}

/**
 * Bundle a VirtualTerminal with a real `log-update` instance writing into it
 * and a matching `stdoutWrite` for renderer event-line writes. Both paths hit
 * the same VT, mirroring real-terminal interleaving.
 *
 * Production runs frequently hit a width/height mismatch between what
 * `log-update` reads from `process.stdout` and what the real terminal actually
 * uses (e.g. `process.stdout.columns` is undefined under `npx` so log-update
 * falls back to 80 while the terminal is 200 cols). Those mismatches cause
 * `previousLineCount` to under- or over-count the rows log-update actually
 * wrote, breaking `eraseLines` and leaving stale rows in scrollback. The
 * `streamColumns` / `streamRows` overrides let tests reproduce this without
 * needing a real PTY.
 */
export interface TerminalHarness {
  vt: VirtualTerminal;
  logUpdate: ReturnType<typeof createLogUpdate>;
  stdoutWrite: (s: string) => void;
  /**
   * Out-of-band write that lands in the same VT as `logUpdate` and
   * `stdoutWrite` — mirrors how a real pty merges stderr writes with stdout
   * when both descriptors point at the same terminal. log-update has no
   * knowledge of these writes, so they advance the cursor in ways
   * `previousLineCount` cannot account for. Use this to reproduce the
   * Mechanism #2-class bug (out-of-band writes break log-update's cursor
   * model) that #647 AC-1 capture diagnosed.
   */
  stderrWrite: (s: string) => void;
}

export interface HarnessOptions extends VirtualTerminalOptions {
  /**
   * Width log-update is told about via `stream.columns`. Defaults to
   * `opts.cols` (matched terminal). Override to simulate a mismatch where
   * log-update wraps at one width but the real terminal wraps at another.
   */
  streamColumns?: number;
  /**
   * Height log-update is told about via `stream.rows`. Defaults to
   * `opts.rows`. Override to simulate `process.stdout.rows = undefined`
   * (the `npx` symptom): pass `undefined` explicitly via the harness's stream
   * by setting this to a non-positive number — log-update then falls through
   * to its internal `defaultHeight ?? 24`.
   */
  streamRows?: number;
}

export function createTerminalHarness(opts: HarnessOptions): TerminalHarness {
  const vt = new VirtualTerminal(opts);
  const stream = {
    write: (chunk: string): boolean => {
      vt.write(chunk);
      return true;
    },
    columns: opts.streamColumns ?? opts.cols,
    rows: opts.streamRows ?? opts.rows,
    isTTY: true,
  };
  // log-update reads `stream.columns` / `stream.rows` defensively; the cast is
  // safe because we exercise only those fields plus `write`.
  const lu = createLogUpdate(stream as unknown as NodeJS.WriteStream, {
    showCursor: true,
  });
  return {
    vt,
    logUpdate: lu,
    stdoutWrite: (s: string) => vt.write(s),
    stderrWrite: (s: string) => vt.write(s),
  };
}

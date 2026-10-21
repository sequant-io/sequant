/**
 * RingBuffer — fixed-capacity circular buffer for retaining the last N lines.
 *
 * Used by agent drivers to capture the tail of stderr/stdout without
 * unbounded memory growth.
 */

export class RingBuffer {
  private buffer: string[];
  private head = 0;
  private count = 0;
  private readonly capacity: number;
  private readonly maxLineChars: number | undefined;

  constructor(capacity: number, opts: { maxLineChars?: number } = {}) {
    this.capacity = capacity;
    this.buffer = new Array<string>(capacity);
    this.maxLineChars = opts.maxLineChars;
  }

  /**
   * Split a chunk into lines and push each non-empty one, capping any line
   * longer than `maxLineChars` as `<first N chars>… [<length> chars]`.
   */
  pushLines(text: string): void {
    const max = this.maxLineChars;
    for (const line of text.split("\n")) {
      if (line.length === 0) continue;
      this.push(
        max !== undefined && line.length > max
          ? `${line.slice(0, max)}… [${line.length} chars]`
          : line,
      );
    }
  }

  /** Push a line into the buffer, evicting the oldest if at capacity. */
  push(line: string): void {
    this.buffer[this.head] = line;
    this.head = (this.head + 1) % this.capacity;
    if (this.count < this.capacity) {
      this.count++;
    }
  }

  /** Return the stored lines in insertion order (oldest first). */
  getLines(): string[] {
    if (this.count === 0) return [];
    if (this.count < this.capacity) {
      return this.buffer.slice(0, this.count);
    }
    // Buffer is full — head points to the oldest entry
    return [
      ...this.buffer.slice(this.head),
      ...this.buffer.slice(0, this.head),
    ];
  }
}

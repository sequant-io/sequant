import { describe, it, expect } from "vitest";
import { RingBuffer } from "./ring-buffer.js";

describe("1472 RingBuffer.pushLines", () => {
  it("splits text on newlines and pushes each non-empty line", () => {
    const buffer = new RingBuffer(10);
    buffer.pushLines("a\n\nb\n");
    expect(buffer.getLines()).toEqual(["a", "b"]);
  });

  it("caps a line over maxLineChars in the drivers' pre-#1472 form", () => {
    const buffer = new RingBuffer(10, { maxLineChars: 2000 });
    buffer.pushLines(`${"x".repeat(2500)}\nshort`);
    // Byte-identical to the deleted driver-local pushLines:
    // `${line.slice(0, TAIL_LINE_CHARS)}… [${line.length} chars]`
    expect(buffer.getLines()).toEqual([
      `${"x".repeat(2000)}… [2500 chars]`,
      "short",
    ]);
  });

  it("keeps a line of exactly maxLineChars whole", () => {
    const buffer = new RingBuffer(10, { maxLineChars: 5 });
    buffer.pushLines("12345");
    expect(buffer.getLines()).toEqual(["12345"]);
  });

  it("evicts the oldest lines at capacity", () => {
    const buffer = new RingBuffer(2);
    buffer.pushLines("1\n2\n3");
    expect(buffer.getLines()).toEqual(["2", "3"]);
  });

  it("ignores empty and newline-only input", () => {
    const buffer = new RingBuffer(3);
    buffer.pushLines("");
    buffer.pushLines("\n\n");
    expect(buffer.getLines()).toEqual([]);
  });

  it("does not cap lines when maxLineChars is not configured", () => {
    const buffer = new RingBuffer(3);
    buffer.pushLines("y".repeat(5000));
    expect(buffer.getLines()).toEqual(["y".repeat(5000)]);
  });
});

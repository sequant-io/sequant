import { useEffect, useState, type JSX } from "react";
import { Text } from "ink";
import { SPINNER_FRAMES, type BorderColor } from "./theme.js";

/**
 * Braille spinner. Ticks at 10 Hz in its own component so the parent
 * issue box is not forced to re-render on each frame.
 */
export function Spinner({ color }: { color?: BorderColor }): JSX.Element {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    const id = setInterval(() => {
      setFrame((f) => (f + 1) % SPINNER_FRAMES.length);
    }, 100);
    return () => clearInterval(id);
  }, []);
  return <Text color={color}>{SPINNER_FRAMES[frame]}</Text>;
}

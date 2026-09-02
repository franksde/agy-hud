import stringWidth from "string-width";
import stripAnsi from "strip-ansi";

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export function strip(input: string): string {
  return stripAnsi(input);
}

export function visibleLen(input: string): number {
  return stringWidth(strip(input));
}

export function truncateColumns(input: string, width: number): string {
  let result = "";
  let columns = 0;
  for (const { segment } of graphemes.segment(strip(input))) {
    const next = visibleLen(segment);
    if (columns + next > width) break;
    result += segment;
    columns += next;
  }
  return result;
}

import stringWidth from "string-width";
import stripAnsi from "strip-ansi";
import emojiRegex from "emoji-regex";

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const emoji = emojiRegex();

export function strip(input: string): string {
  return stripAnsi(input);
}

export function visibleLen(input: string): number {
  // Keep the CJS/Node 18 width implementation, but use current emoji data and zero-width marks.
  const text = strip(input).replace(emoji, "  ").replace(/[\p{Mark}\p{Default_Ignorable_Code_Point}]/gu, "");
  return stringWidth(text);
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

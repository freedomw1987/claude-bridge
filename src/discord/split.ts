/**
 * Discord message splitting.
 *
 * Discord's hard limit is 2000 characters per message. We default to 1900 to
 * leave headroom for additions like "**(continued)**" suffixes, error tags,
 * or the header we prepend to the final summary.
 *
 * `splitForDiscord` prefers to break at semantic boundaries (paragraph → line
 * → word) so the resulting chunks stay readable. It only hard-cuts when no
 * boundary exists in the first 30% of `maxLen` (e.g. one giant unbroken word).
 */

export const DISCORD_MAX = 1900;

/**
 * Split a long string into Discord-friendly chunks, each ≤ maxLen characters.
 *
 * Strategy (first match wins):
 *   1. Last paragraph break (`\n\n`) within `maxLen`
 *   2. Last line break (`\n`) within `maxLen`
 *   3. Last space within `maxLen`
 *   4. Hard cut at `maxLen` (only when no good boundary found in the first
 *      30% of `maxLen`)
 *
 * Boundaries that are too close to the start of the buffer (< 50% of maxLen)
 * are skipped — that would create a near-empty first chunk.
 */
export function splitForDiscord(text: string, maxLen = DISCORD_MAX): string[] {
  if (text.length <= maxLen) return [text];
  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > maxLen) {
    let cut = remaining.lastIndexOf("\n\n", maxLen);
    if (cut < maxLen * 0.5) {
      cut = remaining.lastIndexOf("\n", maxLen);
    }
    if (cut < maxLen * 0.5) {
      cut = remaining.lastIndexOf(" ", maxLen);
    }
    if (cut < maxLen * 0.3) {
      cut = maxLen;
    }
    chunks.push(remaining.slice(0, cut).trimEnd());
    remaining = remaining.slice(cut).trimStart();
  }
  if (remaining.length > 0) chunks.push(remaining);
  return chunks;
}

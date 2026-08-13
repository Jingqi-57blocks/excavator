/**
 * Offset → 1-based line lookup over a single source file.
 *
 * Every parser here scans source text by character offset (balanced parens, quoted strings) and then
 * needs the human line number for provenance. Recomputing "count the newlines before offset N" per
 * lookup is O(n) each time; precomputing the newline positions once makes each lookup O(log n) and,
 * more importantly, keeps line numbers byte-stable regardless of how many lookups a parser makes.
 *
 * Pure and deterministic: constructed from the file text, no I/O, no state beyond the offset table.
 */

export class LineMap {
  /** `starts[k]` = byte offset at which the (k+1)-th line begins. Line 1 starts at offset 0. */
  private readonly starts: number[];

  constructor(content: string) {
    const starts = [0];
    for (let i = 0; i < content.length; i++) {
      if (content[i] === "\n") starts.push(i + 1);
    }
    this.starts = starts;
  }

  /** The 1-based line number containing byte offset `pos`. */
  lineAt(pos: number): number {
    const starts = this.starts;
    let lo = 0;
    let hi = starts.length - 1;
    let ans = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (starts[mid] <= pos) {
        ans = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return ans + 1;
  }
}

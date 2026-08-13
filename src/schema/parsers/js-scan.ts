/**
 * Quote/comment-aware scanning of JavaScript source, shared by the two Sequelize parsers.
 *
 * The Sequelize migration and model parsers do NOT run JS — they recover schema facts from the source
 * text. Doing that safely means never being fooled by braces, commas, or keywords that live inside a
 * string literal or a comment. These helpers walk raw source by character offset, skipping over string
 * literals (single, double, and template quotes) and line/block comments, so higher-level parsing
 * (find a call, split its arguments, read an object literal) operates only on real syntax.
 *
 * Every function is pure and returns byte offsets into the ORIGINAL content (callers pass a `base` so
 * offsets stay absolute), which the caller turns into line numbers via LineMap. No I/O, no npm deps.
 */

const OPENERS = new Set(["(", "{", "["]);
const CLOSERS = new Set([")", "}", "]"]);

/** `s[i]` is a quote (`'`, `"`, or backtick); return the index just past the closing quote. */
export function skipJsString(s: string, i: number): number {
  const q = s[i];
  i++;
  while (i < s.length) {
    const c = s[i];
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === q) return i + 1;
    i++;
  }
  return i;
}

/** `s[i]` is `/` beginning a line comment or a block comment; return the index just past the comment. */
export function skipJsComment(s: string, i: number): number {
  if (s[i + 1] === "/") {
    i += 2;
    while (i < s.length && s[i] !== "\n") i++;
    return i;
  }
  if (s[i + 1] === "*") {
    i += 2;
    while (i < s.length && !(s[i] === "*" && s[i + 1] === "/")) i++;
    return i + 2;
  }
  return i + 1;
}

/** `s[open]` is one of `( { [`; return the index just past its matching close, skipping strings/comments. */
export function scanBalanced(s: string, open: number): number {
  let depth = 0;
  let i = open;
  while (i < s.length) {
    const c = s[i];
    if (c === "'" || c === '"' || c === "`") {
      i = skipJsString(s, i);
      continue;
    }
    if (c === "/" && (s[i + 1] === "/" || s[i + 1] === "*")) {
      i = skipJsComment(s, i);
      continue;
    }
    if (OPENERS.has(c)) depth++;
    else if (CLOSERS.has(c)) {
      depth--;
      if (depth === 0) return i + 1;
    }
    i++;
  }
  return i;
}

/** A raw segment with the absolute file offset of its first character. */
export interface Segment {
  text: string;
  offset: number;
}

/** Split at commas sitting at bracket-depth 0 and outside strings/comments. Offsets are absolute (via `base`). */
export function splitArgs(s: string, base = 0): Segment[] {
  const out: Segment[] = [];
  let depth = 0;
  let start = 0;
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === "'" || c === '"' || c === "`") {
      i = skipJsString(s, i);
      continue;
    }
    if (c === "/" && (s[i + 1] === "/" || s[i + 1] === "*")) {
      i = skipJsComment(s, i);
      continue;
    }
    if (OPENERS.has(c)) depth++;
    else if (CLOSERS.has(c)) depth--;
    else if (c === "," && depth === 0) {
      out.push({ text: s.slice(start, i), offset: base + start });
      start = i + 1;
    }
    i++;
  }
  out.push({ text: s.slice(start), offset: base + start });
  return out;
}

/** One matched call: its regex capture groups plus the raw argument text and absolute offsets. */
export interface CallMatch {
  groups: (string | undefined)[];
  argsText: string;
  argsOffset: number;
  matchOffset: number;
}

/**
 * Find every call whose callee matches `re` (which MUST end with a literal `(`), returning the balanced
 * argument text for each. `base` makes the returned offsets absolute file offsets.
 */
export function findCalls(content: string, re: RegExp, base = 0): CallMatch[] {
  const out: CallMatch[] = [];
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    const parenIndex = m.index + m[0].length - 1;
    if (content[parenIndex] !== "(") continue;
    const end = scanBalanced(content, parenIndex);
    out.push({
      groups: m.slice(1),
      argsText: content.slice(parenIndex + 1, end - 1),
      argsOffset: base + parenIndex + 1,
      matchOffset: base + m.index,
    });
    re.lastIndex = end;
  }
  return out;
}

/** One `key: value` entry of an object literal, value kept as raw text, with absolute offsets. */
export interface ObjectEntry {
  key: string;
  valueText: string;
  keyOffset: number;
  valueOffset: number;
}

/** Parse a `{ key: value, … }` literal (keys bare or quoted; values kept verbatim). Non key:value items are skipped. */
export function parseObjectLiteral(full: string, base = 0): ObjectEntry[] {
  const open = full.indexOf("{");
  if (open < 0) return [];
  const innerEnd = scanBalanced(full, open) - 1;
  const inner = full.slice(open + 1, innerEnd);
  const innerBase = base + open + 1;
  const entries: ObjectEntry[] = [];
  for (const seg of splitArgs(inner, innerBase)) {
    const km = /^\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"|([A-Za-z_$][\w$]*))\s*:/.exec(seg.text);
    if (!km) continue; // spread / shorthand / empty — no column fact to read
    const key = km[1] ?? km[2] ?? km[3] ?? "";
    const value = seg.text.slice(km[0].length);
    const valueLead = value.length - value.trimStart().length;
    entries.push({
      key,
      valueText: value.trim(),
      keyOffset: seg.offset + (seg.text.length - seg.text.trimStart().length),
      valueOffset: seg.offset + km[0].length + valueLead,
    });
  }
  return entries;
}

/** Concatenate the contents of every string literal in `s` (handles `'a' + 'b'` joins); null if none. */
export function joinedStringLiteral(s: string): string | null {
  let out = "";
  let i = 0;
  let found = false;
  while (i < s.length) {
    const c = s[i];
    if (c === "'" || c === '"' || c === "`") {
      const end = skipJsString(s, i);
      out += unescapeJs(s.slice(i + 1, end - 1));
      found = true;
      i = end;
      continue;
    }
    i++;
  }
  return found ? out : null;
}

function unescapeJs(s: string): string {
  return s.replace(/\\(["'`\\nt])/g, (_, ch) => (ch === "n" ? "\n" : ch === "t" ? "\t" : ch));
}

/**
 * Isolate the VALUE region of a named object key (`up: …`, `up(…){…}`) — the whole function, whatever its
 * form: arrow block `(…) => { … }`, arrow expression `(…) => expr`, `function(…){…}`, or method shorthand.
 * Returns the value text and its absolute start offset. The region ends at the first `,` or `}` at the
 * enclosing object level, so extracting `up` leaves the sibling `down` (and its destructive dropTable
 * calls) entirely outside the returned text. Only the first match is returned.
 */
export function findFunctionBody(content: string, name: string): { body: string; bodyOffset: number } | null {
  const re = new RegExp("(?:^|[,{;\\s])" + name + "\\s*(:|\\()");
  const m = re.exec(content);
  if (!m) return null;
  const sep = m[0].slice(-1);
  // For `name:` start just after the colon; for method shorthand `name(` start at the '(' so its params/body scan.
  const start = sep === ":" ? m.index + m[0].length : m.index + m[0].length - 1;
  let depth = 0;
  let i = start;
  while (i < content.length) {
    const ch = content[i];
    if (ch === "'" || ch === '"' || ch === "`") {
      i = skipJsString(content, i);
      continue;
    }
    if (ch === "/" && (content[i + 1] === "/" || content[i + 1] === "*")) {
      i = skipJsComment(content, i);
      continue;
    }
    if (OPENERS.has(ch)) depth++;
    else if (CLOSERS.has(ch)) {
      if (depth === 0) break;
      depth--;
    } else if (ch === "," && depth === 0) break;
    i++;
  }
  return { body: content.slice(start, i), bodyOffset: start };
}

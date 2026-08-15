import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { AST_LANGUAGES, extractComparisons, warmExtractors } from "../src/assurance/condition-extract.ts";
import { inventoryConditions } from "../src/assurance/condition-inventory.ts";
import type { EvidenceItem } from "../src/core/types.ts";

// The extraction layer is the part an open-source parser does better than a regex. These tests pin the three
// things that motivated the swap: comments and string bodies must not be mistaken for code, string-literal
// comparisons must be visible at all, and a language with no grammar must degrade VISIBLY rather than look
// like a file with no rules.

function window(id: string, path: string, startLine: number, lines: string[]): EvidenceItem {
  return { id, snapshotId: "s", kind: "source", title: id, path, startLine, endLine: startLine + lines.length - 1, content: lines.join("\n"), reason: "r", digest: "d" };
}

test("the AST path ignores comparisons written inside comments and string bodies", () => {
  const go = window("S-go", "svc/leave/service.go", 500, [
    "package leave",
    "func f(lv Leave, msg string) {",
    "	// documented: lv.Hours > 99 never applies",
    "	msg = \"threshold lv.Hours > 88 reached\"",
    "	if lv.Hours > 16 { return }",
    "}",
  ]);
  const { sites, via } = extractComparisons(go);
  assert.equal(via, "ast", "a .go window must use the grammar, not the fallback");
  assert.deepEqual(sites.map((site) => `${site.field} ${site.operator} ${site.literal}`), ["lv.Hours > 16"]);
});

test("string-literal comparisons are extracted with their unquoted value", () => {
  const ts = window("S-ts", "web/src/view.ts", 10, [
    "export function f(repr: any) {",
    "  if (repr.view === 'open_positions') return 1;",
    "  if (repr.order == \"DESC\") return 2;",
    "  return 0;",
    "}",
  ]);
  const { sites, via } = extractComparisons(ts);
  assert.equal(via, "ast");
  const strings = sites.filter((site) => site.literalKind === "string");
  assert.deepEqual(strings.map((site) => `${site.field}=${site.literal}`).sort(), ["repr.order=DESC", "repr.view=open_positions"]);
});

test("a comparison against a variable is not a literal comparison", () => {
  const ts = window("S-var", "web/src/x.ts", 1, ["const f = (a: number, b: number) => a > b;"]);
  assert.deepEqual(extractComparisons(ts).sites, []);
});

test("a language with no grammar degrades to the numeric-only fallback, and says so", () => {
  const unknown = window("S-rb", "lib/leave.rb", 100, ["  return 1 if hours > 16", "  return 2 if type == 'sick'"]);
  const { sites, via } = extractComparisons(unknown);
  assert.equal(via, "regex", "a language with no grammar must be visible as degraded, not silent");
  assert.ok(sites.some((site) => site.literal === "16"), "numeric literals are still recovered");
  assert.equal(sites.filter((site) => site.literalKind === "string").length, 0, "string extraction is structural-only by design");
});

// The reason Perl needed its own backend: the fallback regex is not weaker on sigil syntax, it is inert.
// Its left-hand-side class admits neither `$`, `->` nor `{}`, so the window reads as "no rules here".
test("the regex fallback cannot see through Perl sigils at all — the reason for the second backend", () => {
  const sigils = window("S-sigil", "lib/ZMS/Leave.unknown", 100, ["  if ($lv->{hours} > 16) { return 1; }"]);
  const { sites, via } = extractComparisons(sigils);
  assert.equal(via, "regex");
  assert.deepEqual(sites, [], "not merely fewer sites — zero");
});

test("Perl goes through tree-sitter once warmed: sigils, arrows and string comparisons all resolve", async () => {
  await warmExtractors();
  const perl = window("S-pm", "lib/ZMS/Leave.pm", 100, [
    "sub check {",
    "  my ($lv, $type) = @_;",
    "  # documented: $lv->{hours} > 99 never applies",
    "  my $msg = 'threshold $lv->{hours} > 88 reached';",
    "  if ($lv->{hours} > 16) { return 1; }",
    "  if ($type eq 'sick') { return 2; }",
    "  if ($type ne \"annual\") { return 3; }",
    "  if ($type eq $other) { return 4; }",
    "  return 0;",
    "}",
  ]);
  const { sites, via } = extractComparisons(perl);
  assert.equal(via, "ast", "Perl is structural, not degraded");
  assert.deepEqual(sites.map((site) => `${site.field} ${site.operator} ${site.literal}`), [
    "$lv->{hours} > 16",
    "$type eq sick",
    "$type ne annual",
  ]);
  assert.equal(sites[0].line, 104, "line numbers are absolute within the file");
  assert.equal(sites.filter((site) => site.literalKind === "string").length, 2);
});

// The warm-up is the footgun of this design: a caller that forgets it gets regex, silently. It cannot be
// tested in-process (once warmed, there is no way back), so a child process pins the unwarmed contract —
// degraded, labelled, and NOT a crash. The same shape of mistake (ESM `require` swallowed by try/catch)
// already shipped once in this slice and was only visible through `via`.
test("without warm-up a Perl window degrades to regex, labelled and not crashing", () => {
  const script = `
    const { extractComparisons } = await import(${JSON.stringify(new URL("../src/assurance/condition-extract.ts", import.meta.url).href)});
    const result = extractComparisons({ id: "S", snapshotId: "s", kind: "source", title: "t", reason: "r", digest: "d",
      path: "lib/ZMS/Leave.pm", startLine: 1, endLine: 1, content: "  if ($lv->{hours} > 16) { return 1; }" });
    console.log(JSON.stringify({ via: result.via, sites: result.sites.length }));
  `;
  const child = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script], { encoding: "utf8" });
  assert.equal(child.status, 0, `child failed: ${child.stderr}`);
  assert.deepEqual(JSON.parse(child.stdout.trim().split("\n").pop() as string), { via: "regex", sites: 0 });
});

test("the AST language set is an enumerable fact", () => {
  assert.ok(AST_LANGUAGES.includes("go"));
  assert.ok(AST_LANGUAGES.includes("TypeScript"));
  assert.ok(AST_LANGUAGES.includes("Perl"));
  assert.ok(AST_LANGUAGES.length >= 5);
});

test("string comparisons regroup into the value set a field accepts", () => {
  const ts = window("S-family", "web/src/list.ts", 20, [
    "function pick(view: string) {",
    "  if (view === 'open_positions') return 1;",
    "  if (view === 'fulfilled_positions') return 2;",
    "  if (view === 'delayed_positions') return 3;",
    "  return 0;",
    "}",
  ]);
  const inventory = inventoryConditions([ts], []);
  const family = inventory.families.find((entry) => entry.field === "view");
  assert.ok(family, "the field must be grouped into one family, not three separate lines");
  assert.deepEqual(family.values, ["delayed_positions", "fulfilled_positions", "open_positions"]);
  assert.equal(family.status, "unaccounted");
  assert.equal(inventory.summary.stringSites, 3);
  assert.equal(inventory.summary.regexOnlySites, 0);
});

test("empty-string guards and typeof checks are filtered as the string analogue of 0/1 guards", () => {
  const ts = window("S-guards", "web/src/g.ts", 1, [
    "function f(loc: string, value: unknown, role: string) {",
    "  if (loc === '') return 1;",
    "  if (typeof value !== 'string') return 2;",
    "  if (role === 'admin') return 3;",
    "}",
  ]);
  const inventory = inventoryConditions([ts], []);
  assert.deepEqual(inventory.items.map((item) => item.expression), ['role === "admin"']);
});

test("a claim stating an enum value consumes it; the family then reports partial or consumed", () => {
  const ts = window("S-consume", "web/src/list.ts", 20, [
    "function pick(view: string) {",
    "  if (view === 'open_positions') return 1;",
    "  if (view === 'delayed_positions') return 2;",
    "}",
  ]);
  const partial = inventoryConditions([ts], [{ ref: "doc#c1", statement: "视图 open_positions 展示未关闭岗位。", evidenceIds: ["S-consume"] }]);
  assert.equal(partial.families[0].status, "partial");
  const full = inventoryConditions([ts], [{ ref: "doc#c1", statement: "视图取值为 open_positions 与 delayed_positions。", evidenceIds: ["S-consume"] }]);
  assert.equal(full.families[0].status, "consumed");
});

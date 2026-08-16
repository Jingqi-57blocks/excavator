import test from "node:test";
import assert from "node:assert/strict";
import { redactSecrets } from "../src/core/util.ts";

// REDACTION MUST NOT DESTROY THE EVIDENCE IT IS PROTECTING.
//
// Measured on a real run: this codebase names an ordinary business quantity `*Token` (hours already
// consumed), and `indexOf("=")` treated `+=`, `!=`, `>=`, `=>` and `:=` as assignments. The result was that
// the leave-balance arithmetic could not be cited at all — ten branches of the consumption function came out
// as `holiday.PtoToken += <redacted>`, `err != nil` was rewritten to `err != <redacted>` because the line
// mentioned `FuneralToken`, and `if x == "…"` was split through the operator into `if x =<redacted>`.
//
// Since audit re-derives the redacted window, the author had no way to quote the deciding values at all and
// had to write around them. For an engine whose whole claim is defensibility, that is worse than a miss: the
// reader cannot tell that something is missing.
//
// Narrowing is NOT a loosening of the secret surface, and the second half of this file is what holds that
// claim to account. An earlier attempt narrowed by OPERATOR and did leak — see the regression test below;
// the rule now splits by meaning (comparisons out, every assignment in) and narrows on the VALUE instead.

test("business arithmetic on a *Token field survives", () => {
  for (const line of [
    "\tholiday.PtoToken += hours",
    "\tholiday.FuneralToken -= used",
    "\toldHoursTem, token, err := calcHours(a, b)",
    "\tif holiday.FuneralToken > 0 && err != nil {",
    "\tif leftToken >= requested {",
    "const f = (token) => token.length",
  ]) {
    assert.equal(redactSecrets(line), line, line);
  }
});

test("a comparison is never cut through its own operator", () => {
  const line = "\tif apiToken == other {";
  assert.equal(redactSecrets(line), line);
  const redacted = redactSecrets("\tif apiToken == \"sk-live-abc123\" {");
  assert.doesNotMatch(redacted, /[!<>=]<redacted>/, "the value goes, the operator stays whole");
  assert.doesNotMatch(redacted, /sk-live-abc123/, "and the value really goes");
});

test("a Go short declaration keeps its operator", () => {
  const redacted = redactSecrets("\tapiToken := \"sk-live-abc123\"");
  assert.match(redacted, /:= <redacted>/, "the secret goes and `:=` survives intact");
  assert.doesNotMatch(redacted, /:<redacted>/, "the `=` is not eaten as a mapping colon");
});

// The other half of the contract. If any of these stopped being redacted, the narrowing above would have
// traded evidence for exposure — which is the one trade this change may not make.
test("a real credential is still redacted in every form the assignment path no longer claims", () => {
  for (const [line, why] of [
    ["\tconst apiToken = \"sk-live-abc123\"", "plain assignment"],
    ["\tapiKey += \"sk-live-abc123\"", "compound assignment"],
    ["\tapiToken := \"sk-live-abc123\"", "go short declaration"],
    ["\tif apiToken == \"sk-live-abc123\" {", "comparison"],
    ["\t\"client_secret\": \"sk-live-abc123\",", "mapping"],
    ["  api_key: sk-live-abc123", "yaml mapping"],
    ["API_KEY=abcd1234efgh", "env style"],
    ["\t{ \"client_secret\", \"sk-live-abc123\" }", "c# pair"],
  ] as const) {
    const redacted = redactSecrets(line);
    assert.match(redacted, /<redacted>/, `${why}: ${line}`);
    assert.doesNotMatch(redacted, /sk-live-abc123|abcd1234efgh/, `${why} leaked the value`);
  }
});

test("a sensitive NAME is still not enough on its own", () => {
  for (const line of [
    "\t\"wcp/internal/handlers/mcp_token\"",
    "\ttype HolidayToken struct {",
  ]) {
    assert.equal(redactSecrets(line), line, line);
  }
});

// A call is code, never key material. Found by this file's own first run: `const tokenService =
// require("./tokenService")` came out as `= <redacted>`, destroying an import — the same class of damage as
// the arithmetic above, reached through the plain-assignment path the operator fix does not touch.
test("a call expression is not a credential", () => {
  for (const line of [
    "\tconst tokenService = require(\"./tokenService\")",
    "\tconst token = await fetchToken(userId)",
    "\toldHoursTem, token, err := calcHours(a, b)",
    "\tconst client = new TokenClient(config)",
  ]) {
    assert.equal(redactSecrets(line), line, line);
  }
  // And a literal passed INSIDE a call is still judged on its own.
  assert.match(redactSecrets("\tconst t = login(\"sk-live-abc123\") // apiKey"), /<redacted>/);
});

// THE REGRESSION THIS FILE'S OWN PROBE CAUGHT, and the reason the rule is drawn by operator MEANING.
//
// A first attempt excluded compound assignments and `:=` from the assignment path outright, reasoning that
// the literal-level fallback would still cover them. It does — for QUOTED values. Unquoted ones leaked:
// `API_TOKEN := sk-live-abc123` (a Makefile) and `apiKey += sk-live-abc123` both stopped being redacted,
// which is the one trade this change may not make. Every assigning operator is therefore in; what separates
// business arithmetic from a credential is the VALUE, not the operator.
test("an unquoted credential is redacted whichever operator assigns it", () => {
  for (const line of [
    "API_TOKEN := sk-live-abc123",
    "\tapiKey += sk-live-abc123",
    "API_KEY=abcd1234efgh",
    "\tapi.secret = sk-live-abc123",
  ]) {
    const redacted = redactSecrets(line);
    assert.match(redacted, /<redacted>/, line);
    assert.doesNotMatch(redacted, /sk-live-abc123|abcd1234efgh/, `${line} leaked`);
  }
});

// The value-side distinction that lets both halves hold at once: a digit-free identifier names other code,
// while credential material almost always mixes digits in — the same test `isNameLikeLiteral` already
// applies to quoted names.
test("a digit-free identifier is a code reference; one with digits is not", () => {
  assert.equal(redactSecrets("\tholiday.PtoToken = hours"), "\tholiday.PtoToken = hours");
  assert.equal(redactSecrets("\tholiday.PtoToken += consumption"), "\tholiday.PtoToken += consumption");
  assert.match(redactSecrets("\tapiToken = abcd1234"), /<redacted>/, "digits revoke the exemption");
});

// A KNOWN LIMITATION, pinned rather than papered over. Redaction judges one line at a time, so whether a
// literal is redacted depends on whether ITS line mentions a sensitive name — which formatting decides.
// The same call, wrapped, gives different output. Recorded here so the inconsistency is a known property
// with a test naming it, not a surprise someone rediscovers inside a report.
test("line-scoped judgement makes formatting matter, and that is recorded not hidden", () => {
  const singleLine = "  const r = await svc.getTokenByType(userId, 'pto', year);";
  const wrapped = ["  const r = await svc.getTokenByType(", "    userId,", "    'pto',", "    year,", "  );"].join("\n");

  assert.match(redactSecrets(singleLine), /'<redacted>'/, "the sensitive method name makes its whole line sensitive");
  assert.match(redactSecrets(wrapped), /'pto'/, "wrapped, the literal's own line names nothing sensitive");
  // Fixing this needs a redactor that sees expressions rather than lines — a different design, not a tweak.
});

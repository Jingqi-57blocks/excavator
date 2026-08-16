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

// THE SECOND REGRESSION, found by review after the first rework: "no digits" is not enough to call a value
// a code reference. A word-form weak password is spelled exactly like an identifier, and every one of these
// was redacted before and passed through after. `isNameLikeLiteral` is safe because it requires no-digits
// AND the content being a sensitive NAME; dropping that second conjunct is what opened the hole.
test("a word-form password is not a code reference", () => {
  for (const line of [
    "PASSWORD=changeme",
    "DB_PASSWORD=swordfish",
    "db.password=changeme",
    "password = letmein",
    "password: changeme",
    "MYSQL_ROOT_PASSWORD: example",
    "API_KEY=deadbeef",
  ]) {
    const redacted = redactSecrets(line);
    assert.match(redacted, /<redacted>/, line);
    assert.doesNotMatch(redacted, /changeme|swordfish|letmein|example|deadbeef/, `${line} leaked`);
  }
});

// So the bare-identifier exemption is spent only where the OPERATOR already means "a running quantity":
// arithmetic accumulation, which a config file never uses to carry a secret.
test("a bare identifier is spared by arithmetic accumulation, not by plain assignment", () => {
  assert.equal(redactSecrets("\tholiday.PtoToken += consumption"), "\tholiday.PtoToken += consumption");
  assert.equal(redactSecrets("\tholiday.FuneralToken -= used"), "\tholiday.FuneralToken -= used");
  assert.match(redactSecrets("\tholiday.PtoToken = hours"), /<redacted>/,
    "plain assignment keeps the documented cost: `password = letmein` is the same text");
});

// Comparisons are back IN, because excluding them let shell password comparisons through — an independent
// channel from the one above, since these carry digits and the quoted-literal fallback never sees them.
test("an unquoted credential compared in a shell script is redacted, and a code comparison is not", () => {
  for (const line of ["if [ $PASSWORD != s3cr3tpass99 ]; then", "if [ \"$TOKEN\" == hunter2pass99 ]; then"]) {
    const redacted = redactSecrets(line);
    assert.match(redacted, /<redacted>/, line);
    assert.doesNotMatch(redacted, /s3cr3tpass99|hunter2pass99/, `${line} leaked`);
  }
  assert.equal(redactSecrets("\tif holiday.FuneralToken > 0 && err != nil {"), "\tif holiday.FuneralToken > 0 && err != nil {");
  assert.equal(redactSecrets("\tif leftToken >= requested {"), "\tif leftToken >= requested {");
});

// Two surfaces this rework introduced, attacked before review saw them.
//
// `=~` is Perl's binding operator. Reading it as an assignment destroyed `$token =~ s/a/b/` into
// `$token =<redacted>` — the same class of damage this whole slice exists to remove, on one of the target
// languages the engine explicitly supports.
test("Perl's binding operator is not an assignment", () => {
  assert.equal(redactSecrets("$token =~ s/a/b/"), "$token =~ s/a/b/");
  assert.equal(redactSecrets("\tif ($password =~ /^abc/) {"), "\tif ($password =~ /^abc/) {");
});

// Trimming a condition's closing syntax must require whitespace before it. Without that, `!= abc]` reads as
// an empty value and passes through — a leak created by the very code that fixed the comparison path.
test("condition-closing syntax is trimmed only when it is separate from the value", () => {
  for (const line of ["if [ $PASSWORD != abc]", "if(token==\"x\"){", "if [ $TOKEN != a]b ]; then"]) {
    assert.match(redactSecrets(line), /<redacted>/, line);
  }
  // And a real tail is still trimmed, so ordinary comparisons stay readable.
  assert.equal(redactSecrets("\tif leftToken >= requested {"), "\tif leftToken >= requested {");
  assert.equal(redactSecrets("if password != foo(bar) {"), "if password != foo(bar) {");
});

// The `:=` guard on the mapping branch had no test: a mutation disabling it left all nine green while
// `apiToken := hours` came out as `apiToken :<redacted>`, losing the `=`.
test("a Go short declaration is not read as a key: value mapping", () => {
  // The guard protects the OPERATOR, not the value: `:=` is not arithmetic, so a bare identifier is still
  // redacted there (a Makefile's `SECRET := changeme` has the same shape). What must not happen is the
  // colon being eaten as a mapping separator, which produced `apiToken :<redacted>` and lost the `=`.
  assert.match(redactSecrets("\tapiToken := hours"), /:= <redacted>/);
  assert.doesNotMatch(redactSecrets("\tapiToken := hours"), /:<redacted>/);
  assert.equal(redactSecrets("\tapiToken := calcHours(a)"), "\tapiToken := calcHours(a)", "a call is still exempt");
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

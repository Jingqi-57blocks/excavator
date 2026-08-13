import test from "node:test";
import assert from "node:assert/strict";
import { redactSecrets } from "../src/core/util.ts";

test("redaction reaches secrets that no assignment shape exposes", () => {
  const line = 'var p = new Dictionary<string,string> { { "client_secret", "0Cxq9-secretvalue-33" } };';
  const redacted = redactSecrets(line);
  assert.doesNotMatch(redacted, /0Cxq9-secretvalue-33/, "the value beside the sensitive name is redacted");
  assert.match(redacted, /\{ "client_secret", "<redacted>" \}/, "the name keeps its literal and the quotes survive");
});

test("redaction keeps covering the two assignment shapes", () => {
  assert.equal(redactSecrets("API_KEY=abcd1234"), "API_KEY=<redacted>");
  assert.equal(redactSecrets('"api_key": "sk-live-4242"'), '"api_key": <redacted>');
});

test("a sensitive word inside the value does not shield key material that carries digits", () => {
  assert.equal(redactSecrets('client_secret: "my-secret-2024"'), "client_secret: <redacted>");
  const pair = 'var p = new Dictionary<string,string> { { "client_secret", "sk-live-secret-4242" } };';
  const redacted = redactSecrets(pair);
  assert.doesNotMatch(redacted, /sk-live-secret-4242/);
  assert.match(redacted, /\{ "client_secret", "<redacted>" \}/, "the digitless name literal keeps its exemption");
});

test("redaction leaves values that are structure, types or names alone", () => {
  const preserved = [
    "mcpToken: {",
    "pto_token: DataTypes.FLOAT,",
    '  TbToken = "tb_token"',
    'const oauth2TokenEndpointGrantRefresh = "refresh_token";',
    "refresh_token_expires_in: 3600,"
  ];
  for (const line of preserved) assert.equal(redactSecrets(line), line, `must stay verbatim: ${line}`);
});

test("redaction never changes the line count of an excerpt", () => {
  const excerpt = [
    "public static class Auth {",
    '  private const string ClientSecret = "0Cxq9-secretvalue-33";',
    "  // token exchange",
    "",
    "  public static Dictionary<string, string> Body() => new() {",
    '    { "grant_type", "refresh_token" },',
    '    { "client_secret", "0Cxq9-secretvalue-33" }',
    "  };",
    "}"
  ].join("\n");
  const redacted = redactSecrets(excerpt);
  assert.equal(redacted.split("\n").length, excerpt.split("\n").length);
  assert.doesNotMatch(redacted, /0Cxq9-secretvalue-33/);
  // Here the sensitive word sits in the value position, so the fallback also blanks the
  // key beside it. Over-redaction is the accepted direction when the shape is ambiguous.
  assert.match(redacted, /\{ "<redacted>", "refresh_token" \}/);
});

test("redaction judges each quoted literal on a line independently", () => {
  const line = 'headers.Add("x-api-key", "live-4242-abcd", "client_secret", "0Cxq9-33");';
  assert.equal(redactSecrets(line), 'headers.Add("x-api-key", "<redacted>", "client_secret", "<redacted>");');
});

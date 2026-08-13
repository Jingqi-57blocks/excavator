import test from "node:test";
import assert from "node:assert/strict";
import { buildConstMap, resolveConstExpr } from "../src/schema/parsers/go-const-resolver.ts";

/** Build a `readFile` over an in-memory path→content map; throws on an unknown path. */
function readFrom(files: Record<string, string>): (path: string) => string {
  return (path) => {
    const content = files[path];
    if (content === undefined) throw new Error(`no such fixture file: ${path}`);
    return content;
  };
}

const CONST_FILE = `package constant

type TableName string

const (
	TbLv    TableName = "app_leave"
	TbLvDet TableName = "app_leave_detail"

	TbUpld   TableName = "app_upload_file"
	TbUpload TableName = "app_upload_file"
)

const TbSingle TableName = "app_single"

func (u TableName) String() string {
	return string(u)
}
`;

test("buildConstMap indexes grouped and single-line string consts with their declaration lines", () => {
  const map = buildConstMap(["constant/table.go"], readFrom({ "constant/table.go": CONST_FILE }));
  assert.deepEqual(map.get("TbLv"), { name: "TbLv", value: "app_leave", file: "constant/table.go", line: 6 });
  assert.deepEqual(map.get("TbLvDet"), { name: "TbLvDet", value: "app_leave_detail", file: "constant/table.go", line: 7 });
  assert.deepEqual(map.get("TbSingle"), { name: "TbSingle", value: "app_single", file: "constant/table.go", line: 13 });
});

test("duplicate consts with the same value are both indexed", () => {
  const map = buildConstMap(["constant/table.go"], readFrom({ "constant/table.go": CONST_FILE }));
  assert.equal(map.get("TbUpld")?.value, "app_upload_file");
  assert.equal(map.get("TbUpload")?.value, "app_upload_file");
});

test("resolveConstExpr strips a trailing stringer call and a package qualifier", () => {
  const map = buildConstMap(["constant/table.go"], readFrom({ "constant/table.go": CONST_FILE }));
  // Two-level indirection: `constant.TbLv.String()` → const TbLv → physical name.
  assert.equal(resolveConstExpr("constant.TbLv.String()", map)?.value, "app_leave");
  // Same-package reference and bare name both resolve.
  assert.equal(resolveConstExpr("TbLvDet.String()", map)?.value, "app_leave_detail");
  assert.equal(resolveConstExpr("TbSingle", map)?.value, "app_single");
});

test("resolveConstExpr returns null for unknown consts and for string literals", () => {
  const map = buildConstMap(["constant/table.go"], readFrom({ "constant/table.go": CONST_FILE }));
  assert.equal(resolveConstExpr("constant.TbMissing.String()", map), null);
  assert.equal(resolveConstExpr('"app_literal"', map), null);
  assert.equal(resolveConstExpr("computeName()", map), null);
});

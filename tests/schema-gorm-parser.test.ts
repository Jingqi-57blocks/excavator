import test from "node:test";
import assert from "node:assert/strict";
import { gormParser } from "../src/schema/parsers/gorm.ts";
import type { ColumnSchema } from "../src/schema/types.ts";

/** Build a `readFile` over an in-memory path→content map; throws on an unknown path. */
function readFrom(files: Record<string, string>): (path: string) => string {
  return (path) => {
    const content = files[path];
    if (content === undefined) throw new Error(`no such fixture file: ${path}`);
    return content;
  };
}

/** Parse the given in-memory files with the gorm parser. */
function parse(files: Record<string, string>) {
  return gormParser.parse(Object.keys(files), readFrom(files));
}

const CONST_FILE = `package constant

const (
	TbLv TableName = "app_leave"
)
`;

function col(columns: ColumnSchema[], name: string): ColumnSchema | undefined {
  return columns.find((c) => c.name === name);
}

test("columns, primaryKey, and not-null parse from gorm tags; TableName resolves a const two-level", () => {
  const model = `package model

type Leave struct {
	ID       uint64 \`gorm:"column:id;primary_key" json:"id"\`
	UserID   uint64 \`gorm:"column:user_id;not null" json:"user_id"\`
	Comments string \`gorm:"column:comments" json:"comments"\`
}

func (u *Leave) TableName() string {
	return constant.TbLv.String()
}
`;
  const { tables, warnings } = parse({ "constant.go": CONST_FILE, "leave.go": model });
  assert.equal(warnings.length, 0);
  assert.equal(tables.length, 1);
  const t = tables[0];
  assert.equal(t.name, "app_leave"); // resolved through constant.TbLv.String()
  assert.deepEqual(t.columns.map((c) => c.name), ["id", "user_id", "comments"]);
  assert.deepEqual(t.primaryKey, ["id"]);
  assert.equal(col(t.columns, "id")?.inPrimaryKey, true);
  // Go field type recorded verbatim in the "go" vocabulary — never converted to SQL.
  assert.equal(col(t.columns, "id")?.type, "uint64");
  assert.equal(col(t.columns, "id")?.typeVocabulary, "go");
  // `not null` → nullable:false; an undeclared column leaves nullable undefined (never fabricated).
  assert.equal(col(t.columns, "user_id")?.nullable, false);
  assert.equal(Object.prototype.hasOwnProperty.call(col(t.columns, "comments")!, "nullable"), false);
  // Provenance points back to the declaring struct field.
  assert.deepEqual(col(t.columns, "id")?.provenance, [{ sourceId: "gorm", file: "leave.go", line: 4, symbol: "ID" }]);
  assert.deepEqual(t.declarations, [{ sourceId: "gorm", file: "leave.go", line: 3, symbol: "Leave" }]);
});

test("TableName as a direct string literal resolves without any const", () => {
  const model = `package model

type Feed struct {
	ID uint64 \`gorm:"column:id;primary_key" json:"id"\`
}

func (u *Feed) TableName() string { return "app_project_feed" }
`;
  const { tables, warnings } = parse({ "feed.go": model });
  assert.equal(warnings.length, 0);
  assert.equal(tables.length, 1);
  assert.equal(tables[0].name, "app_project_feed");
});

test("embedded structs expand in place with provenance to their own source; unresolved embeds warn", () => {
  const base = `package cmon

type ICUModel struct {
	ID        uint64     \`gorm:"column:id;primary_key" json:"id"\`
	CreatedAt *time.Time \`gorm:"column:created_at" json:"created_at"\`
	UpdatedAt *time.Time \`gorm:"column:updated_at" json:"updated_at"\`
}
`;
  const model = `package model

type Policy struct {
	cmon.ICUModel
	Title string \`gorm:"column:title" json:"title"\`
	sql.NullThing
}

func (u *Policy) TableName() string { return "app_policy" }
`;
  const { tables, warnings } = parse({ "base.go": base, "policy.go": model });
  assert.equal(tables.length, 1);
  const t = tables[0];
  // Embedded columns land first, in embed order, then the struct's own fields.
  assert.deepEqual(t.columns.map((c) => c.name), ["id", "created_at", "updated_at", "title"]);
  assert.deepEqual(t.primaryKey, ["id"]);
  // Embedded column provenance points at the embedded struct's file, not the embedding struct's.
  assert.equal(col(t.columns, "id")?.provenance[0].file, "base.go");
  assert.equal(col(t.columns, "title")?.provenance[0].file, "policy.go");
  // The unresolvable embed is reported, not guessed.
  const embedWarn = warnings.find((w) => w.kind === "embedded-unresolved");
  assert.ok(embedWarn, "expected an embedded-unresolved warning");
  assert.match(embedWarn!.message, /sql\.NullThing/);
});

test('gorm:"-" is ignored; untagged exported fields are skipped with a warning; unexported are silent', () => {
  const model = `package model

type Thing struct {
	ID     uint64 \`gorm:"column:id;primary_key" json:"id"\`
	Secret string \`gorm:"-" json:"secret"\`
	Name   string \`json:"name"\`
	mutex  sync.Mutex
}

func (u *Thing) TableName() string { return "app_thing" }
`;
  const { tables, warnings } = parse({ "thing.go": model });
  assert.deepEqual(tables[0].columns.map((c) => c.name), ["id"]); // Secret ignored, Name/mutex not columns
  const untagged = warnings.filter((w) => w.kind === "untagged-field-skipped");
  assert.equal(untagged.length, 1);
  assert.match(untagged[0].message, /Name/);
});

test("foreignKey naming a Go field resolves to that field's column (belongs-to)", () => {
  const model = `package model

type Post struct {
	ID     uint64  \`gorm:"column:id;primary_key" json:"id"\`
	UserID uint64  \`gorm:"column:user_id" json:"user_id"\`
	User   *Author \`gorm:"foreignKey:UserID" json:"user"\`
}

func (u *Post) TableName() string { return "app_post" }
`;
  const { tables, relationships } = parse({ "post.go": model });
  // The association field is NOT emitted as a column.
  assert.deepEqual(tables[0].columns.map((c) => c.name), ["id", "user_id"]);
  assert.equal(relationships.length, 1);
  const r = relationships[0];
  assert.equal(r.kind, "belongs-to");
  assert.equal(r.fromTable, "app_post");
  assert.deepEqual(r.fromColumns, ["user_id"]); // resolved from field name UserID → column user_id
  assert.equal(r.toTable, "Author");
  assert.deepEqual(r.toColumns, []); // references not declared → not fabricated
  assert.deepEqual(r.provenance, [{ sourceId: "gorm", file: "post.go", line: 6, symbol: "User" }]);
});

test("full 5-key many2many and a slice has-many parse as relationships, not columns", () => {
  const model = `package model

type Doc struct {
	ID      uint64    \`gorm:"column:id;primary_key" json:"id"\`
	Offices []*Office \`gorm:"many2many:app_doc_office;foreignKey:id;joinForeignKey:doc_id;references:id;joinReferences:office_id" json:"offices"\`
	Details []Detail  \`gorm:"foreignKey:doc_id" json:"details"\`
}

func (u *Doc) TableName() string { return "app_doc" }
`;
  const { tables, relationships, warnings } = parse({ "doc.go": model });
  assert.equal(warnings.length, 0); // all 5 many2many keys are recognized, no malformed noise
  assert.deepEqual(tables[0].columns.map((c) => c.name), ["id"]);

  const m2m = relationships.find((r) => r.kind === "many-to-many");
  assert.ok(m2m);
  assert.equal(m2m!.joinTable, "app_doc_office");
  assert.equal(m2m!.fromTable, "app_doc");
  assert.deepEqual(m2m!.fromColumns, ["id"]); // foreignKey:id
  assert.deepEqual(m2m!.toColumns, ["id"]); // references:id
  assert.equal(m2m!.toTable, "Office");

  const hasMany = relationships.find((r) => r.kind === "has-many");
  assert.ok(hasMany);
  assert.equal(hasMany!.toTable, "Detail");
  assert.deepEqual(hasMany!.fromColumns, ["doc_id"]);
});

test("a malformed gorm tag (no key:value) is tolerated: no column, a warning, no crash", () => {
  const model = `package model

type Bad struct {
	ID       uint64 \`gorm:"column:id;primary_key" json:"id"\`
	SharerID uint64 \`gorm:"sharer_id" json:"sharer_id"\`
}

func (u *Bad) TableName() string { return "app_bad" }
`;
  const { tables, warnings } = parse({ "bad.go": model });
  assert.deepEqual(tables[0].columns.map((c) => c.name), ["id"]); // malformed field produced no column
  const malformed = warnings.filter((w) => w.kind === "malformed-tag");
  assert.equal(malformed.length, 1);
  assert.match(malformed[0].message, /sharer_id/);
});

test("an unresolved TableName const warns and skips the struct's table", () => {
  const model = `package model

type Ghost struct {
	ID uint64 \`gorm:"column:id;primary_key" json:"id"\`
}

func (u *Ghost) TableName() string { return constant.TbMissing.String() }
`;
  const { tables, warnings } = parse({ "ghost.go": model });
  assert.equal(tables.length, 0); // no fabricated table name
  const unresolved = warnings.filter((w) => w.kind === "table-name-unresolved");
  assert.equal(unresolved.length, 1);
  assert.match(unresolved[0].message, /Ghost/);
});

test("two structs resolving to the same table each emit their own TableSchema (PR1: no cross-struct merge)", () => {
  const model = `package model

type Leave struct {
	ID       uint64 \`gorm:"column:id;primary_key" json:"id"\`
	Category uint8  \`gorm:"column:category" json:"category"\`
}

func (u *Leave) TableName() string { return "app_leave" }

type LeaveDto struct {
	ID   uint64 \`gorm:"column:id;primary_key" json:"id"\`
	Name string \`gorm:"column:name" json:"name"\`
}

func (u *LeaveDto) TableName() string { return "app_leave" }
`;
  const { tables } = parse({ "leave.go": model });
  const leaveTables = tables.filter((t) => t.name === "app_leave");
  assert.equal(leaveTables.length, 2);
  assert.deepEqual(leaveTables.map((t) => t.declarations[0].symbol).sort(), ["Leave", "LeaveDto"]);
  // Each keeps its own columns — merge/canonicalization is deferred to a later step.
  assert.deepEqual(leaveTables.find((t) => t.declarations[0].symbol === "Leave")?.columns.map((c) => c.name), ["id", "category"]);
  assert.deepEqual(leaveTables.find((t) => t.declarations[0].symbol === "LeaveDto")?.columns.map((c) => c.name), ["id", "name"]);
});

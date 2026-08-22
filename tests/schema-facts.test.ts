import test from "node:test";
import assert from "node:assert/strict";
import { FILE_COMPLETENESS_BASIS, mechanismCoverageBasisName } from "../src/base/coverage-basis.ts";
import { factKindById } from "../src/base/fact-kind-registry.ts";
import {
  SCHEMA_FACTS_VERSION, schemaCompleteness, schemaConfigDigest, schemaEmptyYieldCause, schemaObservations,
  schemaSourceDetermination, type SchemaSourceCensus, type SchemaSourceDeterminationInput
} from "../src/schema/schema-facts.ts";
import type { SchemaExtraction, TableSchema } from "../src/schema/types.ts";

/**
 * The schema producer's pure half: what a recovered schema becomes, and which written state each kind of nothing
 * gets. The determination tree is the load-bearing part — "no table was found" and "this target declares no
 * table" are two different statements, and only the second one is a `NotApplicable`, so every arm below is a
 * different sentence rather than a different shade of empty.
 */

function table(name: string, overrides: Partial<TableSchema> = {}): TableSchema {
  return {
    name,
    columns: [{ name: "id", type: "INTEGER", typeVocabulary: "sequelize", inPrimaryKey: true, provenance: [] }],
    primaryKey: ["id"],
    uniqueKeys: [],
    declarations: [{ sourceId: "sequelize-migration", file: `migrations/create-${name}.js`, line: 4, symbol: name }],
    ...overrides
  };
}

function extraction(overrides: Partial<SchemaExtraction> = {}): SchemaExtraction {
  return {
    target: "/tmp/target",
    sources: [],
    tables: [],
    relationships: [],
    unsupported: [],
    warnings: [],
    ...overrides
  };
}

const CLEAN_SCAN = { capReached: false, skippedByCap: 0, droppedRoots: [] as readonly string[], readFailures: 0 };
const FULL_MATRIX = { covered: 12, noMechanism: 0, mechanismUnavailable: 0 };

function determinationInput(overrides: Partial<SchemaSourceDeterminationInput> = {}): SchemaSourceDeterminationInput {
  return {
    mechanismAvailable: true,
    mechanismUnavailableCause: null,
    sources: [],
    unsupported: [],
    ledgerCompleteness: CLEAN_SCAN,
    matrixTotals: FULL_MATRIX,
    mechanismCoverage: { declaration: { id: "db-schema" }, matrix: null, byLanguage: [] },
    ...overrides
  };
}

const PARSED: readonly SchemaSourceCensus[] = [{ format: "sequelize-migration", discovered: 2, parsed: 2 }];

test("every recovered table becomes one fact, anchored at the declaration closest to physical DDL", () => {
  const result = schemaObservations(extraction({
    tables: [
      table("leave_request", {
        declarations: [
          { sourceId: "sequelize-migration", file: "migrations/create-leave-request.js", line: 4, symbol: "leave_request" },
          { sourceId: "gorm", file: "internal/model/leave.go", line: 9, symbol: "LeaveRequest" }
        ]
      }),
      table("leave_balance", {
        declarations: [{ sourceId: "gorm", file: "internal/model/leave.go", line: 20, symbol: "LeaveBalance" }]
      })
    ]
  }));

  assert.deepEqual(result.facts.map((fact) => fact.factId), ["table:leave_request", "table:leave_balance"]);
  assert.deepEqual([...new Set(result.facts.map((fact) => fact.kind))], ["db-table"]);
  // One anchor, at the migration rather than the model: `mergeSchemas` orders declarations by authority.
  assert.deepEqual(result.facts[0]!.anchors, [
    { relativePath: "migrations/create-leave-request.js", startLine: 4, endLine: null, unitKind: null }
  ]);
  assert.equal(result.facts[0]!.detail["anchorSource"], "sequelize-migration");
  assert.equal(result.facts[0]!.detail["name"], "leave_request");
  assert.equal(result.facts[0]!.detail["declarations"], 2);
  assert.equal(result.facts[0]!.detail["declarationFiles"], 2);
  assert.equal(result.facts[0]!.detail["primaryKey"], "id");
  // A table declared twice seats on one cell; the other declaration is COUNTED, so the reach is visible.
  assert.equal(result.declarationsBeyondAnchor, 1);
  assert.deepEqual(result.tablesWithoutDeclaration, []);

  // The registered kind is the one the run wiring publishes, and its membership arm is the anchor-cell one.
  const entry = factKindById("db-table");
  assert.equal(entry.producer, "db-schema");
  assert.equal(entry.membershipKind, "unit");
  assert.equal(entry.seatRule, "anchor-cell");
  assert.equal(entry.structuralDeclaration, false, "a physical table is not a code unit declaration to normalise onto");
});

test("a table with no declaration is named, never silently dropped, and a duplicate name is refused", () => {
  const result = schemaObservations(extraction({
    tables: [table("leave_request"), table("orphan", { declarations: [] })]
  }));
  assert.deepEqual(result.facts.map((fact) => fact.factId), ["table:leave_request"]);
  assert.deepEqual(result.tablesWithoutDeclaration, ["orphan"], "an unanchored table is a counted bucket, not a silence");

  assert.throws(
    () => schemaObservations(extraction({ tables: [table("leave_request"), table("leave_request")] })),
    /holds table "leave_request" twice/,
    "two rows for one physical name would publish two facts under one id"
  );
});

test("the determination tree gives every kind of nothing its own written state", () => {
  const unavailableMechanism = schemaSourceDetermination(determinationInput({
    mechanismAvailable: false,
    mechanismUnavailableCause: "the ast-grep binding is missing"
  }));
  assert.equal(unavailableMechanism?.status, "unavailable");
  assert.match(unavailableMechanism?.status === "unavailable" ? unavailableMechanism.cause : "", /the ast-grep binding is missing/);

  // Located but unparseable. The bound is stated as "at least": the fingerprinter caps evidence at 20 per format.
  const unsupported = schemaSourceDetermination(determinationInput({ unsupported: [{ format: "Prisma", evidence: 3 }] }));
  assert.equal(unsupported?.status, "unavailable");
  assert.match(unsupported?.status === "unavailable" ? unsupported.cause : "", /no parser for \(at least Prisma 3 file\(s\)\), so the target's tables are known to exist/);

  assert.equal(schemaSourceDetermination(determinationInput({ sources: PARSED })), null, "a parseable source means proceed");
  assert.equal(
    schemaSourceDetermination(determinationInput({ sources: PARSED, unsupported: [{ format: "Prisma", evidence: 3 }] })),
    null,
    "and a target with BOTH a parseable source and an unparseable family still publishes the tables it can recover; the unreadable half travels on as unsupportedFormats, it does not veto the readable half"
  );

  const filteredAway = schemaSourceDetermination(determinationInput({
    sources: [{ format: "gorm", discovered: 4, parsed: 0 }]
  }));
  assert.equal(filteredAway?.status, "unavailable");
  assert.match(filteredAway?.status === "unavailable" ? filteredAway.cause : "", /fingerprinted \(gorm 4 file\(s\)\) but none of their files is a counted row/);

  const capped = schemaSourceDetermination(determinationInput({
    ledgerCompleteness: { capReached: true, skippedByCap: 12, droppedRoots: ["vendor"], readFailures: 1 }
  }));
  assert.equal(capped?.status, "unavailable");
  assert.match(capped?.status === "unavailable" ? capped.cause : "", /layer 1's scan was incomplete \(capReached true, skippedByCap 12, droppedRoots 1, readFailures 1\)/);

  const noMatrix = schemaSourceDetermination(determinationInput({ matrixTotals: null }));
  assert.equal(noMatrix?.status, "unavailable");
  assert.match(noMatrix?.status === "unavailable" ? noMatrix.cause : "", /publishes no file-coverage matrix for the db-schema mechanism/);

  const partial = schemaSourceDetermination(determinationInput({
    matrixTotals: { covered: 2, noMechanism: 3, mechanismUnavailable: 0 }
  }));
  assert.equal(partial?.status, "unavailable");
  assert.match(partial?.status === "unavailable" ? partial.cause : "", /covered only 2 of 5 counted file\(s\).*cannot be determined/);
});

test("not-detected is a determination, and it carries the two premises layer 8 re-resolves", () => {
  const verdict = schemaSourceDetermination(determinationInput());
  assert.equal(verdict?.status, "not-applicable");
  if (verdict?.status !== "not-applicable") return;
  assert.equal(verdict.determination, "not-detected");
  // These two names are exactly what `validateNotApplicable` demands of a not-detected envelope; dropping either
  // one makes the freeze audit report the producer, so they are asserted by name rather than by count.
  assert.deepEqual(verdict.basedOn, [FILE_COMPLETENESS_BASIS, mechanismCoverageBasisName("db-schema")]);

  // The digest pins the premises' VALUE, so a determination made under a different layer-2 record is a different
  // determination. Without this the premise would be a name with nothing behind it.
  const otherCoverage = schemaSourceDetermination(determinationInput({
    mechanismCoverage: { declaration: { id: "db-schema", version: "db-schema-v2" }, matrix: null, byLanguage: [] }
  }));
  assert.equal(otherCoverage?.status, "not-applicable");
  assert.notEqual(otherCoverage?.status === "not-applicable" ? otherCoverage.coverageDigest : "", verdict.coverageDigest);
});

test("a parse that read real sources and recovered no table says so, with the counts", () => {
  const parsed: readonly SchemaSourceCensus[] = [
    { format: "sequelize-migration", discovered: 293, parsed: 293 },
    { format: "gorm", discovered: 315, parsed: 300 }
  ];
  assert.match(schemaEmptyYieldCause(parsed, [], 7),
    /^593 schema source file\(s\) were parsed \(gorm 300, sequelize-migration 293\) and yielded no table, with 7 parser warning\(s\); the sources exist, so their tables are unrecovered rather than absent$/);

  // This is the ONE path with no `producerCompleteness` to carry `unsupportedFormats`, so the located-but-
  // unparseable half has to ride on the cause or it leaves no trace anywhere.
  assert.match(schemaEmptyYieldCause(parsed, [{ format: "Prisma", evidence: 2 }], 0),
    /; 1 further format\(s\) with no parser were located \(at least Prisma 2 file\(s\)\)$/);
});

test("the producer's identity carries its mode, and its completeness names what it did not publish", () => {
  const base = schemaConfigDigest({ sources: PARSED, extensions: [".go", ".js"] });
  assert.equal(schemaConfigDigest({ sources: PARSED, extensions: [".js", ".go"] }), base, "the extension set is a set, not an order");
  assert.notEqual(schemaConfigDigest({ sources: PARSED, extensions: [".go"] }), base, "which extensions the fingerprinter branches on is part of the mode");
  assert.notEqual(schemaConfigDigest({ sources: [{ format: "gorm", discovered: 2, parsed: 2 }], extensions: [".go", ".js"] }), base,
    "which formats were parsed, and how many of their files, is part of the mode");
  // The `discovered` count is NOT in it: the fingerprinter walks the target directory while layer 1's census may
  // have been capped, so a digest over it would move with files the run was told not to look at.
  assert.equal(schemaConfigDigest({ sources: [{ format: "sequelize-migration", discovered: 9000, parsed: 2 }], extensions: [".go", ".js"] }), base,
    "a file the census never counted may not move the producer's identity");
  assert.equal(SCHEMA_FACTS_VERSION, "schema-facts-v1");

  const recovered = extraction({
    tables: [table("leave_request")],
    relationships: [{ kind: "belongs-to", fromTable: "leave_request", fromColumns: ["employee_id"], toTable: "employee", toColumns: ["id"], provenance: [] }],
    warnings: [{ kind: "type-conflict", message: "x" }],
    engine: { name: "MySQL", confidence: "medium", evidence: [], alternatives: [] }
  });
  const completeness = schemaCompleteness({
    extraction: recovered,
    observations: schemaObservations(recovered),
    sources: PARSED,
    unsupported: [{ format: "Prisma", evidence: 2 }],
    filesOutsideLedger: 5
  });
  assert.equal(completeness["tables"], 1);
  // v1 publishes tables only. The relationships it recovered and did NOT publish are a named row, so nobody
  // reads "the schema producer sees no foreign key" out of their absence.
  assert.equal(completeness["relationshipsNotPublishedAsFacts"], 1);
  assert.equal(completeness["filesOutsideLedger"], 5);
  assert.equal(completeness["unsupportedFormats"], "Prisma");
  assert.equal(completeness["unsupportedEvidenceRows"], 2);
  assert.equal(completeness["engine"], "MySQL");
  assert.equal(completeness["engineConfidence"], "medium");
  assert.equal(completeness["formats"], "sequelize-migration");
  assert.equal(completeness["warnings"], 1);
});

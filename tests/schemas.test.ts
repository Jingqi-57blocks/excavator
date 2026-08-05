import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { ErrorObject, ValidateFunction } from "ajv";
import type { EvidenceItem, ReportRequest, SectionClaim } from "../src/types.ts";
import { prepareRun } from "../src/run.ts";
import { copyFixture, createCodeGraphFixture, tempDir } from "./helpers.ts";

const schemaDir = resolve("schemas");
const exampleDir = join(schemaDir, "examples");
const artifactSchemas = ["evidence", "finding", "claim", "coverage"] as const;
type ArtifactSchema = (typeof artifactSchemas)[number];

interface ManifestEntry {
  file: string;
  schema: ArtifactSchema;
  valid: boolean;
  errorPathIncludes?: string;
}

async function readJson(path: string): Promise<any> {
  return JSON.parse(await readFile(path, "utf8"));
}

async function compileValidators(): Promise<{ ajv: Ajv2020; validators: Map<ArtifactSchema, ValidateFunction> }> {
  // strictRequired is the one strict check that rejects the `not` + `required` idiom the
  // sufficiency payload uses to forbid a single total score; everything else stays strict.
  const ajv = new Ajv2020({ strict: true, strictRequired: false, allErrors: true });
  ajv.addSchema(await readJson(join(schemaDir, "common.schema.json")));
  const validators = new Map<ArtifactSchema, ValidateFunction>();
  for (const name of artifactSchemas) validators.set(name, ajv.compile(await readJson(join(schemaDir, `${name}.schema.json`))));
  return { ajv, validators };
}

// The manifest matches `errorPathIncludes` against this rendering, so a fragment may name
// an instance path, a keyword, a message, or any contiguous combination of the three.
function renderError(error: ErrorObject): string {
  return `${error.instancePath} ${error.keyword} ${error.message}`;
}

function renderErrors(errors: ErrorObject[] | null | undefined): string {
  return (errors ?? []).map(renderError).join("\n");
}

test("the five v1 schemas compile as JSON Schema 2020-12", async () => {
  const { ajv, validators } = await compileValidators();
  assert.ok(ajv.getSchema("https://excavator.57blocks.dev/schemas/v1/common.schema.json"), "common.schema.json is not registered for $ref resolution");
  assert.equal(validators.size, artifactSchemas.length);
  for (const name of artifactSchemas) assert.equal(typeof validators.get(name), "function");
});

test("every example artifact matches its manifest verdict", async () => {
  const { validators } = await compileValidators();
  const manifest = (await readJson(join(exampleDir, "manifest.json"))) as ManifestEntry[];
  assert.ok(manifest.filter((entry) => entry.valid).length >= 8);
  assert.ok(manifest.filter((entry) => !entry.valid).length >= 8);

  for (const entry of manifest) {
    const validate = validators.get(entry.schema);
    assert.ok(validate, `manifest names an unknown schema: ${entry.schema}`);
    const instance = await readJson(join(exampleDir, entry.file));
    const ok = validate(instance);
    if (entry.valid) {
      assert.equal(ok, true, `${entry.file} should validate but failed:\n${renderErrors(validate.errors)}`);
      continue;
    }
    assert.equal(ok, false, `${entry.file} should fail validation but passed`);
    assert.ok(entry.errorPathIncludes, `${entry.file} must declare errorPathIncludes`);
    const rendered = renderErrors(validate.errors);
    assert.ok(
      (validate.errors ?? []).some((error) => renderError(error).includes(entry.errorPathIncludes!)),
      `${entry.file} failed for the wrong reason; expected an error containing "${entry.errorPathIncludes}" but got:\n${rendered}`
    );
  }
});

async function prepareSampleRun(): Promise<string> {
  const target = await copyFixture();
  const workdir = await tempDir();
  const codegraph = join(workdir, "codegraph.db");
  createCodeGraphFixture(codegraph);
  const request: ReportRequest = {
    target,
    codegraph,
    workdir,
    language: "zh-CN",
    detailLevel: "standard",
    overviewAudiences: ["product"],
    features: [{ subject: "请假管理", aliases: ["leave", "holiday"], audiences: ["product"] }],
    budgets: { prepareMs: 30_000, authorMs: 30_000, maxGraphQueries: 60, maxSourceWindows: 50, maxSourceCharacters: 120_000, maxFiles: 10_000, maxFeatureNodes: 60, maxExpansionDepth: 2 }
  };
  const { runDir } = await prepareRun(request);
  return runDir;
}

// Rehearsal-only mappers: they show that today's run artifacts can reach the v1 contract.
// The production derivation lands in Phase 1A, not here.
function toContractEvidence(item: EvidenceItem): Record<string, unknown> {
  const mapped: Record<string, unknown> = {
    id: item.id,
    schemaVersion: 1,
    snapshotId: item.snapshotId,
    kind: item.kind,
    reason: item.reason,
    digest: item.digest,
    provider: item.kind === "graph" ? "codegraph" : "source"
  };
  if (item.title !== undefined) mapped.title = item.title;
  if (item.path !== undefined) mapped.path = item.path;
  if (item.startLine !== undefined) mapped.startLine = item.startLine;
  if (item.endLine !== undefined) mapped.endLine = item.endLine;
  if (item.content !== undefined) mapped.content = item.content;
  return mapped;
}

function toContractClaim(claim: SectionClaim, documentId: string, section: number): Record<string, unknown> {
  const mapped: Record<string, unknown> = {
    id: claim.id,
    schemaVersion: 1,
    statement: claim.statement,
    marker: claim.marker,
    documentId,
    section
  };
  if (claim.evidenceIds !== undefined) mapped.evidenceIds = claim.evidenceIds;
  if (claim.reason !== undefined) mapped.reason = claim.reason;
  return mapped;
}

test("real run artifacts map onto the v1 evidence and claim contracts", async () => {
  const { validators } = await compileValidators();
  const validateEvidence = validators.get("evidence")!;
  const validateClaim = validators.get("claim")!;

  const runDir = await prepareSampleRun();
  const catalog = (await readJson(join(runDir, "evidence.json"))) as { evidence: EvidenceItem[] };

  // Deterministic sample covering both provider derivations. Feature-scope graph evidence is
  // left out on purpose: its id embeds the feature subject verbatim, so a non-ASCII subject
  // produces an id that the v1 artifactId pattern rejects and Phase 1A must normalize.
  const graphItem = catalog.evidence.find((item) => item.kind === "graph" && item.id.startsWith("CG-"));
  const sourceItems = catalog.evidence.filter((item) => item.kind === "source").slice(0, 2);
  const sample = [graphItem, ...sourceItems].filter((item): item is EvidenceItem => Boolean(item));
  assert.ok(sample.length >= 3, `expected at least three mappable evidence items, got ${sample.length}`);

  for (const item of sample) {
    const mapped = toContractEvidence(item);
    assert.equal(validateEvidence(mapped), true, `${item.id} failed the evidence contract:\n${renderErrors(validateEvidence.errors)}`);
  }
  assert.equal(sample.filter((item) => item.kind === "source").length, 2);
  assert.equal(toContractEvidence(sample[0]).provider, "codegraph");
  assert.equal(toContractEvidence(sample[1]).provider, "source");

  const sectionClaim: SectionClaim = {
    id: "claim-3-fact",
    marker: "fact",
    statement: "The leave listing route is guarded by requireManager.",
    evidenceIds: [sourceItems[0].id]
  };
  const mappedClaim = toContractClaim(sectionClaim, "product-overview", 3);
  assert.equal(validateClaim(mappedClaim), true, `mapped claim failed the claim contract:\n${renderErrors(validateClaim.errors)}`);
});

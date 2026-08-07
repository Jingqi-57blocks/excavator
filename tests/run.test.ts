import test from "node:test";
import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { readFile, writeFile, readdir } from "node:fs/promises";
import type { EvidenceItem, ReportRequest, SectionClaim } from "../src/types.ts";
import { assembleRun, auditRun, checkpointSection, prepareRun, resumeRun, searchSourceEvidence, updateChecklist } from "../src/run.ts";
import { copyFixture, createCodeGraphFixture, tempDir } from "./helpers.ts";

async function makeRequest(authorMs = 30_000): Promise<ReportRequest> {
  const target = await copyFixture();
  const workdir = await tempDir();
  const db = join(workdir, "codegraph.db");
  createCodeGraphFixture(db);
  return {
    target, codegraph: db, workdir, language: "zh-CN", detailLevel: "standard",
    detailLevel: "standard",
    overviewAudiences: ["product", "engineering"],
    features: [
      { subject: "请假管理", aliases: ["leave", "holiday"], audiences: ["product", "engineering"] },
      { subject: "审批", aliases: ["approve", "manager"], audiences: ["product"] }
    ],
    budgets: { prepareMs: 30_000, authorMs, maxGraphQueries: 60, maxSourceWindows: 50, maxSourceCharacters: 120_000, maxFiles: 10_000, maxFeatureNodes: 60, maxExpansionDepth: 2 }
  };
}

function sectionText(title: string, index: number, evidenceId: string): string {
  return `## ${title}\n\n这是第 ${index} 章的当前状态说明。\`事实\`\n\n**这意味着什么** 本章事实帮助读者理解后续内容。\`推断\`\n\n<details>\n<summary>依据</summary>\n\n- ${evidenceId}\n\n</details>\n`;
}

function sectionClaims(index: number, evidenceId: string): SectionClaim[] {
  return [
    { id: `claim-${index}-fact`, marker: "fact", statement: `这是第 ${index} 章的当前状态说明。`, evidenceIds: [evidenceId] },
    { id: `claim-${index}-meaning`, marker: "inferred", statement: "本章事实帮助读者理解后续内容。", evidenceIds: [evidenceId] }
  ];
}

async function evidenceId(runDir: string): Promise<string> {
  const catalog = JSON.parse(await readFile(join(runDir, "evidence.json"), "utf8")) as { evidence: EvidenceItem[] };
  return catalog.evidence.find((item) => item.kind === "source")?.id ?? catalog.evidence[0].id;
}

async function dispositionChecklist(runDir: string, _id: string): Promise<void> {
  const receipt = await searchSourceEvidence(runDir, ["__excavator_no_such_fixture_marker__"], "prove the synthetic hypothesis search completed", { maxResults: 10 });
  const searchId = String((receipt.evidence as EvidenceItem).id);
  const checklist = JSON.parse(await readFile(join(runDir, "checklist.json"), "utf8")) as { items: Array<{ id: string }> };
  await updateChecklist(runDir, checklist.items.map((item) => ({
    id: item.id,
    verdict: "searched-not-found" as const,
    material: false,
    evidenceIds: [searchId],
    searchScope: "all candidate source files in the immutable synthetic fixture snapshot"
  })));
}

async function completeRun(runDir: string, manifest: Awaited<ReturnType<typeof prepareRun>>["manifest"]): Promise<string> {
  const id = await evidenceId(runDir);
  for (const document of manifest.documents) {
    for (const section of document.sections) {
      await checkpointSection(runDir, document.id, section.index, sectionText(section.title, section.index, id), sectionClaims(section.index, id));
    }
  }
  await dispositionChecklist(runDir, id);
  await assembleRun(runDir);
  return id;
}

test("a combined run supports multiple overviews and multiple features with complete assurance metadata", async () => {
  const request = await makeRequest();
  const { runDir, manifest } = await prepareRun(request);
  assert.equal(manifest.documents.length, 5);
  await completeRun(runDir, manifest);
  const audit = await auditRun(runDir);
  assert.equal(audit.findings.filter((item) => item.level === "error").length, 0, JSON.stringify(audit.findings, null, 2));
  assert.equal(audit.manifest.state, "complete");
  const report = await readFile(join(runDir, "reports", "product-overview.md"), "utf8");
  assert.match(report, /kind: overview/);
  assert.match(report, /## 1\. Project purpose and boundary/);
});


test("repeated preparation creates isolated run directories while reusing caches", async () => {
  const request = await makeRequest();
  request.overviewAudiences = ["product"];
  request.features = [];
  const first = await prepareRun(request);
  const second = await prepareRun(request);
  assert.notEqual(first.runDir, second.runDir);
  assert.equal(second.manifest.metrics.graphQueries, 0);
  assert.equal(second.manifest.metrics.sourceWindows, 0);
});

test("audit fails when claims and checklist dispositions are missing", async () => {
  const request = await makeRequest();
  request.overviewAudiences = ["product"];
  request.features = [];
  const { runDir, manifest } = await prepareRun(request);
  const id = await evidenceId(runDir);
  const document = manifest.documents[0];
  for (const section of document.sections) await checkpointSection(runDir, document.id, section.index, sectionText(section.title, section.index, id));
  await assembleRun(runDir);
  const audit = await auditRun(runDir);
  assert.ok(audit.findings.some((item) => /no claims file/i.test(item.message)));
  assert.ok(audit.findings.some((item) => /not dispositioned/i.test(item.message)));
  assert.equal(audit.manifest.state, "audited");
});

test("audit rejects an invalid source range even when its evidence id exists", async () => {
  const request = await makeRequest();
  request.overviewAudiences = ["product"];
  request.features = [];
  const { runDir, manifest } = await prepareRun(request);
  await completeRun(runDir, manifest);
  const evidencePath = join(runDir, "evidence.json");
  const catalog = JSON.parse(await readFile(evidencePath, "utf8")) as { evidence: EvidenceItem[] };
  const source = catalog.evidence.find((item) => item.kind === "source");
  assert.ok(source);
  source.endLine = 999_999;
  await writeFile(evidencePath, JSON.stringify(catalog, null, 2));
  const audit = await auditRun(runDir);
  assert.ok(audit.findings.some((item) => /invalid source range/i.test(item.message)));
});

test("audit rejects stale source evidence after the target changes", async () => {
  const request = await makeRequest();
  request.overviewAudiences = ["product"];
  request.features = [];
  const { runDir, manifest } = await prepareRun(request);
  await completeRun(runDir, manifest);
  await writeFile(join(request.target, "src", "server.ts"), "export const changed = true;\n");
  const audit = await auditRun(runDir);
  assert.ok(audit.findings.some((item) => /snapshot changed|stale|does not match/i.test(item.message)));
});

test("author timeout stops after saving the checkpointed section and can resume", async () => {
  const request = await makeRequest(5);
  request.overviewAudiences = ["product"];
  request.features = [];
  const { runDir, manifest } = await prepareRun(request);
  const document = manifest.documents[0];
  const id = await evidenceId(runDir);
  await checkpointSection(runDir, document.id, 1, sectionText(document.sections[0].title, 1, id), sectionClaims(1, id));
  await new Promise((resolve) => setTimeout(resolve, 15));
  await assert.rejects(() => checkpointSection(runDir, document.id, 2, sectionText(document.sections[1].title, 2, id), sectionClaims(2, id)), /timeout/i);
  const resumed = await resumeRun(runDir);
  assert.equal(resumed.next[0].section, 3, "the timed-out section was saved, so resume continues after it");
  assert.equal(resumed.manifest.state, "authoring");
});

test("a timed-out checkpoint keeps the section it was given and resumes from the next one", async () => {
  const request = await makeRequest(5);
  request.overviewAudiences = ["product"];
  request.features = [];
  const { runDir, manifest } = await prepareRun(request);
  const document = manifest.documents[0];
  const id = await evidenceId(runDir);
  await checkpointSection(runDir, document.id, 1, sectionText(document.sections[0].title, 1, id), sectionClaims(1, id));
  await new Promise((resolve) => setTimeout(resolve, 15));
  await assert.rejects(
    () => checkpointSection(runDir, document.id, 2, sectionText(document.sections[1].title, 2, id), sectionClaims(2, id)),
    /Authoring timeout for .* after saving section 2/
  );

  const saved = await readFile(document.sections[1].file, "utf8");
  assert.match(saved, /第 2 章/, "the content handed to the timed-out checkpoint must survive");
  assert.ok(JSON.parse(await readFile(document.sections[1].claimsFile, "utf8")).claims.length > 0);

  const persisted = JSON.parse(await readFile(join(runDir, "run.json"), "utf8")) as RunManifest;
  assert.equal(persisted.state, "timed-out");
  assert.equal(persisted.documents[0].sections[1].complete, true);
  assert.ok(persisted.metrics.warnings.some((warning) => /section 2 was saved before stopping/.test(warning)));
  const diagnostics = JSON.parse(await readFile(join(runDir, "audit", `${document.id}-timeout.json`), "utf8"));
  assert.equal(diagnostics.stoppedAfterSection, 2);

  const resumed = await resumeRun(runDir);
  assert.equal(resumed.manifest.state, "authoring");
  assert.equal(resumed.next[0].section, 3);
  await checkpointSection(runDir, document.id, 3, sectionText(document.sections[2].title, 3, id), sectionClaims(3, id));
  const afterResume = JSON.parse(await readFile(join(runDir, "run.json"), "utf8")) as RunManifest;
  assert.equal(afterResume.documents[0].sections[2].complete, true);
});

test("a completed document can be revised without reusing its expired author timer", async () => {
  const request = await makeRequest();
  request.overviewAudiences = ["product"];
  request.features = [];
  const { runDir, manifest } = await prepareRun(request);
  const document = manifest.documents[0];
  const id = await evidenceId(runDir);
  for (const section of document.sections) await checkpointSection(runDir, document.id, section.index, sectionText(section.title, section.index, id), sectionClaims(section.index, id));

  const runPath = join(runDir, "run.json");
  const persisted = JSON.parse(await readFile(runPath, "utf8"));
  persisted.documents[0].startedAt = new Date(Date.now() - 60_000).toISOString();
  persisted.request.budgets.authorMs = 1;
  await writeFile(runPath, JSON.stringify(persisted, null, 2));

  const revised = await checkpointSection(runDir, document.id, 1, sectionText(document.sections[0].title, 99, id), sectionClaims(99, id));
  assert.equal(revised.state, "prepared");
  assert.ok(revised.documents[0].completedAt);
  const text = await readFile(document.sections[0].file, "utf8");
  assert.match(text, /第 99 章/);
});

test("an abruptly killed author process resumes from the first incomplete section", async () => {
  const request = await makeRequest();
  request.overviewAudiences = ["product"];
  request.features = [];
  const { runDir, manifest } = await prepareRun(request);
  const document = manifest.documents[0];
  const id = await evidenceId(runDir);
  const moduleUrl = pathToFileURL(resolve("src/run.ts")).href;
  const childScript = `
    import { checkpointSection } from ${JSON.stringify(moduleUrl)};
    await checkpointSection(${JSON.stringify(runDir)}, ${JSON.stringify(document.id)}, 1, ${JSON.stringify(sectionText(document.sections[0].title, 1, id))}, ${JSON.stringify(sectionClaims(1, id))});
    process.stdout.write("CHECKPOINTED\\n");
    setInterval(() => {}, 1000);
  `;
  const child = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", childScript], {
    cwd: resolve("."),
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  await new Promise<void>((resolveReady, rejectReady) => {
    const timeout = setTimeout(() => rejectReady(new Error(`child did not checkpoint: ${stdout} ${stderr}`)), 10_000);
    const poll = setInterval(() => {
      if (stdout.includes("CHECKPOINTED")) {
        clearTimeout(timeout);
        clearInterval(poll);
        resolveReady();
      }
    }, 10);
    child.once("exit", (code, signal) => {
      if (!stdout.includes("CHECKPOINTED")) {
        clearTimeout(timeout);
        clearInterval(poll);
        rejectReady(new Error(`child exited before checkpoint: code=${code} signal=${signal} ${stderr}`));
      }
    });
  });
  child.kill("SIGKILL");
  await new Promise<void>((resolveExit) => child.once("exit", () => resolveExit()));

  await writeFile(`${document.sections[1].file}.orphan.tmp`, "partial section");

  const resumed = await resumeRun(runDir);
  assert.equal(resumed.next[0].section, 2);
  assert.equal(resumed.manifest.documents[0].sections[0].complete, true);
  assert.equal(resumed.manifest.documents[0].sections[1].complete, false);
  const sectionDir = join(runDir, "sections", document.id);
  const entries = await readdir(sectionDir);
  assert.ok(entries.includes("01.md"));
  assert.ok(!entries.includes("02.md"));
});


test("audit rejects substantive prose that is not bound to a section claim", async () => {
  const request = await makeRequest();
  request.overviewAudiences = ["product"];
  request.features = [];
  const { runDir, manifest } = await prepareRun(request);
  const id = await evidenceId(runDir);
  const document = manifest.documents[0];
  for (const section of document.sections) {
    const extra = section.index === 1 ? "\n另有一个没有进入 claims 的结论。\n" : "";
    await checkpointSection(runDir, document.id, section.index, sectionText(section.title, section.index, id) + extra, sectionClaims(section.index, id));
  }
  await dispositionChecklist(runDir, id);
  await assembleRun(runDir);
  const audit = await auditRun(runDir);
  assert.ok(audit.findings.some((item) => /unclaimed substantive statement/i.test(item.message)), JSON.stringify(audit.findings, null, 2));
});

test("cannot-determine checklist dispositions require evidence for the limitation", async () => {
  const request = await makeRequest();
  request.overviewAudiences = ["product"];
  request.features = [];
  const { runDir, manifest } = await prepareRun(request);
  const id = await completeRun(runDir, manifest);
  const checklistPath = join(runDir, "checklist.json");
  const checklist = JSON.parse(await readFile(checklistPath, "utf8")) as { items: Array<{ id: string }> };
  await updateChecklist(runDir, [{
    id: checklist.items[0].id,
    verdict: "cannot-determine",
    material: false,
    evidenceIds: [],
    reason: "The synthetic fixture does not expose runtime configuration.",
    settledBy: "Runtime configuration and traffic evidence."
  }]);
  await assembleRun(runDir);
  const audit = await auditRun(runDir);
  assert.ok(audit.findings.some((item) => /cannot-determine item has no evidence/i.test(item.message)));
  assert.ok(id);
});

test("source searches create cached, snapshot-bound receipt evidence", async () => {
  const request = await makeRequest();
  request.overviewAudiences = ["product"];
  request.features = [];
  const { runDir } = await prepareRun(request);
  const first = await searchSourceEvidence(runDir, ["Leave requests"], "locate the feature UI", { maxResults: 10 });
  assert.equal(first.cacheHit, false);
  assert.match(String(first.searchVersion), /^source-search-/);
  assert.match(String((first.evidence as EvidenceItem).id), /^SEARCH-/);
  assert.ok(Array.isArray(first.matches) && first.matches.length > 0);
  const second = await searchSourceEvidence(runDir, ["Leave requests"], "locate the feature UI", { maxResults: 10 });
  assert.equal(second.cacheHit, true);
  const persisted = JSON.parse(await readFile(join(runDir, "run.json"), "utf8"));
  assert.equal(persisted.metrics.sourceSearches, 1);
  assert.equal(persisted.metrics.sourceSearchCacheHits, 1);
});

test("a search receipt reports truncation honestly with a lower-bound count", async () => {
  const request = await makeRequest();
  request.overviewAudiences = ["product"];
  request.features = [];
  const { runDir } = await prepareRun(request);
  // A widespread token capped at one match: the receipt returns far fewer than were found.
  const truncated = await searchSourceEvidence(runDir, ["app"], "find a widespread token", { maxResults: 1 });
  assert.equal(truncated.truncated, true);
  assert.ok(Array.isArray(truncated.matches) && truncated.matches.length === 1);
  assert.ok(typeof truncated.atLeast === "number" && (truncated.atLeast as number) > truncated.matches.length);
  // A cap wider than the match set: the receipt is exhaustive and carries no truncation flag or count.
  const exhaustive = await searchSourceEvidence(runDir, ["__no_such_token_anywhere__"], "find nothing", { maxResults: 50 });
  assert.equal(exhaustive.truncated, false);
  assert.equal(exhaustive.atLeast, undefined);
  assert.ok(Array.isArray(exhaustive.matches) && exhaustive.matches.length === 0);
});


test("searched-not-found checklist dispositions reject non-search evidence", async () => {
  const request = await makeRequest();
  request.overviewAudiences = ["product"];
  request.features = [];
  const { runDir, manifest } = await prepareRun(request);
  const id = await evidenceId(runDir);
  for (const document of manifest.documents) for (const section of document.sections) {
    await checkpointSection(runDir, document.id, section.index, sectionText(section.title, section.index, id), sectionClaims(section.index, id));
  }
  const checklist = JSON.parse(await readFile(join(runDir, "checklist.json"), "utf8")) as { items: Array<{ id: string }> };
  await updateChecklist(runDir, checklist.items.map((item) => ({ id: item.id, verdict: "searched-not-found" as const, material: false, evidenceIds: [id], searchScope: "synthetic source files" })));
  await assembleRun(runDir);
  const audit = await auditRun(runDir);
  assert.ok(audit.findings.some((item) => /cites no SEARCH receipt/i.test(item.message)));
});

test("searched-not-found checklist dispositions reject search receipts that contain matches", async () => {
  const request = await makeRequest();
  request.overviewAudiences = ["product"];
  request.features = [];
  const { runDir, manifest } = await prepareRun(request);
  const id = await evidenceId(runDir);
  for (const document of manifest.documents) for (const section of document.sections) {
    await checkpointSection(runDir, document.id, section.index, sectionText(section.title, section.index, id), sectionClaims(section.index, id));
  }
  const receipt = await searchSourceEvidence(runDir, ["Leave requests"], "find an existing fixture phrase", { maxResults: 10 });
  const searchId = String((receipt.evidence as EvidenceItem).id);
  const checklist = JSON.parse(await readFile(join(runDir, "checklist.json"), "utf8")) as { items: Array<{ id: string }> };
  await updateChecklist(runDir, checklist.items.map((item) => ({ id: item.id, verdict: "searched-not-found" as const, material: false, evidenceIds: [searchId], searchScope: "synthetic source files" })));
  await assembleRun(runDir);
  const audit = await auditRun(runDir);
  assert.ok(audit.findings.some((item) => /contains matches/i.test(item.message)));
});

test("a localized level-one report title becomes front matter metadata", async () => {
  const request = await makeRequest();
  request.overviewAudiences = ["product"];
  request.features = [];
  request.language = "zh-CN";
  const { runDir, manifest } = await prepareRun(request);
  const id = await evidenceId(runDir);
  const document = manifest.documents[0];
  for (const section of document.sections) {
    const prefix = section.index === 1 ? "# 项目概览（非技术）\n\n" : "";
    await checkpointSection(runDir, document.id, section.index, `${prefix}${sectionText(section.title, section.index, id)}`, sectionClaims(section.index, id));
  }
  await assembleRun(runDir);
  const report = await readFile(join(runDir, "reports", "product-overview.md"), "utf8");
  assert.match(report, /title: "项目概览（非技术）"/);
  assert.match(report, /navTitle: "项目概览（非技术）"/);
});

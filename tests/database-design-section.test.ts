import test from "node:test";
import assert from "node:assert/strict";
import type { DocumentPlan } from "../src/base/types.ts";
import { auditReadabilityTables } from "../src/report/section-audit.ts";

// ---- forward: §13 is a recognized inventory chapter for the engineering overview ----

function engineeringOverviewPlan(): DocumentPlan {
  return { id: "overview-engineering", kind: "overview", audience: "engineering", templatePath: "", contextPath: "", sections: [] };
}

const DB_PROSE = "本章列出每张已声明的数据表及其字段来源。`事实`\n\n各表之间的关系依据声明的外键给出。`推断`";
const DB_PROSE_WITH_TABLE = `${DB_PROSE}\n\n| 字段 | 类型 | 可空 |\n| --- | --- | --- |\n| id | int | 否 |\n`;

test("§13 database design counts as an inventory chapter for the engineering overview: prose without a table nudges, a table satisfies it (57B-379)", () => {
  const document = engineeringOverviewPlan();
  const nudge = auditReadabilityTables({ document, sectionIndex: 13, sectionText: DB_PROSE });
  assert.equal(nudge.length, 1);
  assert.equal(nudge[0].level, "warning");
  assert.match(nudge[0].message, /section 13/);
  const satisfied = auditReadabilityTables({ document, sectionIndex: 13, sectionText: DB_PROSE_WITH_TABLE });
  assert.equal(satisfied.length, 0);
});

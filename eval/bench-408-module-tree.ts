// Arm B: the deterministic module tree — every node under the module that contains each pre-registered
// seed file. Module = a top-level repository directory with its own CodeGraph database, which is what
// Excavator already treats as a module. Nothing here is tuned to the gold: the seeds were pinned before
// the run, and the arm takes the WHOLE module around each, which is precisely why fileCount is reported
// beside recall — a boundary that wins by growing is not a win.
import { DatabaseSync } from "node:sqlite";
import { writeFileSync } from "node:fs";

/** The multi-module target. Out of repo, so the arm degrades to a clear error rather than a wrong number. */
const ROOT = process.env.WCP_ROOT ?? "/Users/57block/Documents/excavator-test-repos/wcp";
const SEEDS = [
  "wcp-service-v2/internal/handlers/leave/service.go",
  "wcp-ui/src/pages/leave/ApplyLeave.tsx",
  "wcp-service/routes/leave.js",
];

const modules = [...new Set(SEEDS.map((seed) => seed.split("/")[0]))].sort();
const nodes: Array<{ filePath: string; name: string; startLine?: number; endLine?: number }> = [];

for (const moduleName of modules) {
  const db = new DatabaseSync(`${ROOT}/${moduleName}/.codegraph/codegraph.db`, { readOnly: true });
  const rows = db.prepare("SELECT name, file_path, start_line, end_line FROM nodes ORDER BY file_path, start_line, name").all() as Array<{ name: string; file_path: string; start_line: number | null; end_line: number | null }>;
  for (const row of rows) {
    const path = row.file_path.startsWith(moduleName) ? row.file_path : `${moduleName}/${row.file_path.replace(/^\.?\//, "")}`;
    nodes.push({ filePath: path, name: row.name, startLine: row.start_line ?? undefined, endLine: row.end_line ?? undefined });
  }
  db.close();
}

nodes.sort((a, b) => a.filePath.localeCompare(b.filePath) || (a.startLine ?? 0) - (b.startLine ?? 0) || a.name.localeCompare(b.name));
writeFileSync(process.argv[2], JSON.stringify({ _meta: { arm: "B", modules, seeds: SEEDS }, nodes }, null, 1));
console.log(`arm B: modules=${modules.join(",")} nodes=${nodes.length} files=${new Set(nodes.map((n) => n.filePath)).size}`);

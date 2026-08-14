/**
 * Deterministic database-engine detection (zero model, target read-only).
 *
 * A schema alone rarely names its engine, so this scans the target for dialect signals and WEIGHS
 * them by authority: physical DDL dialect (`ENGINE=InnoDB`, `SERIAL`), connection strings / DBI DSNs,
 * and ORM dialect config are strong; a driver import or dependency is weak, because a project may
 * vendor several drivers (e.g. gorm ships all of them) without using them. The engine with the
 * strongest weighted, file-level evidence wins; genuinely close races are reported at lower confidence
 * with the runner-up listed, and no signal at all yields `undefined` rather than a guess.
 */

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { scanFiles } from "../snapshot/snapshot.ts";
import type { DetectedEngine, FileRef } from "./types.ts";

interface Signal {
  re: RegExp;
  engine: string;
  weight: number;
}

// Authority tiers: 3 = physical DDL / DSN / ORM dialect config; 2 = a real DB driver dependency;
// 1 = a driver import that may just be vendored breadth. Only structural DB signals, never a project name.
const SIGNALS: Signal[] = [
  { re: /\bENGINE\s*=\s*(InnoDB|MyISAM|Aria)/i, engine: "MySQL", weight: 3 },
  { re: /\bAUTO_INCREMENT\b/, engine: "MySQL", weight: 2 },
  { re: /\bmysql:\/\//i, engine: "MySQL", weight: 3 },
  { re: /\bdbi:mysql\b/i, engine: "MySQL", weight: 3 },
  { re: /\bdialect\s*[:=]\s*['"]mysql['"]/i, engine: "MySQL", weight: 3 },
  { re: /\bgo-sql-driver\/mysql\b/, engine: "MySQL", weight: 2 },
  { re: /"mysql2?"\s*:/, engine: "MySQL", weight: 2 },
  { re: /\bgorm\.io\/driver\/mysql\b/, engine: "MySQL", weight: 1 },

  { re: /\b(BIG)?SERIAL\b/i, engine: "PostgreSQL", weight: 3 },
  { re: /\bpostgres(ql)?:\/\//i, engine: "PostgreSQL", weight: 3 },
  { re: /\bdbi:Pg\b/i, engine: "PostgreSQL", weight: 3 },
  { re: /\bDBD::Pg\b/, engine: "PostgreSQL", weight: 3 },
  { re: /\bdialect\s*[:=]\s*['"]postgres(ql)?['"]/i, engine: "PostgreSQL", weight: 3 },
  { re: /\b(jackc\/pgx|lib\/pq)\b/, engine: "PostgreSQL", weight: 2 },
  { re: /"pg"\s*:/, engine: "PostgreSQL", weight: 2 },
  { re: /\bgorm\.io\/driver\/postgres\b/, engine: "PostgreSQL", weight: 1 },

  { re: /\bdbi:SQLite\b/i, engine: "SQLite", weight: 3 },
  { re: /\bdialect\s*[:=]\s*['"]sqlite['"]/i, engine: "SQLite", weight: 3 },
  { re: /"sqlite3?"\s*:/, engine: "SQLite", weight: 2 },
  { re: /\bgorm\.io\/driver\/sqlite\b/, engine: "SQLite", weight: 1 },

  { re: /\bdialect\s*[:=]\s*['"]mariadb['"]/i, engine: "MariaDB", weight: 3 },
  { re: /\bdialect\s*[:=]\s*['"]mssql['"]/i, engine: "SQL Server", weight: 3 },
  { re: /\bgorm\.io\/driver\/sqlserver\b/, engine: "SQL Server", weight: 1 },
];

export async function detectEngine(target: string): Promise<DetectedEngine | undefined> {
  const root = resolve(target);
  const scores = new Map<string, number>();
  const evidence = new Map<string, FileRef[]>();

  for (const file of await scanFiles(root)) {
    const content = await readOrEmpty(file.absolutePath);
    if (!content) continue;
    for (const signal of SIGNALS) {
      const match = signal.re.exec(content);
      if (!match) continue;
      scores.set(signal.engine, (scores.get(signal.engine) ?? 0) + signal.weight);
      const list = evidence.get(signal.engine) ?? [];
      if (list.length < 6) list.push({ file: file.relativePath, line: lineAt(content, match.index) });
      evidence.set(signal.engine, list);
    }
  }

  const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1] || cmp(a[0], b[0]));
  if (!ranked.length) return undefined;

  const [name, top] = ranked[0];
  const second = ranked[1]?.[1] ?? 0;
  const confidence = top >= 6 && top >= second * 2 ? "high" : top > second ? "medium" : "low";
  const alternatives = ranked.slice(1).filter(([, score]) => score >= 2).map(([engine]) => engine);

  return {
    name,
    confidence,
    evidence: (evidence.get(name) ?? []).slice().sort((a, b) => cmp(a.file, b.file) || (a.line ?? 0) - (b.line ?? 0)),
    alternatives,
  };
}

async function readOrEmpty(absolutePath: string): Promise<string> {
  try {
    return await readFile(absolutePath, "utf8");
  } catch {
    return "";
  }
}

function lineAt(content: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < content.length; i++) if (content.charCodeAt(i) === 10) line++;
  return line;
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

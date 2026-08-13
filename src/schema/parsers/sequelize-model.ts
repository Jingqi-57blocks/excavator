/**
 * Deterministic Sequelize model parser (`sequelize.define(...)` + `associate()`).
 *
 * A migration set records the columns a table WAS built with; the model files record the fields the
 * application reads/writes (often a superset the migrations never spelled out) plus the association
 * graph. This parser recovers both from source text — no JS execution, no npm deps, no model calls.
 *
 * Columns: `sequelize.define('<modelName>', { field: spec, … }, { tableName: '<physical>' })` → one
 * table named by its explicit `tableName`, columns from the field specs (shared Sequelize field grammar,
 * "sequelize" vocabulary). A model WITHOUT an explicit `tableName` is skipped with a warning — Sequelize
 * would pluralize the model name, but guessing a physical name is the fabrication this extractor forbids.
 *
 * Associations (two passes, because a `models.X` reference may point at a model defined in another file):
 *   pass 1 — map every model NAME (the `define` first argument, i.e. the `models.X` key) to its physical
 *            tableName;
 *   pass 2 — resolve `hasMany` / `belongsTo` / `hasOne` / `belongsToMany` calls into RelationshipSchema,
 *            turning `models.X` (and belongsToMany `through: models.Z`) into physical table names via the
 *            pass-1 map. A reference that cannot be resolved keeps the model name and is warned about.
 *
 * Pure and deterministic: files read in sorted order through the injected `readFile`.
 */

import type { ColumnSchema, RelationshipKind, RelationshipSchema, SchemaWarning, TableSchema } from "../types.ts";
import type { ParserResult, ReadFile, SchemaParser } from "./parser.ts";
import { LineMap } from "./source-position.ts";
import { findCalls, joinedStringLiteral, parseObjectLiteral, splitArgs } from "./js-scan.ts";
import { parseSequelizeField } from "./sequelize-field.ts";

const SOURCE_ID = "sequelize-model";

// Receiver-agnostic member calls: `sequelize.define(` / `s.define(`, and `model.hasMany(` etc.
const DEFINE_RE = /\.\s*define\s*\(/g;
const ASSOC_RE = /\.\s*(hasMany|belongsTo|hasOne|belongsToMany)\s*\(/g;

const KIND: Record<string, RelationshipKind> = {
  hasMany: "has-many",
  belongsTo: "belongs-to",
  hasOne: "has-one",
  belongsToMany: "many-to-many",
};

interface DefinedModel {
  modelName: string;
  tableName: string | null;
  file: string;
  content: string;
  lines: LineMap;
  defineOffset: number;
  fieldsArg?: { text: string; offset: number };
}

export const sequelizeModelParser: SchemaParser = {
  format: "sequelize-model",
  parse(files: string[], readFile: ReadFile): ParserResult {
    const warnings: SchemaWarning[] = [];
    const models: DefinedModel[] = [];

    // Pass 1: collect every define() and index model name → physical tableName.
    const nameToTable = new Map<string, string>();
    for (const file of [...files].sort()) {
      const content = readFile(file);
      const lines = new LineMap(content);
      for (const model of collectDefines(content, file, lines)) {
        models.push(model);
        if (model.tableName !== null && !nameToTable.has(model.modelName)) nameToTable.set(model.modelName, model.tableName);
      }
    }

    // Emit tables from field specs.
    const tables: TableSchema[] = [];
    for (const model of models) {
      if (model.tableName === null) {
        warnings.push({ kind: "model-no-tablename", message: `model ${model.modelName} declares no tableName; skipped (name not guessed)`, evidence: [{ file: model.file, line: model.lines.lineAt(model.defineOffset) }] });
        continue;
      }
      tables.push(buildTable(model, warnings));
    }

    // Pass 2: resolve associations to physical table names.
    const relationships: RelationshipSchema[] = [];
    for (const model of models) {
      if (model.tableName === null) continue;
      for (const rel of collectAssociations(model, nameToTable, warnings)) relationships.push(rel);
    }

    tables.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return { tables, relationships, warnings };
  },
};

/** Find every `sequelize.define(...)` and read its model name, fields arg, and explicit tableName. */
function collectDefines(content: string, file: string, lines: LineMap): DefinedModel[] {
  const out: DefinedModel[] = [];
  for (const call of findCalls(content, DEFINE_RE)) {
    const args = splitArgs(call.argsText, call.argsOffset);
    if (args.length < 2) continue;
    const modelName = joinedStringLiteral(args[0].text);
    if (modelName === null) continue;
    let tableName: string | null = null;
    if (args.length >= 3) {
      for (const opt of parseObjectLiteral(args[2].text, args[2].offset)) {
        if (opt.key === "tableName") {
          const t = joinedStringLiteral(opt.valueText);
          if (t !== null) tableName = t.trim();
        }
      }
    }
    out.push({
      modelName: modelName.trim(),
      tableName,
      file,
      content,
      lines,
      defineOffset: call.matchOffset,
      fieldsArg: { text: args[1].text, offset: args[1].offset },
    });
  }
  return out;
}

function buildTable(model: DefinedModel, warnings: SchemaWarning[]): TableSchema {
  const columns: ColumnSchema[] = [];
  const primaryKey: string[] = [];
  if (model.fieldsArg) {
    for (const entry of parseObjectLiteral(model.fieldsArg.text, model.fieldsArg.offset)) {
      const col = parseSequelizeField(entry.key, entry.valueText, entry.valueOffset, SOURCE_ID, model.file, model.lines.lineAt(entry.keyOffset), warnings);
      columns.push(col);
      if (col.inPrimaryKey) primaryKey.push(col.name);
    }
  }
  return {
    name: model.tableName!,
    columns,
    primaryKey,
    uniqueKeys: [],
    declarations: [{ sourceId: SOURCE_ID, file: model.file, line: model.lines.lineAt(model.defineOffset), symbol: model.modelName }],
  };
}

/**
 * Collect associations declared for one model. Associations only carry column facts through their
 * option keys, so we read foreignKey/sourceKey/targetKey/otherKey and place them on the side that owns
 * the key per Sequelize semantics (belongsTo → FK on source; hasMany/hasOne → FK on target).
 */
function collectAssociations(model: DefinedModel, nameToTable: Map<string, string>, warnings: SchemaWarning[]): RelationshipSchema[] {
  const out: RelationshipSchema[] = [];
  for (const call of findCalls(model.content, new RegExp(ASSOC_RE.source, "g"))) {
    const method = call.groups[0]!;
    const kind = KIND[method];
    const args = splitArgs(call.argsText, call.argsOffset);
    if (args.length === 0) continue;

    const targetName = modelRef(args[0].text);
    if (targetName === null) continue;
    const line = model.lines.lineAt(call.matchOffset);
    const toTable = resolve(nameToTable, targetName, model, line, warnings);

    const opts = args.length >= 2 ? indexOptions(args[1].text, args[1].offset) : new Map<string, string>();
    const foreignKey = strOpt(opts.get("foreignKey"));
    const sourceKey = strOpt(opts.get("sourceKey"));
    const targetKey = strOpt(opts.get("targetKey"));
    const otherKey = strOpt(opts.get("otherKey"));

    const rel: RelationshipSchema = {
      kind,
      fromTable: model.tableName!,
      fromColumns: [],
      toTable,
      toColumns: [],
      provenance: [{ sourceId: SOURCE_ID, file: model.file, line, symbol: `${model.modelName}.${method}` }],
    };

    if (kind === "belongs-to") {
      if (foreignKey) rel.fromColumns = [foreignKey];
      if (targetKey) rel.toColumns = [targetKey];
    } else if (kind === "has-many" || kind === "has-one") {
      if (sourceKey) rel.fromColumns = [sourceKey];
      if (foreignKey) rel.toColumns = [foreignKey];
    } else {
      // many-to-many: the FK columns live in the join table named by `through`.
      const through = opts.get("through");
      if (through !== undefined) {
        const throughName = modelRef(through);
        if (throughName !== null) rel.joinTable = resolve(nameToTable, throughName, model, line, warnings);
      }
      if (foreignKey) rel.fromColumns = [foreignKey];
      if (otherKey) rel.toColumns = [otherKey];
    }
    out.push(rel);
  }
  return out;
}

/** `models.X` / `sequelize.models.X` / bare `X` → the referenced model name; null if not a model reference. */
function modelRef(expr: string): string | null {
  const m = /(?:models\s*\.\s*)([A-Za-z_$][\w$]*)/.exec(expr) ?? /^([A-Za-z_$][\w$]*)\s*$/.exec(expr.trim());
  return m ? m[1] : null;
}

function resolve(nameToTable: Map<string, string>, modelName: string, model: DefinedModel, line: number, warnings: SchemaWarning[]): string {
  const physical = nameToTable.get(modelName);
  if (physical !== undefined) return physical;
  warnings.push({ kind: "model-assoc-unresolved", message: `association target ${modelName} has no known tableName; kept as model name`, evidence: [{ file: model.file, line }] });
  return modelName;
}

/** Parse an association options object into a raw key → value-text map. */
function indexOptions(text: string, base: number): Map<string, string> {
  const map = new Map<string, string>();
  for (const entry of parseObjectLiteral(text, base)) if (!map.has(entry.key)) map.set(entry.key, entry.valueText);
  return map;
}

function strOpt(valueText: string | undefined): string | undefined {
  if (valueText === undefined) return undefined;
  const s = joinedStringLiteral(valueText);
  return s === null ? undefined : s.trim();
}

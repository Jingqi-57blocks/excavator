/**
 * Read one Sequelize DataType field spec into column facts, shared by the migration and model parsers.
 *
 * A field spec appears two ways in Sequelize source: the shorthand `col: Sequelize.BIGINT` (type only)
 * and the object form `col: { type: Sequelize.STRING(50), allowNull, defaultValue, primaryKey,
 * autoIncrement }`. Both parsers (`queryInterface.createTable`/`addColumn` and `sequelize.define`) meet
 * exactly this grammar, so it lives in one place to guarantee they read a type/nullable/default the
 * same way. The DataType is recorded verbatim in the "sequelize" vocabulary with only its `Sequelize.` /
 * `DataTypes.` namespace stripped — never converted to SQL (see types.ts). Nullability and default are
 * emitted only when the spec states them; nothing is fabricated.
 */

import type { ColumnSchema, SchemaWarning } from "../types.ts";
import { parseObjectLiteral } from "./js-scan.ts";

/** Strip the `Sequelize.` / `DataTypes.` namespace, keeping the DataType verbatim (`STRING(50)`, `ENUM(...)`). */
export function normalizeSequelizeType(expr: string): string {
  return expr.replace(/^(?:Sequelize|DataTypes)\s*\.\s*(?:DataTypes\s*\.\s*)?/, "").trim();
}

/** Build a ColumnSchema from a Sequelize field spec (shorthand DataType or `{ … }` object). */
export function parseSequelizeField(
  name: string,
  valueText: string,
  base: number,
  sourceId: string,
  file: string,
  line: number,
  warnings: SchemaWarning[],
): ColumnSchema {
  const col: ColumnSchema = {
    name,
    type: "",
    typeVocabulary: "sequelize",
    provenance: [{ sourceId, file, line, symbol: name }],
  };
  const trimmed = valueText.trim();
  if (!trimmed.startsWith("{")) {
    col.type = normalizeSequelizeType(trimmed);
    return col;
  }
  let hasType = false;
  for (const entry of parseObjectLiteral(trimmed, base)) {
    const v = entry.valueText.trim();
    switch (entry.key) {
      case "type":
        col.type = normalizeSequelizeType(v);
        hasType = true;
        break;
      case "allowNull":
        if (v === "false") col.nullable = false;
        else if (v === "true") col.nullable = true;
        break;
      case "defaultValue":
        if (v !== "null") col.default = v;
        break;
      case "primaryKey":
        if (v === "true") col.inPrimaryKey = true;
        break;
      case "autoIncrement":
        if (v === "true") col.autoIncrement = true;
        break;
      default:
        break;
    }
  }
  if (!hasType) warnings.push({ kind: "sequelize-column-no-type", message: `column ${name} declares no type`, evidence: [{ file, line }] });
  return col;
}

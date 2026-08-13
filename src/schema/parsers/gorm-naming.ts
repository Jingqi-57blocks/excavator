/**
 * gorm's default column NamingStrategy: snake_case of the Go field name.
 *
 * When a gorm field has no explicit `column:` tag, gorm does NOT drop it — it derives the physical
 * column name deterministically by snake-casing the field name. Recovering that name is therefore not
 * fabrication; it is applying gorm's documented default rule. (Callers still mark such columns as
 * name-derived so the provenance stays transparent — see gorm.ts.)
 *
 * The rule, expressed as two boundary insertions then lowercase:
 *   1. lower/digit → Upper           `userId`   → `user_Id`
 *   2. Upper-run   → Upper+lower      `HTTPPort` → `HTTP_Port`
 * Worked examples: `UserID`→`user_id`, `ID`→`id`, `HTTPPort`→`http_port`, `CreatedAt`→`created_at`,
 * `APIKey`→`api_key`. Pure and deterministic; no acronym dictionary, so the boundary rules alone decide.
 */

export function gormColumnName(field: string): string {
  return field
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .toLowerCase();
}

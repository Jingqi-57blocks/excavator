import { basename } from "node:path";
import type { ScannedFile } from "./snapshot.ts";

// Contract-facing project-document scoring (57B-348). "Contract-facing" files carry a codebase's
// functional contract — the surfaces a reader must see to understand what it does: route/handler
// definitions, API/RPC/GraphQL schema and IDL, process entrypoints, runtime configuration and
// dependency manifests. The heuristic is language-agnostic: it reads only a scanned file's path,
// name and extension — no content, no target-project specifics. README stays eligible but scores
// below every contract signal, so it can no longer dominate the selection.

// Dependency / build manifests declaring runtime, dependencies and tasks.
const MANIFEST_NAMES = new Set([
  "package.json", "go.mod", "Cargo.toml", "pyproject.toml", "requirements.txt", "pom.xml",
  "build.gradle", "build.gradle.kts", "Gemfile", "composer.json", "Dockerfile",
  "docker-compose.yml", "docker-compose.yaml", "Makefile", "Procfile"
]);

// API / RPC / GraphQL interface definitions and IDL.
const IDL_EXTENSIONS = new Set([".proto", ".graphql", ".gql"]);
const API_SPEC_NAME = /swagger|openapi/i;
const SCHEMA_NAME = /(^|[._-])schema([._-]|$)/i;

// Route / handler / endpoint definitions — where requests bind to code, including front-end route
// tables. Matched against the whole path so a `routes/`, `controllers/`, `handlers/` directory counts.
const ROUTE_PATH = /(^|\/)(routes?|routers?|controllers?|handlers?|endpoints?|resolvers?)([._/-]|$)/i;
const DJANGO_URLS = /(^|\/)urls\.py$/i;

// Process entrypoints / bootstrap. `index` is deliberately excluded — it is overwhelmingly a barrel
// file, not an entrypoint, and would flood the selection with noise.
const ENTRYPOINT_NAME = /^(main|server|app|bootstrap|application|wsgi|asgi|manage)\.[a-z0-9]+$/i;

// Runtime configuration, orchestration and front-end menu/route config.
const ORCHESTRATION_NAME = /docker-compose|Dockerfile|Procfile|Makefile/i;
const SAFE_ENV_SAMPLE = /^\.env\.(sample|example|template|defaults?)$/i;
const CONFIG_NAME = /(^|[._-])(config|settings|menu)([._-]|$)/i;

/**
 * The signal-only contract score for a scanned file (before any size penalty). Signals are additive
 * so a file that is both, say, a manifest and orchestration config only ranks higher. Every contract
 * category outranks README, which floors the scale so a README-only project still selects its README.
 */
export function scoreProjectDocument(file: ScannedFile): number {
  const name = basename(file.relativePath);
  const path = file.relativePath.replaceAll("\\", "/");
  let score = 0;

  // Dependency manifests: the most reliable contract signal.
  if (MANIFEST_NAMES.has(name)) score += 95;

  // API / RPC / GraphQL schema and IDL.
  if (IDL_EXTENSIONS.has(file.extension)) score += 92;
  if (API_SPEC_NAME.test(name)) score += 90 + (/\.ya?ml$/i.test(name) ? 4 : 0);
  if (SCHEMA_NAME.test(name)) score += 80;

  // Route / handler / endpoint definitions.
  if (ROUTE_PATH.test(path) || DJANGO_URLS.test(path)) score += 85;

  // Runtime configuration, orchestration and front-end menu/route config.
  if (ORCHESTRATION_NAME.test(name)) score += 70;
  if (SAFE_ENV_SAMPLE.test(name)) score += 55;
  if (CONFIG_NAME.test(name)) score += 55;

  // Process entrypoints / bootstrap.
  if (ENTRYPOINT_NAME.test(name)) score += 65;

  // README: the project's own description — eligible, but below every contract signal so it can no
  // longer dominate. Scanning caps file size at 2 MB, so the size penalty cannot drive it below zero.
  if (/^README(?:\.|$)/i.test(name)) score += 30;

  return score;
}

/** A file's category for selection diversity, ordered strongest to weakest contract signal. */
export type DocumentCategory = "manifest" | "schema" | "route" | "entrypoint" | "config" | "readme" | "other";

/**
 * The single category a file counts toward, chosen by its strongest matching signal. Selection
 * round-robins across these so no one category — e.g. a large `routes/` tree, or a swarm of
 * `*.config.*` files — can monopolize a capped slate and starve entrypoints, schema or the README.
 */
export function primaryCategory(file: ScannedFile): DocumentCategory {
  const name = basename(file.relativePath);
  const path = file.relativePath.replaceAll("\\", "/");
  if (MANIFEST_NAMES.has(name)) return "manifest";
  if (IDL_EXTENSIONS.has(file.extension) || API_SPEC_NAME.test(name) || SCHEMA_NAME.test(name)) return "schema";
  if (ROUTE_PATH.test(path) || DJANGO_URLS.test(path)) return "route";
  if (ENTRYPOINT_NAME.test(name)) return "entrypoint";
  if (ORCHESTRATION_NAME.test(name) || SAFE_ENV_SAMPLE.test(name) || CONFIG_NAME.test(name)) return "config";
  if (/^README(?:\.|$)/i.test(name)) return "readme";
  return "other";
}

/** Contract categories in round-robin priority order; README is reserved separately, not filled here. */
export const CONTRACT_CATEGORIES: DocumentCategory[] = ["manifest", "schema", "route", "entrypoint", "config"];

/**
 * The de-duplication key for project-document selection: generated API formats and README variants
 * collapse per root so only one representative of each is read.
 */
export function projectDocumentGroup(file: ScannedFile): string {
  const name = basename(file.relativePath).toLowerCase();
  if (/^readme(?:\.|$)/i.test(name)) return `${file.rootName}:readme`;
  if (/swagger|openapi/i.test(name)) return `${file.rootName}:api-spec`;
  return `${file.rootName}:${name}`;
}

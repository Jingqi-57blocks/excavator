/**
 * Catalyst (Perl MVC) convention pack.
 *
 * Recovers the structure Catalyst imposes by convention — WITHOUT a call graph, which Perl's dynamic
 * dispatch makes mostly unresolvable:
 *   - components by base class / namespace (Controller / Model / View / Schema / DispatchType / …);
 *   - routes/actions from attributed subs (`sub name :Path('/x') :Args(1) { }`), the real entry-point
 *     inventory a generic graph reports as "no route candidates".
 *
 * Pure regex over source text, deterministic, `file:line` on every item. Recognizes only generic
 * Catalyst conventions — no target project name, business identifier, or specific route is hard-coded.
 * Custom application DispatchTypes (e.g. an app-defined `:ZMSIndex` attribute) are captured verbatim as
 * a custom-dispatch action rather than being interpreted.
 */

import type {
  ComponentRole, DetectedFramework, FrameworkComponent, FrameworkWarning, RouteAction, SourceText,
} from "./types.ts";
import type { FrameworkPack, PackResult } from "./pack.ts";

const PACKAGE = /^[ \t]*package[ \t]+([\w:]+)[ \t]*;/m;
const BASE_CLASS = /\b(?:use[ \t]+(?:base|parent)[ \t]+(?:-norequire[ \t]+)?|extends[ \t]+)['"]([\w:]+)['"]/;
// The application class does `use Catalyst;` / `use Catalyst qw/.../` — bareword Catalyst NOT followed
// by `::` (which would be `use Catalyst::Plugin::X`, an ordinary import, not the app setup).
const USE_CATALYST = /\buse[ \t]+Catalyst(?!::)/;
const NAMESPACE_OVERRIDE = /__PACKAGE__->config(?:->\{namespace\}[ \t]*=[ \t]*|\([ \t]*namespace[ \t]*=>[ \t]*)['"]([^'"]*)['"]/;
// An attributed sub: `sub NAME : ATTRS {` — attributes run from the first colon to end of that line.
const ATTRIBUTED_SUB = /\bsub[ \t]+(\w+)[ \t]*:[ \t]*([^\n{;]*)/g;
// One attribute token inside the blob: Name or Name(args). Verbatim.
const ATTR_TOKEN = /([A-Za-z_]\w*(?:::\w+)*)[ \t]*(\([^)]*\))?/g;

export const catalystPack: FrameworkPack = {
  name: "Catalyst",
  extensions: [".pm"],
  detect,
  extract,
};

function detect(files: SourceText[]): DetectedFramework | null {
  const evidence: DetectedFramework["evidence"] = [];
  for (const { file, content } of files) {
    const app = USE_CATALYST.exec(content);
    if (app) evidence.push({ file, line: lineAt(content, app.index), hint: "use Catalyst (application class)" });
    const base = BASE_CLASS.exec(content);
    if (base && /^Catalyst(::|$)/.test(base[1])) {
      evidence.push({ file, line: lineAt(content, base.index), hint: `base ${base[1]}` });
    }
    if (evidence.length >= 8) break;
  }
  if (!evidence.length) return null;
  evidence.sort((a, b) => cmp(a.file, b.file) || a.line - b.line);
  const confidence = evidence.some((e) => e.hint.startsWith("use Catalyst")) ? "high" : "medium";
  return { name: "Catalyst", confidence, evidence: evidence.slice(0, 8) };
}

function extract(files: SourceText[]): PackResult {
  const components: FrameworkComponent[] = [];
  const routes: RouteAction[] = [];
  const warnings: FrameworkWarning[] = [];

  for (const { file, content } of files) {
    const pkgMatch = PACKAGE.exec(content);
    if (!pkgMatch) continue;
    const pkg = pkgMatch[1];
    const baseMatch = BASE_CLASS.exec(content);
    const baseClass = baseMatch ? baseMatch[1] : undefined;
    const role = classifyRole(pkg, baseClass, USE_CATALYST.test(content));

    const component: FrameworkComponent = { package: pkg, role, file, line: lineAt(content, pkgMatch.index) };
    if (baseClass) component.baseClass = baseClass;
    components.push(component);

    // Actions live on controllers and (namespace-overridden) the application/root controller.
    if (role !== "controller" && role !== "application") continue;
    const nsMatch = NAMESPACE_OVERRIDE.exec(content);
    if (nsMatch) {
      warnings.push({ kind: "namespace-override", message: `${pkg} sets Catalyst namespace to "${nsMatch[1]}"`, file });
    }
    for (const action of extractActions(pkg, file, content)) routes.push(action);
  }

  components.sort((a, b) => cmp(a.package, b.package) || cmp(a.file, b.file));
  routes.sort((a, b) => cmp(a.controller, b.controller) || cmp(a.action, b.action) || a.line - b.line);
  warnings.sort((a, b) => cmp(a.kind, b.kind) || cmp(a.message, b.message));
  return { components, routes, warnings };
}

function extractActions(pkg: string, file: string, content: string): RouteAction[] {
  const actions: RouteAction[] = [];
  ATTRIBUTED_SUB.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = ATTRIBUTED_SUB.exec(content)) !== null) {
    const name = match[1];
    const attributes = tokenizeAttributes(match[2]);
    if (!attributes.length) continue; // a bare `sub x : {` with nothing parseable — skip
    const { kind, pathHint } = classifyAction(attributes);
    const action: RouteAction = {
      controller: pkg,
      action: name,
      attributes,
      kind,
      file,
      line: lineAt(content, match.index),
    };
    if (pathHint !== undefined) action.pathHint = pathHint;
    actions.push(action);
  }
  return actions;
}

function tokenizeAttributes(blob: string): string[] {
  const attrs: string[] = [];
  ATTR_TOKEN.lastIndex = 0;
  let token: RegExpExecArray | null;
  while ((token = ATTR_TOKEN.exec(blob)) !== null) {
    attrs.push(token[2] ? `${token[1]}${token[2]}` : token[1]);
  }
  return attrs;
}

/** Generic Catalyst action classification from its attribute list; pathHint only when stated literally. */
function classifyAction(attributes: string[]): { kind: string; pathHint?: string } {
  const names = attributes.map((a) => a.replace(/\(.*/, ""));
  const argOf = (attr: string): string | undefined => {
    const hit = attributes.find((a) => a.startsWith(`${attr}(`));
    if (!hit) return undefined;
    const inner = hit.slice(hit.indexOf("(") + 1, hit.lastIndexOf(")")).trim();
    return inner.replace(/^['"]|['"]$/g, "") || undefined;
  };
  if (names.includes("Private")) return { kind: "private" };
  if (names.includes("Path")) return { kind: "path", pathHint: argOf("Path") };
  if (names.includes("Global")) return { kind: "global" };
  if (names.includes("Local")) return { kind: "local" };
  if (names.includes("Chained")) return { kind: "chained", pathHint: argOf("Chained") };
  // A leading bareword that is not a standard Catalyst attribute = an application-defined DispatchType.
  const standard = new Set(["Args", "CaptureArgs", "PathPart", "PathPrefix", "ActionClass", "Does", "Consumes"]);
  const custom = names.find((n) => !standard.has(n));
  if (custom) return { kind: "custom-dispatch" };
  return { kind: "unclassified" };
}

function classifyRole(pkg: string, baseClass: string | undefined, usesCatalyst: boolean): ComponentRole {
  const base = baseClass ?? "";
  if (/(^|::)Catalyst::DispatchType(::|$)/.test(base) || /(^|::)DispatchType(::|$)/.test(pkg)) return "dispatch-type";
  if (/(^|::)Controller(::|$)/.test(pkg) || /Catalyst::Controller/.test(base)) return "controller";
  if (/(^|::)Model(::|$)/.test(pkg) || /Catalyst::Model/.test(base)) return "model";
  if (/(^|::)View(::|$)/.test(pkg) || /Catalyst::View/.test(base)) return "view";
  if (/(^|::)Schema(::|$)/.test(pkg) || /(^|::)Result(::|$)/.test(pkg) || /DBIx::Class/.test(base)) return "schema";
  if (/(^|::)Role(::|$)/.test(pkg)) return "role";
  if (/(^|::)Plugin(::|$)/.test(pkg)) return "plugin";
  if (usesCatalyst) return "application";
  return "other";
}

function lineAt(content: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < content.length; i++) if (content.charCodeAt(i) === 10) line++;
  return line;
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

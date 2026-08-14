/**
 * Framework-neutral model for framework-convention extraction.
 *
 * For codebases built on a convention-heavy framework (Catalyst, Rails, Django, Laravel, Spring, …),
 * the architecture is encoded in NAMING and DECLARATION conventions (namespaces, base classes, method
 * attributes, config) rather than in a resolvable call graph. This is the high-leverage recovery path
 * for dynamically-dispatched languages, where a static call graph is mostly unresolvable.
 *
 * This model is what any per-framework "pack" normalizes into: detected frameworks, a component
 * inventory (controller / model / view / schema / …), and a route/action inventory — each carrying
 * `file:line` provenance so a reader can open the real source. It is a NAVIGATION + entry-point
 * inventory aid, never itself an audit-chain artifact; report claims still ground to source windows.
 *
 * Nothing here names a target project, business identifier, or specific route — only generic framework
 * conventions. Adding a framework = one new pack file + one registry line.
 */

/** The architectural role a component plays, inferred from framework convention. */
export type ComponentRole =
  | "application"
  | "controller"
  | "model"
  | "view"
  | "schema"
  | "dispatch-type"
  | "role"
  | "plugin"
  | "other";

/** A framework component (e.g. a Catalyst controller class), located by convention. */
export interface FrameworkComponent {
  package: string;
  role: ComponentRole;
  file: string;
  line: number;
  /** The base/parent class the convention was recognized from, when explicit. */
  baseClass?: string;
}

/** One route/action recovered from a framework convention (e.g. a Catalyst attributed sub). */
export interface RouteAction {
  /** The declaring component package. */
  controller: string;
  /** The action/handler name (the sub/method name). */
  action: string;
  /** Verbatim framework attributes, e.g. ["Private"] or ["ZMSIndex", "Args(0)"] or ["Local"]. */
  attributes: string[];
  /** A normalized classification of how this action is reached (framework-generic). */
  kind: string;
  /** A path hint derived only when the convention states one literally; never guessed. */
  pathHint?: string;
  file: string;
  line: number;
}

/** A framework detected in the target, with the evidence that recognized it. */
export interface DetectedFramework {
  name: string;
  confidence: "high" | "medium";
  evidence: Array<{ file: string; line: number; hint: string }>;
}

/** A non-fatal note (a component with an unrecognized convention, a namespace override, …). */
export interface FrameworkWarning {
  kind: string;
  message: string;
  file?: string;
}

/** The full framework-convention model for one target. Deterministic: all lists sorted before landing. */
export interface FrameworkModel {
  target: string;
  gitHead?: string;
  detected: DetectedFramework[];
  components: FrameworkComponent[];
  routes: RouteAction[];
  stats: {
    frameworks: string[];
    componentsByRole: Record<ComponentRole, number>;
    actions: number;
    actionsByKind: Record<string, number>;
  };
  warnings: FrameworkWarning[];
}

/** One in-memory source file handed to packs (framework packs parse text, never touch disk directly). */
export interface SourceText {
  file: string;
  content: string;
}

import { spawn } from "node:child_process";
import { join, resolve } from "node:path";
import { exists } from "./util.ts";
import { executableAvailable } from "./providers.ts";
import { discoverModules } from "./module-detection.ts";

export interface ModuleBuildResult {
  dir: string;
  command: string[];
  database: string;
}

export type CodeGraphBuildResult =
  | { command: string[]; database: string }
  | { modules: ModuleBuildResult[]; databases: string[] };

export interface CodeGraphStatus {
  installed: boolean;
  binary: string;
  database: { path: string; exists: boolean };
  /** Per-module databases when the target splits into >= 2 modules; absent for a single-graph target. */
  modules?: Array<{ dir: string; path: string; exists: boolean }>;
  install: { macosLinux: string; windows: string; npm: string };
}

export async function codeGraphStatus(targetInput: string, binary = "codegraph"): Promise<CodeGraphStatus> {
  const target = resolve(targetInput);
  const databasePath = join(target, ".codegraph", "codegraph.db");
  const modules = await discoverModules(target);
  // A multi-module target has no merged root database by design; report each module's database so
  // `status` reflects what a per-module `build` produced instead of contradicting it.
  const moduleStatuses = modules.length >= 2
    ? await Promise.all(modules.map(async (module) => {
        const path = join(target, module.dir, ".codegraph", "codegraph.db");
        return { dir: module.dir || ".", path, exists: await exists(path) };
      }))
    : undefined;
  return {
    installed: await executableAvailable(binary),
    binary,
    database: { path: databasePath, exists: moduleStatuses ? moduleStatuses.every((module) => module.exists) : await exists(databasePath) },
    modules: moduleStatuses,
    install: installationInstructions()
  };
}

export async function buildCodeGraph(options: { target: string; binary?: string; force?: boolean; quiet?: boolean }): Promise<CodeGraphBuildResult> {
  const target = resolve(options.target);
  const binary = options.binary ?? "codegraph";
  if (!await executableAvailable(binary)) {
    const instructions = installationInstructions();
    throw new Error(`CodeGraph CLI was not found. Install it separately, then rerun this command. macOS/Linux: ${instructions.macosLinux} | Windows: ${instructions.windows} | npm: ${instructions.npm}`);
  }
  // A multi-module target builds one graph per module. A single merged graph fabricates cross-module
  // edges, so each module is indexed inside its own directory, producing its own `.codegraph`. The
  // module directory is passed as `.` with the process run inside it, because `codegraph index <subdir>`
  // from an ancestor rebuilds the ancestor's merged graph instead of an isolated per-module one.
  const modules = await discoverModules(target);
  if (modules.length >= 2) {
    const built: ModuleBuildResult[] = [];
    for (const module of modules) {
      built.push(await buildModuleGraph(binary, join(target, module.dir), module.dir || ".", options));
    }
    return { modules: built, databases: built.map((entry) => entry.database) };
  }
  const initialized = await exists(join(target, ".codegraph"));
  // `init` indexes by default and rejects --quiet; `index` rebuilds from scratch and accepts it.
  const args = initialized ? ["index", target] : ["init", target];
  if (options.force) args.push("--force");
  if (options.quiet && initialized) args.push("--quiet");
  await run(binary, args, target);
  const database = join(target, ".codegraph", "codegraph.db");
  if (!await exists(database)) throw new Error(`CodeGraph completed without producing ${database}`);
  return { command: [binary, ...args], database };
}

async function buildModuleGraph(binary: string, moduleDir: string, label: string, options: { force?: boolean; quiet?: boolean }): Promise<ModuleBuildResult> {
  const initialized = await exists(join(moduleDir, ".codegraph"));
  const args = initialized ? ["index", "."] : ["init", "."];
  if (options.force) args.push("--force");
  if (options.quiet && initialized) args.push("--quiet");
  await run(binary, args, moduleDir);
  const database = join(moduleDir, ".codegraph", "codegraph.db");
  if (!await exists(database)) throw new Error(`CodeGraph completed without producing ${database}`);
  return { dir: label, command: [binary, ...args], database };
}

export function installationInstructions(): { macosLinux: string; windows: string; npm: string } {
  return {
    macosLinux: "curl -fsSL https://raw.githubusercontent.com/colbymchenry/codegraph/main/install.sh | sh",
    windows: "irm https://raw.githubusercontent.com/colbymchenry/codegraph/main/install.ps1 | iex",
    npm: "npm i -g @colbymchenry/codegraph"
  };
}

async function run(binary: string, args: string[], cwd: string): Promise<void> {
  await new Promise<void>((done, reject) => {
    // CodeGraph writes progress to stdout; route it to stderr so this command's own
    // stdout stays a single parseable JSON document like every other Excavator command.
    const child = spawn(binary, args, { cwd, stdio: ["ignore", 2, 2] });
    child.once("error", reject);
    child.once("exit", (code, signal) => code === 0 ? done() : reject(new Error(`CodeGraph exited with ${signal ? `signal ${signal}` : `code ${code}`}`)));
  });
}

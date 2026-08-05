import { spawn } from "node:child_process";
import { join, resolve } from "node:path";
import { exists } from "./util.ts";
import { executableAvailable } from "./providers.ts";

export interface CodeGraphStatus {
  installed: boolean;
  binary: string;
  database: { path: string; exists: boolean };
  install: { macosLinux: string; windows: string; npm: string };
}

export async function codeGraphStatus(targetInput: string, binary = "codegraph"): Promise<CodeGraphStatus> {
  const target = resolve(targetInput);
  const databasePath = join(target, ".codegraph", "codegraph.db");
  return {
    installed: await executableAvailable(binary),
    binary,
    database: { path: databasePath, exists: await exists(databasePath) },
    install: installationInstructions()
  };
}

export async function buildCodeGraph(options: { target: string; binary?: string; force?: boolean; quiet?: boolean }): Promise<{ command: string[]; database: string }> {
  const target = resolve(options.target);
  const binary = options.binary ?? "codegraph";
  if (!await executableAvailable(binary)) {
    const instructions = installationInstructions();
    throw new Error(`CodeGraph CLI was not found. Install it separately, then rerun this command. macOS/Linux: ${instructions.macosLinux} | Windows: ${instructions.windows} | npm: ${instructions.npm}`);
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

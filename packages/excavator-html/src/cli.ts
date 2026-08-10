#!/usr/bin/env -S node --experimental-strip-types --no-warnings
import { buildSite } from "./renderer.ts";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0] ?? "help";
  if (command === "help" || command === "--help" || command === "-h") {
    console.log("excavator-html build --input reports/ [--input report.md] [--output site/] [--title Project]");
    return;
  }
  if (command !== "build") throw new Error(`Unknown command: ${command}`);
  const inputs = values(args, "--input");
  if (!inputs.length) throw new Error("--input is required");
  // --output is optional: buildSite derives <parent-of-input>/html-reports for a single directory input.
  const result = await buildSite({ inputs, output: value(args, "--output"), title: value(args, "--title") });
  console.log(JSON.stringify(result, null, 2));
}
function values(args: string[], flag: string): string[] { const out: string[] = []; for (let i = 0; i < args.length; i += 1) if (args[i] === flag && args[i + 1]) out.push(args[i + 1]); return out; }
function value(args: string[], flag: string): string | undefined { return values(args, flag)[0]; }
main().catch((error) => { console.error(JSON.stringify({ error: error.message }, null, 2)); process.exitCode = 1; });

import { mkdtempSync, rmSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Temp directories that go away when the process does — ONE implementation, used by every suite.
 *
 * `mkdtemp` on its own leaks: nothing removed these, and a day of runs left 259,350 `excavator-*` directories in
 * the OS temp area. They belong there (tests must not write into the repo, and the earlier `.gitignore` traps show
 * what happens when fixture data lands where git can see it), but the system only reclaims them at reboot, and a
 * count that only grows hides the one run that mattered.
 *
 * WHY A REGISTRY AND NOT `t.after`. `tests/framework.test.ts` and `tests/nativegraph.test.ts` already do the right
 * thing with `t.after(() => rm(dir, …))`, and that stays the better shape wherever a test context is in scope. It
 * is not in scope for the four leaking sites in `eval/tests/`: they mint their directory inside a plain helper
 * (`withGolden`, `withArtifact`, `prepareLeaveMini`) that returns a path, and `tempDir` itself is called from about
 * a hundred places that would all have to start threading `t`. So: registry here, `t.after` where it fits, and
 * never two copies of either.
 *
 * Cleanup registers once and runs at process exit, not per test — `node --test` gives each file its own process,
 * so each cleans only what it made, and a test that inspects its directory after asserting still finds it. The
 * handler must be synchronous, hence `rmSync`. A hard kill still leaks; that is the only path that does, and it is
 * left visible rather than papered over.
 */
const created: string[] = [];
let registered = false;

function register(dir: string): string {
  if (!registered) {
    registered = true;
    process.on("exit", () => {
      for (const dir of created) {
        try { rmSync(dir, { recursive: true, force: true }); } catch { /* an exit handler cannot report; the OS reclaims it */ }
      }
    });
  }
  created.push(dir);
  return dir;
}

/** A fresh temp directory, removed at process exit. */
export async function tempDir(prefix = "excavator-test-"): Promise<string> {
  return register(await mkdtemp(join(tmpdir(), prefix)));
}

/** The synchronous form, for helpers that cannot await (`withGolden`, `withArtifact`). */
export function tempDirSync(prefix: string): string {
  return register(mkdtempSync(join(tmpdir(), prefix)));
}

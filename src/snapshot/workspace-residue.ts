import { basename, join, resolve } from "node:path";
import { exists, slugify } from "../core/util.ts";

/**
 * Warn when a target's runs were stranded by the per-target workdir layout.
 *
 * The old layout kept every target's runs directly under `<workdir>/<project>/runs/` with no path
 * digest, so two targets sharing a basename collided. `projectWorkspace` now suffixes a colliding
 * target with a digest (`<project>-<hash>/`); the digested target no longer reads the un-suffixed
 * directory, so its historical runs there become silently invisible.
 *
 * `resolved` is the workspace `projectWorkspace` returned for this target. When it differs from the
 * un-suffixed `<workdir>/<project>` path and that path still holds a `runs/` directory, those
 * historical runs will not be picked up; a full migration is deferred, so we surface a warning
 * instead of moving anything. Returns `null` when the target adopted the un-suffixed directory
 * (its runs stay visible) or when no old-layout residue exists.
 */
export async function legacyWorkspaceWarning(workdir: string, target: string, resolved: string): Promise<string | null> {
  const legacy = join(resolve(workdir), slugify(basename(resolve(target))));
  if (resolve(resolved) === legacy) return null;
  if (!await exists(join(legacy, "runs"))) return null;
  return `Historical runs under the old workdir layout at ${join(legacy, "runs")} are not picked up; this target now uses ${resolved}. Move them manually if they are still needed.`;
}

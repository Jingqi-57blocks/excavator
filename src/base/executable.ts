import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter, join, resolve } from "node:path";

/**
 * Is `binary` an executable this machine can run — by absolute/relative path, or on PATH?
 *
 * It sits in the base because it answers a question about the host, not about any layer's subject matter, and
 * because its consumers sit on both sides of the order: the layer-1 provider registry records whether a CLI is
 * installed, and a layer-3 command refuses to run a missing indexer. Owned by either consumer it would be an
 * import between two layers that have nothing else to say to each other.
 */
export async function executableAvailable(binary: string): Promise<boolean> {
  if (binary.includes("/") || binary.includes("\\")) {
    try { await access(resolve(binary), constants.X_OK); return true; } catch { return false; }
  }
  for (const directory of (process.env.PATH ?? "").split(delimiter).filter(Boolean)) {
    try { await access(join(directory, binary), constants.X_OK); return true; } catch { /* continue */ }
  }
  return false;
}

/**
 * Default workdir for a report request. Project directories, caches and run directories all nest
 * under `request.workdir`, so this single literal is the root of every Excavator runtime artifact
 * when `--workdir` is not supplied. Kept out of `cli.ts` because that module self-executes `main()`
 * on import and so cannot be imported by unit tests.
 */
export const DEFAULT_WORKDIR = ".work";

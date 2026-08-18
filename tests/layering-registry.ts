import type { RegistryEntry } from "./layer-order-check.ts";

// Which layer each source file belongs to — the contract `docs/layering.md` §二 calls for, in code.
//
// It lives in tests/ and not in src/ on purpose: it has no production consumer. It is a development-discipline
// contract, checked by `layer-order.test.ts`, exactly as `search-corpus.test.ts` pins registry containment.
//
// Registration is EXPLICIT, per file or per whole-directory, and there is NO default layer. A default would
// silently adopt every new file, which is the blind spot the "unregistered file fails" rule closes. A
// directory entry is therefore only legal when the directory is entirely one layer. The former mixed
// `src/assurance/` directory has been eliminated, so real directories now match real layers and the registry
// can stay a directory list plus the orchestration entrypoint.
export const LAYERING_REGISTRY: readonly RegistryEntry[] = [
  // --- beneath every layer -------------------------------------------------------------------------------
  { dir: "src/base", layer: "base" },
  { dir: "src/contract", layer: "contract" },

  // --- the layers ----------------------------------------------------------------------------------------
  { dir: "src/snapshot", layer: "L1" },
  { dir: "src/mechanism", layer: "L2" },
  { dir: "src/codegraph", layer: "L3" },
  { dir: "src/nativegraph", layer: "L3" },
  { dir: "src/framework", layer: "L3" },
  { dir: "src/schema", layer: "L3" },
  { dir: "src/crossrepo", layer: "L3" },
  // The whole of `src/facts/` is layer 3 — `inDirectory` is a recursive prefix match, so `probe/` and `units/`
  // are both covered and the next producer to move in needs no new entry.
  { dir: "src/facts", layer: "L3" },
  { dir: "src/attribution", layer: "L4" },
  { dir: "src/context", layer: "L5" },
  { dir: "src/workset", layer: "L5" },
  { dir: "src/obligation", layer: "L6" },
  { dir: "src/investigation", layer: "L7" },
  { dir: "src/freeze", layer: "L8" },
  { dir: "src/report", layer: "report" },

  // --- orchestration -------------------------------------------------------------------------------------
  // `src/run/` is the orchestration facade plus producer/stage coordinators. `stages/` separates the runtime
  // command boundaries (investigation, freeze and authoring) from the prepare/audit facade; the whole tree is
  // still orchestration, so layer 2 never has to reach up into a runtime mechanism to ask about availability.
  { dir: "src/run", layer: "orch" },
  { file: "src/cli.ts", layer: "orch" }
];

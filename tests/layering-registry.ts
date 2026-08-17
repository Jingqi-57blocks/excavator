import type { RegistryEntry } from "./layer-order-check.ts";

// Which layer each source file belongs to — the contract `docs/layering.md` §二 calls for, in code.
//
// It lives in tests/ and not in src/ on purpose: it has no production consumer. It is a development-discipline
// contract, checked by `layer-order.test.ts`, exactly as `search-corpus.test.ts` pins registry containment.
//
// Registration is EXPLICIT, per file or per whole-directory, and there is NO default layer. A default would
// silently adopt every new file, which is the blind spot the "unregistered file fails" rule closes. A
// directory entry is therefore only legal when the directory is entirely one layer; a mixed directory — and
// `src/assurance/` is the known one — must list its files. The end state is that real directories match real
// layers and this table degenerates into a directory list; the file entries below are the transition —
// today only `src/assurance/`, whose report half and knowledge half still share a folder.
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
  { dir: "src/context", layer: "L5" },

  // --- src/assurance/: the known mixed directory, knowledge side and report side in one folder -----------
  { file: "src/assurance/timeline.ts", layer: "base" },
  { file: "src/assurance/logic-workitems.ts", layer: "L6" },
  { file: "src/assurance/read-obligations.ts", layer: "L6" },
  { file: "src/assurance/relevance-annotation.ts", layer: "L6" },
  { file: "src/assurance/assurance.ts", layer: "L7" },
  { file: "src/assurance/condition-inventory.ts", layer: "L7" },
  { file: "src/assurance/read-coverage.ts", layer: "L7" },
  { file: "src/assurance/read-residual-exposure.ts", layer: "L7" },
  { file: "src/assurance/investigation-artifacts.ts", layer: "L7" },
  { file: "src/assurance/contract-instance-audit.ts", layer: "L8" },
  { file: "src/assurance/freeze.ts", layer: "L8" },
  { file: "src/assurance/mechanism-ledger-audit.ts", layer: "L8" },
  { file: "src/assurance/assurance-artifacts.ts", layer: "report" },
  { file: "src/assurance/authoring-packet.ts", layer: "report" },
  { file: "src/assurance/claim-comparison.ts", layer: "report" },
  { file: "src/assurance/checkpoint.ts", layer: "report" },
  { file: "src/assurance/claims-scaffold.ts", layer: "report" },
  { file: "src/assurance/parallel-authoring.ts", layer: "report" },
  { file: "src/assurance/recommendation-language.ts", layer: "report" },
  { file: "src/assurance/section-audit.ts", layer: "report" },
  { file: "src/assurance/section-slug.ts", layer: "report" },

  // --- orchestration -------------------------------------------------------------------------------------
  // `src/run/` holds run.ts, run-label.ts and mechanism-availability.ts. The last one states in its own
  // header that it is orchestration: it observes each mechanism's runtime dependency once per run so
  // layer 2 never has to reach up into the mechanisms to ask.
  { dir: "src/run", layer: "orch" },
  { file: "src/cli.ts", layer: "orch" }
];

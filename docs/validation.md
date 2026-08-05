# Validation status

This document records repository-level validation. Real-project source is not committed to this repository. Sanitized generated reports and validation summaries may be committed under `reports/validation/`.

## Automated test domains

The generic test suite covers:

1. CodeGraph-backed and source-only context preparation.
2. Automatic provider discovery, explicit disablement and external CLI delegation without automatic installation.
3. Git-aware tracked and untracked source enumeration, nested ignore rules, OS metadata exclusions and multi-repository behavior.
4. CodeGraph intersection with the exact source manifest.
5. Cache reuse across repeated requests and multiple audiences.
6. Unique run directories, atomic checkpoints, revision history, timeout and resume.
7. Recovery after an actual author process is terminated with `SIGKILL`.
8. Evidence identity, snapshot, path, line-range and digest validation.
9. Exact section-claim coverage.
10. Analysis-scope and provider-registry integrity.
11. Work-item coverage and compatibility-checklist accounting.
12. Trace integrity and material-flow trace requirements.
13. Hash-chained append-only timeline validation.
14. Claims, traces and coverage companion files.
15. Standalone Markdown-to-HTML generation.
16. English-only static contracts with arbitrary report output languages.

## Real-project validation contract

A comprehensive external regression compares CodeGraph and source-only runs on the same immutable snapshot and records:

- preparation and authoring time;
- graph queries and graph cache hits;
- source windows, source characters and source-search coverage;
- provider coverage;
- evidence, claim, trace and work-item counts;
- feature-boundary recall;
- audit findings;
- report chapter and claim completeness;
- manually reviewed high-impact claims against source.

The final validation package includes a fresh product overview and a fresh leave-management feature report plus their companion artifacts. Static analysis cannot prove absolute runtime completeness; the report states its scope and unresolved limits instead of silently claiming certainty.

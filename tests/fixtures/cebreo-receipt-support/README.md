# cebreo-receipt-support golden fixture

Real search receipts and checkpointed claims produced by the Excavator pipeline against the actual
cebreo repository, frozen to pin `auditClaimReceiptSupport` (57B-362 / S0a). They reproduce the
cebreo finding #3 shape (`docs/findings/2026-08-06-cebreo.md`): a `verified` claim asserting a large
positive hit count while citing a **zero-match** SEARCH receipt audited clean.

## Provenance

- Target repo: `/Users/57block/Documents/excavator-test-repos/cebreo/unmc` (987 `.cs` files)
- runId: `run-2026_08_10_22_12-3701b1af-216058be-7bead2dc`
- snapshotId: `3701b1af12e4ac10b2ae`
- `searchVersion`: `source-search-v4-ranking-v1-redaction-v4`

## Frozen artifacts

- `evidence.json` — the two SEARCH evidence items taken verbatim from the run's `evidence.json`:
  - `SEARCH-5fa4a75ef122` — **zero-match** receipt. Query `^[[:space:]]*//.*\[Test\]` (regex). The
    POSIX `[[:space:]]` class does not mean "whitespace" in JS regex, so it returns 0 matches over 995
    candidate files (`truncated: false`) — the exact failure mode from cebreo #3.
  - `SEARCH-25309d9ce1e3` — **complete, non-truncated** receipt with 9 matches. Query `//\s*\[SetUp\]`
    (regex): commented-out test-setup declarations, one per file across 9 files, so neither the global
    nor the per-file cap trips (`truncated: false`).
- `claims.json` — the section-1 claims file for `overview-engineering`, written by a real
  `excavator checkpoint` (so it passed `validateClaimsInput`):
  - `claim-zero-count` (`verified`) asserts "共发现 112 处命中" but cites the zero-match receipt.
  - `claim-hasmatch-exact` (`verified`) asserts "命中 9 处", equal to the complete receipt's real count.
  - `claim-hasmatch-lower` (`verified`) asserts "不少于 5 处", a lower bound below that count.

## Reproduce

```sh
cat > request.json <<'JSON'
{ "target": "/Users/57block/Documents/excavator-test-repos/cebreo/unmc",
  "codegraphMode": "off", "language": "zh-CN", "detailLevel": "standard",
  "workdir": "<tmp>", "overviewAudiences": ["engineering"], "features": [],
  "budgets": { "prepareMs": 300000, "authorMs": 300000, "maxGraphQueries": 5,
    "maxSourceWindows": 3, "maxSourceCharacters": 20000, "maxFiles": 2000,
    "maxFeatureNodes": 10, "maxExpansionDepth": 1 } }
JSON
./src/cli.ts prepare --request request.json
RUN=<runDir printed above>
./src/cli.ts search --run "$RUN" --query "^[[:space:]]*//.*\[Test\]" --regex \
  --reason "locate commented-out test declarations (POSIX class, reproduces cebreo zero-match)"
./src/cli.ts search --run "$RUN" --query "//\s*\[SetUp\]" --regex \
  --reason "count commented-out test setup declarations (complete, non-truncated receipt)"
./src/cli.ts checkpoint --run "$RUN" --document overview-engineering --section 1 \
  --file section.md --claims claims.json
```

The match counts are read from the frozen receipts by the test (`tests/claim-receipt-support.test.ts`),
never hardcoded, so a regenerated receipt with a different count still exercises the same assertions.

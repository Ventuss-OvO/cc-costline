# cc-costline QA Audit Checklist

Generated: 2026-06-11

## Related Plans

| Plan | Relationship | Link |
|------|-------------|------|
| (none) | - | - |

## Scope

- **Goal:** Comprehensive quality audit for stable Windows/Linux/macOS deployment — functional testing of all modules, logic review for latent defects, cross-platform verification, performance check; fix what is found.
- **Owner:** Claude
- **Priority scheme baseline:** P0-P3 (see Planning Standards for level definitions)

## Tasks

- [x] `T01` `[P0]` Run baseline build + full unit test suite on Windows. Owner: Claude. Validation: Green test run (84/84).
- [x] `T02` `[P0]` Logic review of all src modules (cli, statusline, refresh, collector, calculator, cache) for latent defects. Owner: Claude. Validation: 7 findings, all fixed (see Verification Log).
- [x] `T03` `[P0]` Cross-platform audit: paths, tmpdir, lockfile semantics, spawn flags, encoding, HOME resolution (Windows/Linux/macOS). Owner: Claude. Validation: 2 findings fixed (BOM, shared-/tmp collision). WSL/Docker unavailable — Linux/macOS via static review; Windows verified live.
- [x] `T04` `[P1]` Functional testing of CLI surface: render via stdin (PS + cmd pipes), config, refresh, refresh-bg throttle/lock behavior. Owner: Claude. Validation: All commands exercised live; cross-process lock observed working.
- [x] `T05` `[P1]` Performance check: render hot path latency, incremental scan reuse. Owner: Claude. Validation: warm scan 24.3→19.8 ms (-18%) on synthetic 1000-file tree; refresh 87 ms live.
- [x] `T06` `[P0]` Fix confirmed defects + add regression tests. Owner: Claude. Validation: 7 fixes, 15 new tests (84→99), one commit per fix.
- [x] `T07` `[P0]` Final verification: full suite green, report delivered. Owner: Claude. Validation: 99/99 pass; end-to-end render/refresh/pricing chain verified.

## Progress

Done: 7 / 7 (100%)

## Verification Log

| Date | Task ID | Validator | Evidence | Result |
|------|---------|-----------|----------|--------|
| 2026-06-11 | T01 | Claude | `npm test` → 84 pass / 0 fail (Windows, Node 22) | Pass |
| 2026-06-11 | T02/T06 | Claude | FIX1 `b0e0181` BOM tolerance (stdin/settings/cache/config/credentials) — PS pipe render was fully blank before, renders after | Pass |
| 2026-06-11 | T03/T06 | Claude | FIX2 `d8f491a` per-user sl-* temp paths — prevents shared-/tmp lockout + cache poisoning on multi-user Linux | Pass |
| 2026-06-11 | T02/T06 | Claude | FIX3 `edd1081` cache.json shape validation — corrupted cache crashed render (`toFixed` TypeError); poisoned byDay froze incremental scan | Pass |
| 2026-06-11 | T02/T06 | Claude | FIX4 `0c9fa8a` stdin field type coercion + cmdRender try/catch | Pass |
| 2026-06-11 | T05/T06 | Claude | FIX5 `111488d` readdir withFileTypes: warm 24.3→19.8 ms, cold 115.6→110.9 ms (1000 files), identical output | Pass |
| 2026-06-11 | T02/T06 | Claude | FIX6 `3be1233` formatTokens/formatCost tier-boundary rounding (999_999→"1.0M", $999.9→"$1,000") | Pass |
| 2026-06-11 | T02/T06 | Claude | FIX7 `6b4e0d7` builtin pricing Fable 5 ($10/$50) + Opus 4.8/4.7 ($5/$25) — offline fable-5 was underpriced 3.3x | Pass |
| 2026-06-11 | T04/T07 | Claude | Live: render via PS+cmd pipes, config view, refresh 87 ms, refresh-bg lock contention handled, cloud pricing (433 entries) migrated to new path by background chain | Pass |
| 2026-06-11 | T07 | Claude | Final `npm test` → 99 pass / 0 fail (15 new regression tests) | Pass |

## Change Log

| Date | Change | Author | Reason |
|------|--------|--------|--------|
| 2026-06-11 | Created initial checklist. | Planner | Initial project planning |
| 2026-06-11 | Filled real QA tasks; T01 done. | Claude | Scope definition + baseline complete |
| 2026-06-11 | All tasks done; 7 fixes committed individually per user instruction. | Claude | Audit complete |

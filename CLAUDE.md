# cc-costline

Enhanced statusline for Claude Code — adds cost tracking, usage limits, and leaderboard rank.

## Tech Stack

- TypeScript (ESM), Node.js >= 22
- Zero runtime dependencies (devDep: `typescript`)
- Tests: `node:test` + `node:assert/strict`
- Publishing: `npm publish` (manual, no CI/CD)

## Commands

```bash
npm test        # Build (tsc) + run unit tests
npx tsc         # Build only
npm link        # Install locally for testing
npm publish     # Publish to npm
```

## Project Structure

```
src/
├── cli.ts          # CLI entry point (install/uninstall/config/refresh/refresh-bg/render)
├── statusline.ts   # render() — reads stdin + caches, spawns detached refresh-bg
├── refresh.ts      # refreshAll() — background data fetching behind a lockfile
├── collector.ts    # Incremental scan of ~/.claude/projects/**/*.jsonl
├── calculator.ts   # Per-model pricing and cost calculation
└── cache.ts        # Read/write cost cache and config (~/.cc-costline/)
test/
├── statusline.test.ts  # Unit tests for pure formatting/color functions
├── calculator.test.ts  # Unit tests for pricing lookup and cost calculation
├── cache.test.ts       # Cache/config read/write roundtrip tests
├── collector.test.ts   # Cost collection with mock jsonl files + incremental scan
└── render.test.ts      # Render output format and edge cases
```

## Data Flow

1. Claude Code calls `cc-costline render` on every turn, passing session JSON via stdin
2. `render()` reads stdin JSON, prefers Claude Code's stdin token totals, falls back to transcript token counting for older inputs, then reads three caches (no HTTP, no full directory scan):
   - **Local cost** (`~/.cc-costline/cache.json`)
   - **Usage API** (`/tmp/sl-claude-usage`)
   - **ccclub rank** (`/tmp/sl-ccclub-rank`)
3. `render()` then fire-and-forgets a detached `cc-costline refresh-bg [transcript_path]` subprocess. Throttled to once per 30 s via `/tmp/sl-refresh.last`.
4. `refresh-bg` calls `refreshAll()`, which acquires `/tmp/sl-refresh.lock` (stale-recoverable after 60 s) and then runs the three refreshers in sequence:
   - **Local cost** (2-min TTL): `collectCosts()` incremental scan — reuses per-file `{mtime, size, byDay}` entries from previous cache when files haven't changed
   - **Usage API** (5-min retry, token-aware): `api.anthropic.com/api/oauth/usage` via Node `fetch`
   - **ccclub rank** (90-s retry): `ccclub.dev/api/rank` via Node `fetch`
5. `install` also sets `SessionEnd`/`Stop` hooks to run `cc-costline refresh-bg` for non-blocking cache warmth

## Key Design Decisions

- **Non-blocking render**: render reads stdin token totals and cache files only when possible; all HTTP and jsonl directory scanning happens in a detached `refresh-bg` subprocess. Spawn is gated by `/tmp/sl-refresh.last` mtime (30-s throttle) so we don't fork node on every turn. `CC_COSTLINE_NO_SPAWN=1` disables spawn (used by tests).
- **Cross-window refresh lock**: `/tmp/sl-refresh.lock` is created atomically (`openSync(..., "wx")`) before refresh runs and unlinked after. A lock older than 60 s is treated as stale and reclaimed. This prevents 5 simultaneously-started Claude Code windows from all firing the Anthropic usage API at once.
- **Incremental cost scan**: `collectCosts(baseDir?, prevFiles?)` keys a per-file entry by `mtime + size`. Files unchanged since last scan are reused (typical 25 ms vs 2 s cold on 1000+ jsonl files). Each entry stores `byDay: Record<string, number>` (UTC day → cost), allowing the 7d/30d sliding windows to be summed from cached buckets without re-parsing. Stale day buckets are pruned when an entry is reused.
- **Day-bucket accuracy tradeoff**: 7d/30d totals carry up to ~1 day of boundary slop because cost is bucketed by UTC day, not per-entry timestamp. Negligible vs storing per-entry timestamps in cache.
- **Split TTLs**: Local cost 2 min, Anthropic usage 5 min (rate-limited), ccclub rank 90 s (self-hosted, no strict limit). Local cost cache also refreshes immediately when transcript mtime is newer than cache.
- **Token-aware retry**: Usage API cache tracks the OAuth token prefix; when Claude Code rotates the token, retry fires immediately (new token = fresh rate limit quota)
- **Resilient stale fallback**: API failures never overwrite cached data; `lastAttempt` is updated separately from `data`, so stale data persists across any number of failures. Local cost cache only keeps stale data when the scan itself fails; a successful zero-cost scan clears old totals.
- **Model name shortening**: `display_name` is shortened (e.g. "Opus 5 (1M context)" → "Opus 5 (1M)")
- **TTL-aware cache pricing**: cache writes are billed by TTL — 5-minute at 1.25x input, 1-hour at 2x. `collector.ts` passes `usage.cache_creation.ephemeral_1h_input_tokens` to `calculateCost`, which splits the flat `cache_creation_input_tokens` total accordingly (clamped, since the two fields can disagree). In practice ~90% of Claude Code cache writes are 1h, so pricing everything at the 5m rate materially undercounts.
- **Derived cache rates**: `MODEL_PRICING` entries are built by `p(input, output)`; the three cache rates are fixed multiples of input (1.25x / 2x / 0.1x) across every model, so there is one number pair to maintain per model.
- **Fast mode**: `usage.speed === "fast"` doubles the rate, but only on fast-capable models (Opus 5 / 4.8) — `speed` is ignored elsewhere.
- **Sonnet 5 intro pricing**: listed at the standard $3/$15, not the $2/$10 promo running through 2026-08-31. Keeps the table correct after the promo ends, at the cost of reading slightly high until then; adding a date dimension to a pure pricing function isn't worth a 5-week window.
- **`PRICING_VERSION` invalidates the incremental cache**: because per-file `byDay` buckets are reused whenever mtime+size are unchanged, a pricing edit would otherwise never reach files that haven't been written since — the statusline would keep showing old numbers indefinitely. `cache.json` records the version it was computed under; a mismatch makes `shouldRefreshLocalCostCache` return true regardless of TTL and makes `refreshLocalCost` drop `prevFiles` for one full re-parse. **Bump `PRICING_VERSION` in `calculator.ts` whenever the table or the cost formula changes.**
- **No User-Agent header**: The Anthropic usage API rate-limits requests with `claude-code` User-Agent
- **Deduplication**: Token cost collection deduplicates by requestId per file; fallback key includes model + all token types to avoid false dedup. No cross-file dedup (jsonl files map 1:1 to sessions; cross-file `sessionId:requestId` collisions don't occur in practice).
- **Safe settings**: `readSettings()` aborts if `settings.json` exists but is invalid JSON, preventing config wipe

## Tests

85 tests across 5 files:
- `statusline.test.ts`: formatTokens, formatCost, ctxColor, formatCountdown, rankColor, shouldRefreshLocalCostCache (incl. pricing-version invalidation)
- `calculator.test.ts`: getPricing (exact/family/unknown fallback, fable tier, current opus lineup, legacy opus rates, derived cache rates, fast mode), calculateCost (1h vs 5m cache split, clamping, fast mode)
- `cache.test.ts`: readCache/writeCache/readConfig/writeConfig roundtrip, missing file, invalid JSON
- `collector.test.ts`: collectCosts with mock jsonl — dedup (with/without requestId), 7d/30d split, nested dirs, cache tokens, 1h cache rate + no-breakdown fallback, `usage.speed` fast mode, fable pricing, model pricing, error handling, incremental scan (cache reuse, mtime change re-parse, 30d mtime skip, day-bucket pruning, files map shape)
- `render.test.ts`: render() output format, edge cases, stdin token totals, transcript token fallback, ANSI colors, period=both. Sets `CC_COSTLINE_NO_SPAWN=1` to disable background spawn during tests.

Not tested: refreshAll/refreshClaudeUsage/refreshCcclubRank (external API + keychain + lockfile), CLI commands (hardcoded paths).

## Conventions

- Keep zero runtime dependencies
- All formatting functions should be pure and tested
- Cache files go to `/tmp/sl-*`, config to `~/.cc-costline/`

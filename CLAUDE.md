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
├── calculator.ts   # Cloud (LiteLLM, official-only) + built-in pricing, cost calculation
└── cache.ts        # Read/write cost cache and config (~/.cc-costline/)
test/
├── cache.test.ts       # Cache/config read/write roundtrip tests
├── collector.test.ts   # Cost collection with mock jsonl files + incremental scan
├── refresh.test.ts     # Pure parsers + ownership-verified lock primitives
└── render.test.ts      # Render output format and edge cases
```

## Data Flow

1. Claude Code calls `cc-costline render` on every turn, passing session JSON via stdin
2. `render()` reads stdin JSON, prefers Claude Code's stdin token totals, falls back to transcript token counting for older inputs, then reads three caches (no HTTP, no full directory scan):
   - **Local cost** (`~/.cc-costline/cache.json`)
   - **Usage API** (`<os.tmpdir()>/sl-claude-usage`)
   - **ccclub rank** (`<os.tmpdir()>/sl-ccclub-rank`)
3. `render()` then fire-and-forgets a detached `cc-costline refresh-bg [transcript_path]` subprocess. Throttled to once per 30 s via `<os.tmpdir()>/sl-refresh.last`.
4. `refresh-bg` calls `refreshAll()`, which acquires `<os.tmpdir()>/sl-refresh.lock` (stale-recoverable after 5 min) and then runs the refreshers in sequence:
   - **Model pricing** (24-h TTL): LiteLLM table fetched from a 3-URL fallback chain (jsDelivr CDN → GitHub raw → GitHub raw backup), parsed to official/direct-vendor prices only, cached at `<os.tmpdir()>/sl-model-pricing`. Runs first so the cost scan below uses fresh prices. Opt out with `CC_COSTLINE_NO_PRICING_FETCH=1`.
   - **Local cost** (2-min TTL): `collectCosts()` incremental scan — reuses per-file `{mtime, size, byDay}` entries from previous cache when files haven't changed
   - **Usage API** (5-min retry, token-aware): `api.anthropic.com/api/oauth/usage` via Node `fetch`
   - **ccclub rank** (90-s retry): `ccclub.dev/api/rank` via Node `fetch`
5. `install` also sets `SessionEnd`/`Stop` hooks to run `cc-costline refresh-bg` for non-blocking cache warmth

## Key Design Decisions

- **Non-blocking render**: render reads stdin token totals and cache files only when possible; all HTTP and jsonl scanning happens in a detached `refresh-bg` subprocess. Spawn is gated by `<os.tmpdir()>/sl-refresh.last` mtime (30-s throttle) so we don't fork node on every turn. `CC_COSTLINE_NO_SPAWN=1` disables spawn (used by tests).
- **Cross-window refresh lock**: `<os.tmpdir()>/sl-refresh.lock` is created atomically (`openSync(..., "wx")`) before refresh runs, stamped with a `pid:uuid` owner token, and unlinked afterward only if we still own it. A lock older than 5 min is treated as stale and reclaimed. This prevents 5 simultaneously-started Claude Code windows from all firing the Anthropic usage API at once.
- **Incremental cost scan**: `collectCosts(baseDir?, prevFiles?)` keys a per-file entry by `mtime + size`. Files unchanged since last scan are reused (typical 25 ms vs 2 s cold on 1000+ jsonl files). Each entry stores `byDay: Record<string, number>` (UTC day → cost), allowing the 7d/30d sliding windows to be summed from cached buckets without re-parsing. Stale day buckets are pruned when an entry is reused.
- **Day-bucket accuracy tradeoff**: 7d/30d totals carry up to ~1 day of boundary slop because cost is bucketed by UTC day, not per-entry timestamp. Negligible vs storing per-entry timestamps in cache.
- **Split TTLs**: Local cost 2 min, Anthropic usage 5 min (rate-limited), ccclub rank 90 s (self-hosted, no strict limit). Local cost cache also refreshes immediately when transcript mtime is newer than cache.
- **Token-aware retry**: Usage API cache tracks a SHA256 hash of the OAuth token; when Claude Code rotates the token, retry fires immediately (new token = fresh rate limit quota)
- **Resilient stale fallback**: API failures never overwrite cached data; `lastAttempt` is updated separately from `data`, so stale data persists across any number of failures. Local cost cache only keeps stale data when the scan itself fails; a successful zero-cost scan clears old totals.
- **Cloud, official-only pricing**: Per-model prices come from LiteLLM's `model_prices_and_context_window.json` (covers ~all providers, incl. non-Claude models Claude Code can route to). `parseLiteLLMPricing()` keeps ONLY official/direct-vendor entries via a curated `litellm_provider` **allowlist** of direct/first-party APIs (`DIRECT_PROVIDERS`: anthropic, openai, gemini, xai, mistral, deepseek, moonshot, dashscope/Qwen, zai/GLM, minimax, volcengine, perplexity, groq, cerebras, …). An allowlist (not a denylist) is required to *guarantee* no multi-vendor gateway/aggregator or cloud-platform reseller price (Azure, Bedrock, Vertex, OpenRouter, vercel_ai_gateway, Fireworks, Together, novita, deepinfra, …) ever leaks — live data: ~2.8k raw → ~430 official entries. `getPricing(model, cloud?)` precedence: cloud table (with provider-prefix/date-snapshot normalization) → built-in Claude table (offline/brand-new-model bootstrap) → family heuristic → Sonnet default — so a brand-new model (e.g. `claude-fable-5`, until LiteLLM lists it) still gets a sane price. When the pricing source flips (`pricingSig` `builtin`↔`cloud`), the local cost scan is forced (bypassing its TTL) and the incremental per-file cache discarded so history is re-priced.
- **Hide 5h/7d off-subscription**: The OAuth 5h/7d limits only exist for Claude (Pro/Max) subscription logins. `usesThirdPartyApi()` (env-only, no I/O) detects `ANTHROPIC_BASE_URL`→non-Anthropic host, `CLAUDE_CODE_USE_BEDROCK`/`CLAUDE_CODE_USE_VERTEX`; render hides the segment in that case, and `refreshClaudeUsage()` also clears the stale cache when third-party OR no OAuth token (API-key-only billing).
- **Model name shortening**: `display_name` is shortened (e.g. "Opus 4.6 (1M context)" → "Opus 4.6 (1M)")
- **Custom User-Agent**: refresh requests send `User-Agent: cc-costline`. The Anthropic usage API rate-limits the default `claude-code` User-Agent, so a distinct UA sidesteps that limiter
- **Deduplication**: Token cost collection deduplicates by requestId per file; fallback key includes model + all token types to avoid false dedup. No cross-file dedup (jsonl files map 1:1 to sessions; cross-file `sessionId:requestId` collisions don't occur in practice).
- **Safe settings**: `readSettings()` aborts if `settings.json` exists but is invalid JSON, preventing config wipe

## Tests

84 tests across 4 files:
- `cache.test.ts`: readCache/writeCache/readConfig/writeConfig roundtrip, missing file, invalid JSON
- `collector.test.ts`: collectCosts with mock jsonl — dedup (with/without requestId), 7d/30d split, nested dirs, cache tokens, model pricing, error handling, incremental scan (cache reuse, mtime change re-parse, 30d mtime skip, day-bucket pruning, files map shape)
- `render.test.ts`: render() output format, edge cases, stdin token totals, transcript token fallback, ANSI colors, period=both. Sets `CC_COSTLINE_NO_SPAWN=1` to disable background spawn during tests.
- `refresh.test.ts`: pure parsers (parseUtilization, parseAnthropicReset, parseAnthropicUsage, parseCcclubRank, buildCcclubUrl) and ownership-verified lock primitives (acquireLock/releaseLock)

Not tested: refreshAll/refreshClaudeUsage/refreshCcclubRank (external API + keychain + lockfile), CLI commands (hardcoded paths).

## Conventions

- Keep zero runtime dependencies
- All formatting functions should be pure and tested
- Cache files go to `<os.tmpdir()>/sl-*` (cross-platform: `/tmp` on Linux/macOS, `%TEMP%` on Windows), config to `~/.cc-costline/`. All `sl-*` names carry a per-user suffix (uid/username via `tmpFilePath()` in cache.ts) so Linux's shared `/tmp` can't collide across users — without it, the sticky bit would let one user's stale lock freeze another user's refresh forever.

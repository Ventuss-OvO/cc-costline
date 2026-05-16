# cc-costline

Enhanced statusline for Claude Code — adds cost tracking, usage limits, and leaderboard rank.

## Tech Stack

- TypeScript (ESM), Node.js >= 22
- Zero runtime dependencies (devDep: `typescript`)
- Tests: `node:test` + `node:assert/strict`

## Commands

```bash
npm test        # Build + run unit tests
npx tsc         # Build only
npm link        # Install locally for testing
npm publish     # Publish to npm
```

## Project Structure

```
src/
├── cli.ts          # CLI entry point (install/uninstall/config/refresh/refresh-bg/render)
├── statusline.ts   # Render logic; reads stdin + caches and spawns refresh-bg
├── refresh.ts      # Background local/API/ccclub refresh behind a lockfile
├── collector.ts    # Incremental scan of ~/.claude/projects/**/*.jsonl
├── calculator.ts   # Per-model pricing and cost calculation
└── cache.ts        # Read/write cost cache and config (~/.cc-costline/)
test/
├── statusline.test.ts  # Unit tests for pure formatting/color functions
├── calculator.test.ts  # Unit tests for pricing lookup and cost calculation
├── cache.test.ts       # Cache/config read/write roundtrip tests
├── collector.test.ts   # Cost collection with mock jsonl files
├── render.test.ts      # Render output format and edge cases
└── refresh.test.ts     # Pure parsers + ownership-verified lock primitives
```

## Key Design Decisions

- **Non-blocking render**: `render()` prefers Claude Code stdin token totals, reads cache files, and only falls back to transcript token counting for older inputs. HTTP and full jsonl directory scans run in detached `refresh-bg`.
- **Split TTLs**: Local cost 2 min, Anthropic usage 5 min, ccclub rank 90 s. Local cost also refreshes immediately when transcript mtime is newer than cache.
- **Background refresh**: `refresh-bg` uses `<os.tmpdir()>/sl-refresh.lock` to prevent concurrent refreshes across windows and `<os.tmpdir()>/sl-refresh.last` to throttle spawns.
- **No curl shelling for APIs**: Usage and ccclub API calls use Node `fetch`; Keychain lookup uses `execFileSync` without shell interpolation.
- **Deduplication**: Token cost collection deduplicates by requestId; fallback key includes model + all token types to avoid false dedup.
- **Stale fallback**: API failures preserve stale data. Local cost preserves stale data only when scanning fails; a successful zero-cost scan clears old totals.
- **Safe settings**: `readSettings()` aborts if `settings.json` exists but is invalid JSON, preventing config wipe.

## Conventions

- Keep zero runtime dependencies.
- All formatting functions should be pure and tested.
- Cache files go to `<os.tmpdir()>/sl-*` (cross-platform: `/tmp` on Linux/macOS, `%TEMP%` on Windows), config to `~/.cc-costline/`.

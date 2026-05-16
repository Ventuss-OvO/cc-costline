[中文](README.zh-CN.md) | [日本語](README.ja.md) | [Français](README.fr.md) | [Español](README.es.md)

# cc-costline

Enhanced statusline for [Claude Code](https://docs.anthropic.com/en/docs/claude-code) — adds cost tracking, usage limits, and leaderboard rank to your terminal.

![cc-costline screenshot](screenshot.png)

```
14.6k $2.42 · 40% Opus 4.6 / 5h:45% · 7d:8% · 30d:$866 / #2 $67.0
```

## Install

```bash
npm i -g cc-costline && cc-costline install
```

Open a new Claude Code session and you'll see the enhanced statusline. Requires Node.js >= 22.

### Updating

npm doesn't auto-update global packages. Run this whenever you want the latest version:

```bash
npm i -g cc-costline@latest
```

## What you get

| Segment | Example | Description |
|---------|---------|-------------|
| Tokens / Cost / Context | `14.6k $2.42 · 40% Opus 4.6` | Session token count, cost, context usage, and model |
| Usage limits | `5h:45% · 7d:8%` | Claude 5-hour and 7-day utilization (auto-colored like context). At 100%, shows countdown: `5h:-03:20` |
| Period cost | `30d:$866` | Rolling cost total (configurable: 7d, 30d, or both) |
| Leaderboard | `#2 $67.0` | [ccclub](https://github.com/mazzzystar/ccclub) rank (if installed) |

### Colors

- **Context & usage limits** — green (< 60%) → orange (60-79%) → red (≥ 80%)
- **Leaderboard rank** — #1 gold, #2 white, #3 orange, others cyan
- **Period cost** — yellow

### Optional integrations

- **Claude usage limits** — reads OAuth credentials from macOS Keychain (with `~/.claude/.credentials.json` fallback on Windows/Linux). Just `claude login` and it works.
- **ccclub leaderboard** — install [ccclub](https://github.com/mazzzystar/ccclub) (`npm i -g ccclub && ccclub init`). Rank appears automatically.

Both are zero-config: if not available, the segment is silently omitted.

## Commands

```bash
cc-costline install              # Set up Claude Code integration
cc-costline uninstall            # Remove from settings
cc-costline refresh              # Manually recalculate cost cache
cc-costline config --period 7d   # Show 7-day cost (default)
cc-costline config --period 30d  # Show 30-day cost
cc-costline config --period both # Show both periods
```

## How it works

1. `install` configures `~/.claude/settings.json` — sets the statusline command and adds session-end hooks. Your existing settings are preserved.
2. `render` is called by Claude Code on every turn. It reads token totals from stdin when Claude Code provides them, then reads three caches (no HTTP, no full directory scan):
   - **Local cost** → `~/.cc-costline/cache.json`
   - **Usage limits** → `<os.tmpdir()>/sl-claude-usage`
   - **ccclub rank** → `<os.tmpdir()>/sl-ccclub-rank`
3. If any cache is stale, `render` spawns a detached `cc-costline refresh-bg` subprocess that refreshes data in the background. `<os.tmpdir()>/sl-refresh.lock` prevents concurrent refresh across multiple Claude Code windows, and `<os.tmpdir()>/sl-refresh.last` throttles spawns to once per 30 s.
4. The background refresh honors per-source TTLs:
   - **Local cost** (2-min TTL): incremental scan — per-file `mtime+size` cache reuses entries that haven't changed (~25 ms typical vs ~2 s cold on 1000+ jsonl files)
   - **Usage limits** (5-min retry, token-aware): fetches `api.anthropic.com/api/oauth/usage`. Detects OAuth token rotation to retry immediately with fresh rate limit quota. Stale data persists across failures.
   - **ccclub rank** (90 s retry): fetches `ccclub.dev/api/rank`
5. `refresh` can also be run manually to recalculate the local cost cache; session-end hooks use `refresh-bg` to warm all caches without blocking Claude Code.

<details>
<summary>Pricing table</summary>

Prices per million tokens (USD):

| Model | Input | Output | Cache Write | Cache Read |
|-------|------:|-------:|------------:|-----------:|
| Opus 4.6 | $5 | $25 | $6.25 | $0.50 |
| Opus 4.5 | $5 | $25 | $6.25 | $0.50 |
| Opus 4.1 | $15 | $75 | $18.75 | $1.50 |
| Sonnet 4.5 | $3 | $15 | $3.75 | $0.30 |
| Sonnet 4 | $3 | $15 | $3.75 | $0.30 |
| Haiku 4.5 | $1 | $5 | $1.25 | $0.10 |
| Haiku 3.5 | $0.80 | $4 | $1.00 | $0.08 |

Unknown models fall back by family name, defaulting to Sonnet pricing.

</details>

## Development

```bash
npm test    # Build + run unit tests (node:test, zero dependencies)
```

## Uninstall

```bash
cc-costline uninstall
npm uninstall -g cc-costline
```

## Acknowledgments

- [ccclub](https://github.com/mazzzystar/ccclub) by 碎瓜 ([@mazzzystar](https://github.com/mazzzystar)) — Claude Code leaderboard among friends

## License

MIT

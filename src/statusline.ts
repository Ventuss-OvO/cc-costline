import { readFileSync, writeFileSync, existsSync, statSync, utimesSync } from "node:fs";
import { spawn } from "node:child_process";
import { readCache, readConfig, stripBom, tmpFilePath } from "./cache.js";
import type { CacheData } from "./cache.js";

// TTL for local cost cache (2 minutes) — used by refresh-bg to decide whether to rescan jsonl
const CACHE_TTL_MS = 120_000;

// Throttle: render only spawns a background refresh if the last one finished > 30s ago.
// refresh-bg internally honors per-API TTLs (Anthropic 5min, ccclub 90s) so this is just
// a coarse "don't fork node every turn" gate.
const REFRESH_SPAWN_THROTTLE_MS = 30_000;
const REFRESH_LAST_MARKER = tmpFilePath("sl-refresh.last");

// ANSI colors (matching original statusline.sh)
const FG_GRAY      = "\x1b[38;5;245m";
const FG_GRAY_DIM  = "\x1b[38;5;102m";
const FG_YELLOW    = "\x1b[38;2;229;192;123m";
const FG_GREEN     = "\x1b[38;5;29m";
const FG_ORANGE    = "\x1b[38;5;208m";
const FG_RED       = "\x1b[38;5;167m";
const FG_MODEL     = "\x1b[38;2;202;124;94m";
const FG_CYAN      = "\x1b[38;5;109m";
const FG_WHITE     = "\x1b[38;5;255m";
const RESET        = "\x1b[0m";

export function formatTokens(t: number): string {
  if (t >= 1_000_000) return (t / 1_000_000).toFixed(1) + "M";
  if (t >= 1_000) return (t / 1_000).toFixed(1) + "k";
  return String(t);
}

export function formatCost(n: number): string {
  if (n >= 1000) return "$" + Math.round(n).toLocaleString("en-US");
  if (n >= 100) return "$" + n.toFixed(0);
  if (n >= 10) return "$" + n.toFixed(1);
  return "$" + n.toFixed(2);
}

export function ctxColor(pct: number): string {
  if (pct >= 80) return FG_RED;
  if (pct >= 60) return FG_ORANGE;
  return FG_GREEN;
}

export function formatCountdown(resetsAtMs: number): string {
  const remainingMs = resetsAtMs - Date.now();
  if (remainingMs <= 0) return "-00:00";
  const totalMinutes = Math.ceil(remainingMs / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `-${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

export function shouldRefreshLocalCostCache(
  cache: CacheData | null,
  transcriptPath = "",
  now = Date.now(),
): boolean {
  if (!cache) return true;

  const cacheUpdatedAt = new Date(cache.updatedAt).getTime();
  if (isNaN(cacheUpdatedAt)) return true;

  if (transcriptPath) {
    try {
      const transcriptMtime = statSync(transcriptPath).mtimeMs;
      if (transcriptMtime > cacheUpdatedAt) return true;
    } catch { }
  }

  return now - cacheUpdatedAt >= CACHE_TTL_MS;
}

export function rankColor(rank: number): string {
  if (rank === 1) return FG_YELLOW;
  if (rank === 2) return FG_WHITE;
  if (rank === 3) return FG_ORANGE;
  return FG_CYAN;
}

function envFlagEnabled(v: string | undefined): boolean {
  if (!v) return false;
  const s = v.trim().toLowerCase();
  return s !== "" && s !== "0" && s !== "false" && s !== "no" && s !== "off";
}

/**
 * True when Claude Code is talking to a non-Anthropic endpoint — a third-party /
 * proxy API (via ANTHROPIC_BASE_URL), AWS Bedrock, or Google Vertex.
 *
 * The 5h / 7d limits come from the OAuth subscription usage endpoint and only
 * exist for accounts logged in with a Claude (Pro/Max) subscription. When Claude
 * Code is pointed at a third-party model API those limits are meaningless, so the
 * statusline hides them instead of showing a misleading "5h: 0% / 7d: 0%".
 *
 * Detection is purely from environment variables inherited from the Claude Code
 * process (no I/O), keeping render fast.
 */
export function usesThirdPartyApi(env: NodeJS.ProcessEnv = process.env): boolean {
  if (envFlagEnabled(env.CLAUDE_CODE_USE_BEDROCK) || envFlagEnabled(env.CLAUDE_CODE_USE_VERTEX)) {
    return true;
  }
  const baseUrl = (env.ANTHROPIC_BASE_URL || "").trim();
  if (!baseUrl) return false;
  try {
    const host = new URL(baseUrl).host.toLowerCase();
    return !(host === "anthropic.com" || host === "api.anthropic.com" || host.endsWith(".anthropic.com"));
  } catch {
    // Non-empty but unparseable → treat as a custom endpoint.
    return true;
  }
}

// Read-only: usage data from temp cache. Refresh is done by `cc-costline refresh-bg`.
// Validates shape so a corrupted or legacy cache can't surface `5h: null%` in the UI.
function readUsageCache(): { fiveHour: number; sevenDay: number; fiveHourResetsAt?: number } | null {
  try {
    const cached = JSON.parse(readFileSync(tmpFilePath("sl-claude-usage"), "utf-8"));
    const d = cached?.data;
    if (!d || typeof d !== "object") return null;
    if (typeof d.fiveHour !== "number" || !isFinite(d.fiveHour)) return null;
    if (typeof d.sevenDay !== "number" || !isFinite(d.sevenDay)) return null;
    const out: { fiveHour: number; sevenDay: number; fiveHourResetsAt?: number } = {
      fiveHour: d.fiveHour,
      sevenDay: d.sevenDay,
    };
    if (typeof d.fiveHourResetsAt === "number" && isFinite(d.fiveHourResetsAt)) {
      out.fiveHourResetsAt = d.fiveHourResetsAt;
    }
    return out;
  } catch {
    return null;
  }
}

// Read-only: ccclub rank from temp cache. Validates shape so render can't crash on bad data.
function readRankCache(): { rank: number; total: number; cost: number } | null {
  try {
    const cached = JSON.parse(readFileSync(tmpFilePath("sl-ccclub-rank"), "utf-8"));
    const d = cached?.data;
    if (!d || typeof d !== "object") return null;
    if (typeof d.rank !== "number" || !isFinite(d.rank)) return null;
    if (typeof d.cost !== "number" || !isFinite(d.cost)) return null;
    const total = typeof d.total === "number" && isFinite(d.total) ? d.total : 0;
    return { rank: d.rank, total, cost: d.cost };
  } catch {
    return null;
  }
}

function numeric(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

// Spawn detached `cc-costline refresh-bg` subprocess. Render does NOT wait for it.
// The subprocess uses a lockfile to prevent concurrent refresh across multiple Claude Code windows.
function maybeSpawnRefresh(transcriptPath: string): void {
  if (process.env.CC_COSTLINE_NO_SPAWN) return;

  const entry = process.argv[1] || "";
  // Anchored to a path component end so `cc-costlineadmin` and other near-matches
  // don't accidentally satisfy the gate. Matches both `cc-costline`, `cc-costline.cmd`,
  // and the source-relative `dist/cli.js` form used during development.
  if (!/(^|[\\/])(cc-costline(\.cmd|\.exe)?|cli\.js)$/.test(entry)) return;

  try {
    const stat = statSync(REFRESH_LAST_MARKER);
    if (Date.now() - stat.mtimeMs < REFRESH_SPAWN_THROTTLE_MS) return;
  } catch { }

  // Touch the marker BEFORE spawning. Otherwise during a slow refresh (cold scan +
  // two HTTP fetches can easily take a few seconds), every subsequent render would
  // see the stale marker and spawn another refresh-bg subprocess. The in-process
  // lock would block them from doing real work, but we'd still fork node N times.
  try {
    const now = new Date();
    if (!existsSync(REFRESH_LAST_MARKER)) {
      writeFileSync(REFRESH_LAST_MARKER, "");
    }
    utimesSync(REFRESH_LAST_MARKER, now, now);
  } catch { }

  try {
    const child = spawn(
      process.execPath,
      [entry, "refresh-bg", transcriptPath],
      // windowsHide suppresses the brief console-window flash that Windows would
      // otherwise show for every detached subprocess.
      { detached: true, stdio: "ignore", windowsHide: true },
    );
    child.unref();
  } catch { }
}

export function render(input: string): string {
  let data: any;
  try {
    // BOM-prefixed stdin (e.g. piped through PowerShell 5.x) must not blank the line.
    data = JSON.parse(stripBom(input));
  } catch {
    return "";
  }

  // Session data from Claude Code stdin. Field types are coerced defensively —
  // a statusline must render something sane even if a field arrives malformed.
  const cost = numeric(data.cost?.total_cost_usd) ?? 0;
  const model = typeof data.model?.display_name === "string"
    ? data.model.display_name.replace(/\s*\((\d+[KMB])\s+context\)/i, " ($1)")
    : "—";
  const contextPct = Math.floor(numeric(data.context_window?.used_percentage) ?? 0);
  const transcriptPath = typeof data.transcript_path === "string" ? data.transcript_path : "";

  const inputTokens = numeric(data.context_window?.total_input_tokens);
  const outputTokens = numeric(data.context_window?.total_output_tokens);

  // Prefer Claude Code's stdin token counts. Reading the whole transcript on
  // every render gets slower as a session grows, and newer Claude Code versions
  // cancel slow statusline commands more aggressively.
  let totalTokens = inputTokens !== null || outputTokens !== null
    ? (inputTokens || 0) + (outputTokens || 0)
    : 0;

  // Fallback for older Claude Code versions that did not send token totals. The
  // transcript loop below counts ALL four token types so the displayed count
  // matches what cost was calculated from (cache_creation/cache_read included).
  if (totalTokens === 0 && inputTokens === null && outputTokens === null && transcriptPath) {
    try {
      const content = readFileSync(transcriptPath, "utf-8");
      const lines = content.split("\n");
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const entry = JSON.parse(line);
          if (entry.type === "assistant" && entry.message?.usage) {
            const u = entry.message.usage;
            totalTokens += (u.input_tokens || 0)
              + (u.output_tokens || 0)
              + (u.cache_creation_input_tokens || 0)
              + (u.cache_read_input_tokens || 0);
          }
        } catch { }
      }
    } catch { }
  }

  // All external data is read-only here. refresh-bg writes these caches in the background.
  const cache = readCache();
  const config = readConfig();
  // Hide 5h/7d when Claude Code is on a third-party API — those subscription
  // limits don't apply. (refresh-bg also clears the stale cache in this case.)
  const claudeUsage = usesThirdPartyApi() ? null : readUsageCache();
  const ccclubRank = readRankCache();

  // Fire-and-forget background refresh (throttled to once per 30s)
  maybeSpawnRefresh(transcriptPath);

  const g = FG_GRAY_DIM;
  const y = FG_YELLOW;
  const m = FG_MODEL;
  const gr = FG_GRAY;
  const r = RESET;
  const cx = ctxColor(contextPct);

  const segments: string[] = [];

  // tokens ~ $cost / ctx% by Model
  segments.push(`${formatTokens(totalTokens)} ${g}~${r} ${y}${formatCost(cost)}${r} ${g}/${r} ${cx}${contextPct}%${r} ${g}by${r} ${m}${model}${r}`);

  // 5h: X% / 7d: Y%  |  30d: $Z   (live usage and period cost are separate segments)
  const liveUsageParts: string[] = [];
  if (claudeUsage) {
    if (claudeUsage.fiveHour >= 100 && claudeUsage.fiveHourResetsAt) {
      const countdown = formatCountdown(claudeUsage.fiveHourResetsAt);
      liveUsageParts.push(`${FG_RED}5h: ${countdown}${r}`);
    } else if (claudeUsage.fiveHour >= 100) {
      liveUsageParts.push(`${FG_RED}5h: -00:00${r}`);
    } else {
      const c5 = ctxColor(claudeUsage.fiveHour);
      liveUsageParts.push(`${c5}5h: ${claudeUsage.fiveHour}%${r}`);
    }
    const c7 = ctxColor(claudeUsage.sevenDay);
    liveUsageParts.push(`${c7}7d: ${claudeUsage.sevenDay}%${r}`);
  }
  const periodCostParts: string[] = [];
  if (cache) {
    const period = config.period || "30d";
    if (period === "both") {
      periodCostParts.push(`${y}7d: ${formatCost(cache.cost7d)}${r}`);
      periodCostParts.push(`${y}30d: ${formatCost(cache.cost30d)}${r}`);
    } else {
      const periodCost = period === "7d" ? cache.cost7d : cache.cost30d;
      periodCostParts.push(`${y}${period}: ${formatCost(periodCost)}${r}`);
    }
  }
  if (liveUsageParts.length > 0) {
    segments.push(liveUsageParts.join(` ${g}/${r} `));
  }
  if (periodCostParts.length > 0) {
    segments.push(periodCostParts.join(` ${g}/${r} `));
  }

  // #2/22 $53.6   (when total is known) or #2 $53.6 (when not)
  if (ccclubRank) {
    const rc = rankColor(ccclubRank.rank);
    const rankStr = ccclubRank.total > 0
      ? `#${ccclubRank.rank}/${ccclubRank.total}`
      : `#${ccclubRank.rank}`;
    segments.push(`${rc}${rankStr} ${formatCost(ccclubRank.cost)}${r}`);
  }

  return " " + segments.join(` ${gr}|${r} `);
}

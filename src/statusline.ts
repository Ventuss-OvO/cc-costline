import { readFileSync, existsSync, statSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { execSync } from "node:child_process";
import { readCache, readConfig } from "./cache.js";
import { getZhipuUsage } from "./zhipu.js";

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
  if (remainingMs <= 0) return "~0:00";
  const totalMinutes = Math.ceil(remainingMs / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `-${hours}:${String(minutes).padStart(2, "0")}`;
}

// ccclub rank fetcher with 120s file cache
function getCcclubRank(): { rank: number; total: number; cost: number } | null {
  const configPath = join(homedir(), ".ccclub", "config.json");
  if (!existsSync(configPath)) return null;
  const cacheFile = "/tmp/sl-ccclub-rank";
  const now = Date.now() / 1000;
  if (existsSync(cacheFile)) {
    const mtime = statSync(cacheFile).mtimeMs / 1000;
    if (now - mtime <= 120) {
      try {
        return JSON.parse(readFileSync(cacheFile, "utf-8"));
      } catch { }
    }
  }
  try {
    const config = JSON.parse(readFileSync(configPath, "utf-8"));
    const code = config.groups?.[0];
    const userId = config.userId;
    if (!code || !userId) return null;
    const tz = -(new Date()).getTimezoneOffset();
    const url = `${config.apiUrl}/api/rank/${code}?period=today&tz=${tz}`;
    const response = execSync(`curl -sf "${url}"`, { encoding: "utf-8", timeout: 5000 });
    if (!response) return null;
    const data = JSON.parse(response);
    const rankings = data.rankings || [];
    const me = rankings.find((r: any) => r.userId === userId);
    if (!me) return null;
    const result = { rank: me.rank, total: rankings.length, cost: me.costUSD };
    writeFileSync(cacheFile, JSON.stringify(result), "utf-8");
    return result;
  } catch {
    return null;
  }
}

export function rankColor(rank: number): string {
  if (rank === 1) return FG_YELLOW;
  if (rank === 2) return FG_WHITE;
  if (rank === 3) return FG_ORANGE;
  return FG_CYAN;
}

// Claude usage fetcher with 60s file cache
function getClaudeUsage(): { fiveHour: number; sevenDay: number; fiveHourResetsAt?: number } | null {
  const cacheFile = "/tmp/sl-claude-usage";
  const hitFile = "/tmp/sl-claude-usage-hit";
  const now = Date.now();
  const nowSec = now / 1000;
  if (existsSync(cacheFile)) {
    const mtime = statSync(cacheFile).mtimeMs / 1000;
    if (nowSec - mtime <= 60) {
      try {
        return JSON.parse(readFileSync(cacheFile, "utf-8"));
      } catch { }
    }
  }
  try {
    const username = process.env.USER || process.env.USERNAME;
    const keychainCmd = `security find-generic-password -s "Claude Code-credentials" -a "${username}" -w 2>/dev/null`;
    const credentialsJSON = execSync(keychainCmd, { encoding: "utf-8", timeout: 2000 }).trim();
    if (!credentialsJSON) return null;
    const credentials = JSON.parse(credentialsJSON);
    const accessToken = credentials.claudeAiOauth?.accessToken;
    if (!accessToken) return null;
    const expiresAt = credentials.claudeAiOauth?.expiresAt;
    if (expiresAt && Date.now() / 1000 > expiresAt) return null;
    const apiUrl = "https://api.anthropic.com/api/oauth/usage";
    const curlCmd = `curl -sf "${apiUrl}" -H "Authorization: Bearer ${accessToken}" -H "anthropic-beta: oauth-2025-04-20" -H "User-Agent: claude-code/2.1.5"`;
    const response = execSync(curlCmd, { encoding: "utf-8", timeout: 5000 });
    if (!response) return null;
    const data = JSON.parse(response);
    const parseUtil = (val: any): number => {
      if (typeof val === "number") return Math.round(val);
      if (typeof val === "string") return Math.round(parseFloat(val.replace("%", "")));
      return 0;
    };
    const fiveHour = parseUtil(data.five_hour?.utilization);
    const sevenDay = parseUtil(data.seven_day?.utilization);

    let fiveHourResetsAt: number | undefined;

    // Strategy 1: Use reset time from API if available
    const resetsAtRaw = data.five_hour?.resets_at ?? data.five_hour?.reset_at ?? data.five_hour?.next_reset;
    if (resetsAtRaw) {
      const ts = typeof resetsAtRaw === "string" ? new Date(resetsAtRaw).getTime() : resetsAtRaw * 1000;
      if (!isNaN(ts) && ts > now) fiveHourResetsAt = ts;
    }

    // Strategy 2: Fallback - track when we first saw 100%
    if (fiveHour >= 100) {
      if (!fiveHourResetsAt) {
        if (existsSync(hitFile)) {
          const hitTime = parseFloat(readFileSync(hitFile, "utf-8").trim());
          if (!isNaN(hitTime)) {
            fiveHourResetsAt = hitTime + 5 * 3600 * 1000;
          }
        } else {
          writeFileSync(hitFile, String(now), "utf-8");
          fiveHourResetsAt = now + 5 * 3600 * 1000;
        }
      }
    } else {
      // Usage dropped below 100%, clear hit tracker
      try { if (existsSync(hitFile)) unlinkSync(hitFile); } catch {}
    }

    const result: { fiveHour: number; sevenDay: number; fiveHourResetsAt?: number } = { fiveHour, sevenDay };
    if (fiveHourResetsAt) result.fiveHourResetsAt = fiveHourResetsAt;
    writeFileSync(cacheFile, JSON.stringify(result), "utf-8");
    return result;
  } catch {
    return null;
  }
}

export async function render(input: string): Promise<string> {
  let data: any;
  try {
    data = JSON.parse(input);
  } catch {
    return "";
  }

  // Session data from Claude Code stdin
  const cost = data.cost?.total_cost_usd ?? 0;
  const model = data.model?.display_name ?? "—";
  const contextPct = Math.floor(data.context_window?.used_percentage ?? 0);

  // Token stats from transcript
  let totalTokens = 0;
  const transcriptPath = data.transcript_path ?? "";
  if (transcriptPath) {
    try {
      const content = readFileSync(transcriptPath, "utf-8");
      const lines = content.split("\n");
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const entry = JSON.parse(line);
          if (entry.type === "assistant" && entry.message?.usage) {
            totalTokens += (entry.message.usage.input_tokens || 0) + (entry.message.usage.output_tokens || 0);
          }
        } catch { }
      }
    } catch { }
  }

  const cache = readCache();
  const config = readConfig();
  const claudeUsage = getClaudeUsage();
  const g = FG_GRAY_DIM;
  const y = FG_YELLOW;
  const m = FG_MODEL;
  const gr = FG_GRAY;
  const r = RESET;
  const cx = ctxColor(contextPct);

  const segments: string[] = [];

  // tokens $cost · ctx% Model
  segments.push(`${formatTokens(totalTokens)} ${y}${formatCost(cost)}${r} ${g}·${r} ${cx}${contextPct}%${r} ${m}${model}${r}`);

  // 5h:100% · 7d:26% · 30d:$960
  const usageParts: string[] = [];
  if (claudeUsage) {
    if (claudeUsage.fiveHour >= 100 && claudeUsage.fiveHourResetsAt) {
      const countdown = formatCountdown(claudeUsage.fiveHourResetsAt);
      usageParts.push(`${FG_RED}5h:${countdown}${r}`);
    } else {
      const c5 = ctxColor(claudeUsage.fiveHour);
      usageParts.push(`${c5}5h:${claudeUsage.fiveHour}%${r}`);
    }
    const c7 = ctxColor(claudeUsage.sevenDay);
    usageParts.push(`${c7}7d:${claudeUsage.sevenDay}%${r}`);
  }
  if (cache) {
    const period = config.period || "30d";

    if (period === "both") {
      usageParts.push(`${y}7d:${formatCost(cache.cost7d)}${r}`);
      usageParts.push(`${y}30d:${formatCost(cache.cost30d)}${r}`);
    } else if (period !== "none") {
      const periodCost = period === "7d" ? cache.cost7d : cache.cost30d;
      usageParts.push(`${y}${period}:${formatCost(periodCost)}${r}`);
    }
  }
  if (usageParts.length > 0) {
    segments.push(usageParts.join(` ${g}·${r} `));
  }

  // #2 $53.6
  const ccclubRank = getCcclubRank();
  if (ccclubRank) {
    const rc = rankColor(ccclubRank.rank);
    segments.push(`${rc}#${ccclubRank.rank} ${formatCost(ccclubRank.cost)}${r}`);
  }

  // ZHIPU usage (智谱用量)
  const zhipuUsage = await getZhipuUsage();
  if (zhipuUsage && config.showZhipu !== false) {
    const zhipuParts: string[] = [];

    // 模型使用量 + 成本（24小时）
    if (zhipuUsage.modelUsage) {
      const { totalTokens, cost } = zhipuUsage.modelUsage;
      const tokens = formatTokens(totalTokens);
      const costStr = formatCost(cost);
      zhipuParts.push(`${g}ZHIPU:${tokens} ~ ${costStr}${r}`);
    }

    // 5小时 Token 限制 + 刷新时间
    if (zhipuUsage.quotaLimit?.tokens5h) {
      const { percentage, resetsAt } = zhipuUsage.quotaLimit.tokens5h;
      const color = ctxColor(percentage);

      if (percentage >= 100 && resetsAt) {
        // 显示倒计时
        const countdown = formatResetTime(resetsAt);
        zhipuParts.push(`${color}5h:${countdown}${r}`);
      } else if (config.showResetTime && resetsAt) {
        // 显示百分比 + 刷新时间
        const resetTime = formatResetTime(resetsAt);
        zhipuParts.push(`${color}5h:${percentage}% (${resetTime})${r}`);
      } else {
        // 只显示百分比
        zhipuParts.push(`${color}5h:${percentage}%${r}`);
      }
    }

    // MCP 月度使用量
    if (zhipuUsage.quotaLimit?.mcpMonthly) {
      const { current, limit, percentage } = zhipuUsage.quotaLimit.mcpMonthly;
      const color = ctxColor(percentage);
      zhipuParts.push(`${color}MCP:${current}/${limit}${r}`);
    }

    // 本月累计使用量
    if (zhipuUsage.monthlyUsage) {
      const { totalTokens, cost } = zhipuUsage.monthlyUsage;
      const tokens = formatTokens(totalTokens);
      const costStr = formatCost(cost);
      zhipuParts.push(`${y}M:${tokens} ~ ${costStr}${r}`);
    }

    if (zhipuParts.length > 0) {
      segments.push(zhipuParts.join(` ${g}·${r} `));
    }
  }

  return " " + segments.join(` ${gr}/${r} `);
}

// 刷新时间格式化函数（显示具体时间点）
function formatResetTime(resetsAt: number): string {
  // 处理不同级别的时间戳
  let resetsAtMs = resetsAt;
  
  if (resetsAt < 10000000000) {
    // 如果是秒级时间戳（小于100亿），转换为毫秒
    resetsAtMs = resetsAt * 1000;
  } else if (resetsAt > 1000000000000000) {
    // 如果是微秒级时间戳（大于1000万亿），转换为毫秒
    resetsAtMs = resetsAt / 1000;
  }
  // 否则假设已经是毫秒级时间戳

  const resetDate = new Date(resetsAtMs);
  
  // 检查时间戳是否合理
  if (isNaN(resetDate.getTime())) {
    return "02:00"; // 默认返回凌晨2点
  }

  // 格式化为 HH:MM 格式
  const hours = String(resetDate.getHours()).padStart(2, '0');
  const minutes = String(resetDate.getMinutes()).padStart(2, '0');
  return `${hours}:${minutes}`;
}

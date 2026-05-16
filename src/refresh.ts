import { readFileSync, writeFileSync, existsSync, unlinkSync, statSync, utimesSync, closeSync, openSync } from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readCache, writeCache, atomicWriteFileSync } from "./cache.js";
import { collectCosts } from "./collector.js";
import { shouldRefreshLocalCostCache } from "./statusline.js";

// Anthropic usage API: strict per-token rate limits (~5 req/token). NEVER shrink.
const ANTHROPIC_TTL_MS = 300_000;
// ccclub rank: self-hosted, no strict limits — refresh more aggressively for visible data.
const CCCLUB_TTL_MS = 90_000;

const REFRESH_LOCK = join(tmpdir(), "sl-refresh.lock");
const REFRESH_LAST = join(tmpdir(), "sl-refresh.last");
// Lock staleness: refreshAll is bounded by ~15s (local scan + 2× 5s HTTP timeouts),
// so a lock older than 5 minutes is almost certainly orphaned. The longer window
// also shrinks the TOCTOU race where a slow refresh could have its lock stolen
// just before releaseLock runs — practically unreachable now.
const HTTP_TIMEOUT_MS = 5_000;
const LOCK_STALE_MS = 5 * 60 * 1_000;

// Custom UA: avoids Anthropic's claude-code UA rate limiter and identifies the source clearly.
const USER_AGENT = "cc-costline";

// Module-level state for the ownership-verified lock. Only one refreshAll runs per process.
let LOCK_OWNER = "";

export interface UsageData {
  fiveHour: number;
  sevenDay: number;
  fiveHourResetsAt?: number;
}

export interface RankData {
  rank: number;
  total: number;
  cost: number;
}

// ─── Lock primitives ──────────────────────────────────────────────────────

/**
 * Acquire an ownership-verified refresh lock.
 *
 * Writes a unique `${pid}:${uuid}` token into the lock file so that
 * `releaseLock` can verify it owns the lock before unlinking.
 *
 * Returns true on success, false if another (non-stale) lock is held.
 */
export function acquireLock(lockPath: string = REFRESH_LOCK, staleMs: number = LOCK_STALE_MS): boolean {
  try {
    if (existsSync(lockPath)) {
      try {
        const stat = statSync(lockPath);
        if (Date.now() - stat.mtimeMs < staleMs) return false;
        unlinkSync(lockPath);
      } catch {
        return false;
      }
    }
    const owner = `${process.pid}:${randomUUID()}`;
    const fd = openSync(lockPath, "wx");
    try {
      writeFileSync(fd, owner);
    } finally {
      closeSync(fd);
    }
    LOCK_OWNER = owner;
    return true;
  } catch {
    return false;
  }
}

/**
 * Release the refresh lock IFF we still own it, then touch the spawn-throttle marker.
 *
 * Verifies ownership by comparing the lock file's contents against the token we
 * wrote in `acquireLock`. If another process has stolen the lock (after our token
 * went stale), we leave their lock alone — protects against the original race
 * where any process could delete any other process's live lock.
 *
 * Always touches REFRESH_LAST so that the spawn-throttle in statusline.ts
 * progresses regardless of whether we owned the lock at release time.
 */
export function releaseLock(lockPath: string = REFRESH_LOCK, markerPath: string = REFRESH_LAST): void {
  try {
    const contents = readFileSync(lockPath, "utf-8");
    if (contents === LOCK_OWNER && LOCK_OWNER !== "") {
      unlinkSync(lockPath);
    }
  } catch {
    // Lock might be gone, unreadable, or never existed — nothing to release.
  }
  LOCK_OWNER = "";
  touchMarker(markerPath);
}

function touchMarker(markerPath: string): void {
  try {
    const now = new Date();
    if (!existsSync(markerPath)) {
      writeFileSync(markerPath, "");
    }
    utimesSync(markerPath, now, now);
  } catch {}
}

// ─── Pure parsers (exported for tests) ────────────────────────────────────

/**
 * Coerce an Anthropic utilization value to an integer percent, or null if invalid.
 * Accepts numbers, percent strings ("42%"), or bare numeric strings ("42").
 *
 * Strict regex rejects partial numerics like "42abc" so a future schema change
 * can't smuggle a 42 through. Whitespace and optional sign are tolerated.
 */
export function parseUtilization(val: any): number | null {
  if (typeof val === "number") {
    return isFinite(val) ? Math.round(val) : null;
  }
  if (typeof val === "string") {
    if (!/^\s*-?\d+(\.\d+)?\s*%?\s*$/.test(val)) return null;
    const n = parseFloat(val.replace("%", ""));
    return isFinite(n) ? Math.round(n) : null;
  }
  return null;
}

/**
 * Coerce an Anthropic resets_at timestamp to ms-epoch, future-only.
 * Accepts ISO strings, ms-epoch numbers, or s-epoch numbers (heuristic: >1e12 = ms).
 */
export function parseAnthropicReset(raw: any, nowMs: number): number | undefined {
  if (raw == null) return undefined;
  if (typeof raw === "string") {
    const t = new Date(raw).getTime();
    return isFinite(t) && t > nowMs ? t : undefined;
  }
  if (typeof raw === "number" && isFinite(raw)) {
    const ms = raw > 1e12 ? raw : raw * 1000;
    return ms > nowMs ? ms : undefined;
  }
  return undefined;
}

/**
 * Validate and extract usage data from the Anthropic API response.
 * Returns null on schema mismatch so the caller can preserve stale cache.
 */
export function parseAnthropicUsage(data: any, nowMs: number): UsageData | null {
  if (!data || typeof data !== "object") return null;
  const fiveHour = parseUtilization(data.five_hour?.utilization);
  const sevenDay = parseUtilization(data.seven_day?.utilization);
  if (fiveHour === null || sevenDay === null) return null;

  const resetsRaw = data.five_hour?.resets_at ?? data.five_hour?.reset_at ?? data.five_hour?.next_reset;
  const fiveHourResetsAt = parseAnthropicReset(resetsRaw, nowMs);

  const result: UsageData = { fiveHour, sevenDay };
  if (fiveHourResetsAt !== undefined) result.fiveHourResetsAt = fiveHourResetsAt;
  return result;
}

/**
 * Validate and extract rank data from the ccclub API response.
 * Returns null if the user is not in the ranking list or fields are malformed.
 */
export function parseCcclubRank(data: any, userId: string): RankData | null {
  if (!data || typeof data !== "object") return null;
  const rankings = Array.isArray(data.rankings) ? data.rankings : null;
  if (!rankings) return null;
  const me = rankings.find((r: any) => r && r.userId === userId);
  if (!me) return null;
  const rank = me.rank;
  const cost = me.costUSD;
  if (typeof rank !== "number" || !isFinite(rank)) return null;
  if (typeof cost !== "number" || !isFinite(cost)) return null;
  return { rank, total: rankings.length, cost };
}

/**
 * Build a validated ccclub rank URL.
 * Returns null if apiUrl is not a parseable http(s) URL.
 *
 * Preserves any path prefix on `apiUrl` (e.g., a self-hosted ccclub mounted at
 * `https://host/ccclub` should resolve to `https://host/ccclub/api/rank/...`,
 * not `https://host/api/rank/...`).
 */
export function buildCcclubUrl(apiUrl: string, code: string, tz: number): string | null {
  if (typeof apiUrl !== "string" || !apiUrl) return null;
  let base: URL;
  try {
    base = new URL(apiUrl);
  } catch {
    return null;
  }
  if (base.protocol !== "http:" && base.protocol !== "https:") return null;

  const basePath = base.pathname.replace(/\/+$/, "");
  const fullPath = `${basePath}/api/rank/${encodeURIComponent(code)}`;
  const url = new URL(fullPath, base.origin);
  url.searchParams.set("period", "today");
  url.searchParams.set("tz", String(tz));
  return url.toString();
}

// ─── HTTP helper (Node 22 native fetch) ───────────────────────────────────

async function httpGetJSON(url: string, headers: Record<string, string> = {}): Promise<any | null> {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": USER_AGENT, ...headers },
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

// ─── Credential loading (cross-platform) ──────────────────────────────────

function loadAccessToken(nowMs: number): string {
  const credentialLoaders: Array<() => string | null> = [];

  if (process.platform === "darwin") {
    credentialLoaders.push(() => {
      try {
        const username = process.env.USER || process.env.USERNAME || "";
        return execFileSync(
          "security",
          ["find-generic-password", "-s", "Claude Code-credentials", "-a", username, "-w"],
          { encoding: "utf-8", timeout: 2000, stdio: ["pipe", "pipe", "pipe"], windowsHide: true }
        ).trim();
      } catch {
        return null;
      }
    });
  }

  credentialLoaders.push(() => {
    const credPath = join(homedir(), ".claude", ".credentials.json");
    if (!existsSync(credPath)) return null;
    try {
      return readFileSync(credPath, "utf-8");
    } catch {
      return null;
    }
  });

  for (const load of credentialLoaders) {
    const credentialsJSON = load();
    if (!credentialsJSON) continue;
    try {
      const credentials = JSON.parse(credentialsJSON);
      const token = credentials.claudeAiOauth?.accessToken || "";
      if (!token) continue;
      const expiresAt = credentials.claudeAiOauth?.expiresAt;
      if (expiresAt && nowMs > expiresAt) continue;
      return token;
    } catch {
      // Invalid JSON in this candidate — try next.
    }
  }
  return "";
}

// ─── Local cost refresh ───────────────────────────────────────────────────

function refreshLocalCost(transcriptPath: string): void {
  const cache = readCache();
  if (!shouldRefreshLocalCostCache(cache, transcriptPath)) return;
  try {
    const result = collectCosts(undefined, cache?.files);
    // Catastrophic scan failure → preserve cached value rather than zeroing it out.
    // A successful empty scan (ok: true, cost: 0) DOES overwrite — that's the user's true state.
    if (!result.ok) return;
    writeCache({
      cost7d: result.cost7d,
      cost30d: result.cost30d,
      updatedAt: new Date().toISOString(),
      files: result.files,
    });
  } catch {}
}

// ─── Anthropic usage refresh ──────────────────────────────────────────────

async function refreshClaudeUsage(): Promise<void> {
  const cacheFile = join(tmpdir(), "sl-claude-usage");
  const hitFile = join(tmpdir(), "sl-claude-usage-hit");
  const now = Date.now();

  let staleData: UsageData | null = null;
  let lastAttempt = 0;
  let cachedTokenHash = "";
  if (existsSync(cacheFile)) {
    try {
      const cached = JSON.parse(readFileSync(cacheFile, "utf-8"));
      staleData = cached.data ?? null;
      lastAttempt = cached.lastAttempt || 0;
      cachedTokenHash = cached.tokenHash || "";
    } catch {}
  }

  const accessToken = loadAccessToken(now);
  if (!accessToken) return;

  const currentTokenHash = createHash("sha256").update(accessToken).digest("hex").slice(0, 16);
  // Treat a missing hash as "unknown token" so legacy caches retry immediately on first
  // run after upgrade — populates the hash for subsequent freshness checks.
  const tokenChanged = !cachedTokenHash || currentTokenHash !== cachedTokenHash;

  if (!tokenChanged && lastAttempt && now - lastAttempt < ANTHROPIC_TTL_MS) return;

  // Mark attempt before HTTP — protects against repeated failures hammering the API.
  // Best-effort: a write failure in the background must not crash the refresh subprocess.
  try {
    atomicWriteFileSync(cacheFile, JSON.stringify({ data: staleData, lastAttempt: now, tokenHash: currentTokenHash }));
  } catch {}

  const data = await httpGetJSON("https://api.anthropic.com/api/oauth/usage", {
    Authorization: `Bearer ${accessToken}`,
    "anthropic-beta": "oauth-2025-04-20",
  });
  if (!data) return;

  const parsed = parseAnthropicUsage(data, now);
  // Schema mismatch → preserve stale data rather than overwriting with garbage.
  if (!parsed) return;

  // Handle the 100%-saturated case: when the API doesn't return a resets_at, we
  // persist a "first observed" timestamp to provide a stable 5h countdown.
  let fiveHourResetsAt = parsed.fiveHourResetsAt;
  if (parsed.fiveHour >= 100) {
    if (!fiveHourResetsAt) {
      if (existsSync(hitFile)) {
        try {
          const hitTime = parseFloat(readFileSync(hitFile, "utf-8").trim());
          if (isFinite(hitTime)) {
            const candidate = hitTime + 5 * 3600 * 1000;
            // Reject stale hitFiles where the projected reset is already in the
            // past — otherwise the countdown gets stuck at "-0:00" forever.
            if (candidate > now) {
              fiveHourResetsAt = candidate;
            } else {
              try { unlinkSync(hitFile); } catch {}
            }
          }
        } catch {}
      }
      if (!fiveHourResetsAt) {
        try { writeFileSync(hitFile, String(now), "utf-8"); } catch {}
        fiveHourResetsAt = now + 5 * 3600 * 1000;
      }
    }
  } else {
    try { if (existsSync(hitFile)) unlinkSync(hitFile); } catch {}
  }

  const result: UsageData = { fiveHour: parsed.fiveHour, sevenDay: parsed.sevenDay };
  if (fiveHourResetsAt) result.fiveHourResetsAt = fiveHourResetsAt;

  try {
    atomicWriteFileSync(cacheFile, JSON.stringify({ data: result, lastAttempt: now, tokenHash: currentTokenHash }));
  } catch {}
}

// ─── ccclub rank refresh ──────────────────────────────────────────────────

async function refreshCcclubRank(): Promise<void> {
  const configPath = join(homedir(), ".ccclub", "config.json");
  if (!existsSync(configPath)) return;
  const cacheFile = join(tmpdir(), "sl-ccclub-rank");
  const now = Date.now();

  let staleData: RankData | null = null;
  let lastAttempt = 0;
  if (existsSync(cacheFile)) {
    try {
      const cached = JSON.parse(readFileSync(cacheFile, "utf-8"));
      staleData = cached.data ?? null;
      lastAttempt = cached.lastAttempt || cached.timestamp || 0;
      if (now - lastAttempt < CCCLUB_TTL_MS) return;
    } catch {}
  }

  // Mark attempt before HTTP — best-effort, must not crash the refresh subprocess.
  try {
    atomicWriteFileSync(cacheFile, JSON.stringify({ data: staleData, timestamp: staleData ? (lastAttempt || now) : 0, lastAttempt: now }));
  } catch {}

  let config: any;
  try {
    config = JSON.parse(readFileSync(configPath, "utf-8"));
  } catch {
    return;
  }
  const code = config?.groups?.[0];
  const userId = config?.userId;
  const apiUrl = config?.apiUrl;
  if (typeof code !== "string" || !code) return;
  if (typeof userId !== "string" || !userId) return;

  const tz = -(new Date()).getTimezoneOffset();
  const url = buildCcclubUrl(apiUrl, code, tz);
  if (!url) return;

  const data = await httpGetJSON(url);
  if (!data) return;

  const result = parseCcclubRank(data, userId);
  if (!result) return;

  try {
    atomicWriteFileSync(cacheFile, JSON.stringify({ data: result, timestamp: now, lastAttempt: now }));
  } catch {}
}

// ─── Orchestration ────────────────────────────────────────────────────────

export async function refreshAll(transcriptPath = ""): Promise<void> {
  if (!acquireLock()) return;
  try {
    refreshLocalCost(transcriptPath);
    await refreshClaudeUsage();
    await refreshCcclubRank();
  } finally {
    releaseLock();
  }
}

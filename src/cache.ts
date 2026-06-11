import { readFileSync, writeFileSync, renameSync, unlinkSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir, userInfo } from "node:os";

/**
 * Atomic write: write to a unique temp file, then rename into place.
 *
 * Rename is atomic on the same filesystem, so readers will never observe a
 * truncated or partially-written file (which a direct `writeFileSync` would
 * expose if two writers race or the process crashes mid-write).
 *
 * Fails closed: if anything goes wrong, the temp file is cleaned up and the
 * error is rethrown. We deliberately do NOT fall back to a direct write,
 * because that would (a) silently break atomicity, and (b) cause user-facing
 * commands like `cc-costline install` to claim success when nothing was
 * written. Best-effort callers (background refresh) must wrap in try/catch.
 *
 * Cross-device rename is impossible here — the temp file is created in the
 * same directory as the target — so the rare error cases are truly errors.
 */
export function atomicWriteFileSync(path: string, content: string): void {
  const tmpPath = `${path}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  try {
    writeFileSync(tmpPath, content, "utf-8");
    renameSync(tmpPath, path);
  } catch (err) {
    try { unlinkSync(tmpPath); } catch {}
    throw err;
  }
}

/**
 * Strip a leading UTF-8 BOM. Node never strips it on read, and JSON.parse
 * rejects it — files saved by Windows editors (Notepad) and stdin piped
 * through PowerShell 5.x both arrive BOM-prefixed.
 */
export function stripBom(s: string): string {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

/**
 * Per-user temp file path for the sl-* cache/lock files.
 *
 * os.tmpdir() is already per-user on Windows (%TEMP%) and macOS (/var/folders/…),
 * but on Linux /tmp is SHARED across users. Fixed names like "sl-refresh.lock"
 * then collide between users on the same host, and /tmp's sticky bit prevents
 * deleting the other user's file — so the second user could never steal a stale
 * lock and their refresh (usage, rank, pricing AND local cost) froze forever.
 * Suffixing with uid (username fallback) gives each user an independent set.
 */
export function tmpFilePath(name: string): string {
  let id = "";
  try {
    const ui = userInfo();
    id = ui.uid !== -1 ? String(ui.uid) : ui.username;
  } catch {
    // No passwd entry (minimal containers) — fall back to env.
    id = process.env.USER || process.env.USERNAME || "";
  }
  const suffix = id.replace(/[^A-Za-z0-9_-]/g, "");
  return join(tmpdir(), suffix ? `${name}-${suffix}` : name);
}

const CACHE_DIR = join(homedir(), ".cc-costline");

export interface FileCostEntry {
  mtimeMs: number;
  size: number;
  // Per-day cost buckets, keyed by UTC date "YYYY-MM-DD".
  // Day-bucket accuracy means cost7d/cost30d carry up to ~1 day boundary slop, which
  // is negligible vs. the cost of storing/scanning per-entry timestamps.
  byDay: Record<string, number>;
}

export interface CacheData {
  cost7d: number;
  cost30d: number;
  updatedAt: string;
  // Optional: per-file scan cache for incremental collectCosts. Absent in legacy cache.
  files?: Record<string, FileCostEntry>;
  // Pricing source that produced `files` ("cloud" once LiteLLM pricing is loaded,
  // "builtin" otherwise). When it changes, the incremental per-file cache is
  // discarded so historical cost is re-priced under the new table. Absent in legacy cache.
  pricingSig?: string;
}

export interface ConfigData {
  period: "7d" | "30d" | "both";
}

export function readCache(dir?: string): CacheData | null {
  try {
    const raw = readFileSync(join(dir || CACHE_DIR, "cache.json"), "utf-8");
    const parsed: any = JSON.parse(stripBom(raw));
    // Shape-validate like the temp caches do: a hand-edited or corrupted
    // cache.json must read as "no cache yet", not crash render() when it
    // calls formatCost() on a non-number.
    if (!parsed || typeof parsed !== "object") return null;
    if (typeof parsed.cost7d !== "number" || !isFinite(parsed.cost7d)) return null;
    if (typeof parsed.cost30d !== "number" || !isFinite(parsed.cost30d)) return null;
    if (typeof parsed.updatedAt !== "string") return null;
    return parsed as CacheData;
  } catch {
    return null;
  }
}

export function writeCache(data: CacheData, dir?: string): void {
  const d = dir || CACHE_DIR;
  mkdirSync(d, { recursive: true });
  atomicWriteFileSync(join(d, "cache.json"), JSON.stringify(data, null, 2) + "\n");
}

const VALID_PERIODS: ReadonlyArray<ConfigData["period"]> = ["7d", "30d", "both"];

export function readConfig(dir?: string): ConfigData {
  try {
    const raw = readFileSync(join(dir || CACHE_DIR, "config.json"), "utf-8");
    const parsed = JSON.parse(stripBom(raw));
    const period = parsed?.period;
    if (VALID_PERIODS.includes(period)) return { period };
    return { period: "7d" };
  } catch {
    return { period: "7d" };
  }
}

export function writeConfig(data: ConfigData, dir?: string): void {
  const d = dir || CACHE_DIR;
  mkdirSync(d, { recursive: true });
  atomicWriteFileSync(join(d, "config.json"), JSON.stringify(data, null, 2) + "\n");
}

export { CACHE_DIR };

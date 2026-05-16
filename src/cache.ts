import { readFileSync, writeFileSync, renameSync, unlinkSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

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
}

export interface ConfigData {
  period: "7d" | "30d" | "both";
}

export function readCache(dir?: string): CacheData | null {
  try {
    const raw = readFileSync(join(dir || CACHE_DIR, "cache.json"), "utf-8");
    return JSON.parse(raw) as CacheData;
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
    const parsed = JSON.parse(raw);
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

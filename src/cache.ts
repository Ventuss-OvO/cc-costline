import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

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
  // PRICING_VERSION the cached costs were computed under. Absent in legacy cache,
  // which reads as a mismatch and triggers a full re-scan.
  pricingVersion?: number;
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
  writeFileSync(join(d, "cache.json"), JSON.stringify(data, null, 2) + "\n");
}

export function readConfig(dir?: string): ConfigData {
  try {
    const raw = readFileSync(join(dir || CACHE_DIR, "config.json"), "utf-8");
    return JSON.parse(raw) as ConfigData;
  } catch {
    return { period: "7d" };
  }
}

export function writeConfig(data: ConfigData, dir?: string): void {
  const d = dir || CACHE_DIR;
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "config.json"), JSON.stringify(data, null, 2) + "\n");
}

export { CACHE_DIR };

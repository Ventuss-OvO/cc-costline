import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

const CACHE_DIR = join(homedir(), ".cc-costline");
const CACHE_FILE = join(CACHE_DIR, "cache.json");
const CONFIG_FILE = join(CACHE_DIR, "config.json");

export interface CacheData {
  cost7d: number;
  cost30d: number;
  updatedAt: string;
}

export interface ConfigData {
  period: "none" | "7d" | "30d" | "both";
  showZhipu: boolean;
  showResetTime: boolean;  // 是否显示 5h 配额刷新时间
}

export function readCache(): CacheData | null {
  try {
    const raw = readFileSync(CACHE_FILE, "utf-8");
    return JSON.parse(raw) as CacheData;
  } catch {
    return null;
  }
}

export function writeCache(data: CacheData): void {
  mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(CACHE_FILE, JSON.stringify(data, null, 2) + "\n");
}

export function readConfig(): ConfigData {
  try {
    const raw = readFileSync(CONFIG_FILE, "utf-8");
    return JSON.parse(raw) as ConfigData;
  } catch {
    return { period: "7d", showZhipu: true, showResetTime: false };
  }
}

export function writeConfig(data: ConfigData): void {
  mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(CONFIG_FILE, JSON.stringify(data, null, 2) + "\n");
}

export { CACHE_DIR };

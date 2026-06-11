import { readFileSync, readdirSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { calculateCost } from "./calculator.js";
import type { PricingTable } from "./calculator.js";
import type { FileCostEntry } from "./cache.js";

const CLAUDE_PROJECTS_DIR = ".claude/projects";

export interface CollectResult {
  cost7d: number;
  cost30d: number;
  files: Record<string, FileCostEntry>;
  // false → catastrophic scan failure; caller should preserve any cached value.
  // true → scan completed (even if it found nothing); caller may overwrite cache.
  ok: boolean;
}

/**
 * Recursively find all .jsonl files under a directory.
 *
 * - Returns `[]` for a missing root (ENOENT) — treated as "no data yet", not a failure.
 * - Skips symbolic links to avoid following loops (no need for realpath visited set).
 * - A root read error (e.g., EACCES) throws so the caller can mark the scan failed and
 *   preserve cached cost. A nested directory that fails to read is skipped instead, so a
 *   single unreadable project can't freeze cost updates for all the readable ones.
 */
function findJsonlFiles(dir: string, isRoot = true): string[] {
  const results: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch (err: any) {
    if (err?.code === "ENOENT") return results;
    if (isRoot) throw err;
    return results;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    let stat;
    try {
      stat = lstatSync(full);
    } catch {
      continue;
    }
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) {
      results.push(...findJsonlFiles(full, false));
    } else if (stat.isFile() && entry.endsWith(".jsonl")) {
      results.push(full);
    }
  }
  return results;
}

function dayKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

function dayStartMs(key: string): number {
  return new Date(key + "T00:00:00Z").getTime();
}

/**
 * Parse a single jsonl file and bucket per-entry cost by UTC day.
 * Returns `null` on read failure so the caller does NOT cache an empty entry —
 * the file will be retried on the next scan when permissions/locks clear.
 */
function parseFile(file: string, mtimeMs: number, size: number, cutoffMs: number, pricing?: PricingTable): FileCostEntry | null {
  let content: string;
  try {
    content = readFileSync(file, "utf-8");
  } catch {
    return null;
  }

  const byDay: Record<string, number> = {};
  const seen = new Set<string>();
  const lines = content.split("\n");
  for (const line of lines) {
    if (!line.trim()) continue;

    let parsed: any;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }

    if (parsed.type !== "assistant" || !parsed.message?.usage) continue;

    const ts = new Date(parsed.timestamp).getTime();
    if (isNaN(ts) || ts < cutoffMs) continue;

    const usage = parsed.message.usage;
    const requestId = parsed.requestId || "";
    const sessionId = parsed.sessionId || "";
    const dedupeKey = requestId
      ? `${sessionId}:${requestId}`
      : `${sessionId}:${parsed.timestamp}:${parsed.message.model}:${usage.input_tokens}:${usage.output_tokens}:${usage.cache_creation_input_tokens || 0}:${usage.cache_read_input_tokens || 0}`;

    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    const cost = calculateCost(
      parsed.message.model || "unknown",
      usage.input_tokens || 0,
      usage.output_tokens || 0,
      usage.cache_creation_input_tokens || 0,
      usage.cache_read_input_tokens || 0,
      pricing,
    );

    const day = dayKey(ts);
    byDay[day] = (byDay[day] || 0) + cost;
  }

  return { mtimeMs, size, byDay };
}

/**
 * Scan all jsonl files under projectsDir and compute cost7d/cost30d.
 * Reuses prevFiles entries whose mtime+size haven't changed (incremental scan).
 *
 * Returns `ok: false` when the scan failed catastrophically (e.g., permissions
 * error on the root). Callers should preserve their existing cache in that case.
 */
export function collectCosts(
  baseDir?: string,
  prevFiles?: Record<string, FileCostEntry>,
  pricing?: PricingTable,
): CollectResult {
  const projectsDir = baseDir || join(homedir(), CLAUDE_PROJECTS_DIR);

  let files: string[];
  try {
    files = findJsonlFiles(projectsDir);
  } catch {
    return { cost7d: 0, cost30d: 0, files: {}, ok: false };
  }

  if (files.length === 0) {
    return { cost7d: 0, cost30d: 0, files: {}, ok: true };
  }

  const now = Date.now();
  const cutoff7d = now - 7 * 24 * 60 * 60 * 1000;
  const cutoff30d = now - 30 * 24 * 60 * 60 * 1000;

  const prev = prevFiles || {};
  const out: Record<string, FileCostEntry> = {};

  let cost7d = 0;
  let cost30d = 0;

  for (const file of files) {
    let stat;
    try {
      stat = lstatSync(file);
    } catch {
      continue;
    }

    // Files not touched in the last 30d cannot contribute to either window
    // (jsonl is append-only, so all entries inside are ≤ mtime).
    if (stat.mtimeMs < cutoff30d) continue;

    let entry: FileCostEntry | null;
    const cached = prev[file];
    // byDay sanity check: a corrupted cache entry must fall through to a fresh
    // parse instead of throwing in the pruning loop and freezing cache updates.
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size
        && cached.byDay && typeof cached.byDay === "object") {
      // Prune day buckets that have slid past the 30d window to keep cache from growing
      const pruned: Record<string, number> = {};
      for (const [day, cost] of Object.entries(cached.byDay)) {
        if (dayStartMs(day) >= cutoff30d) pruned[day] = cost;
      }
      entry = { mtimeMs: cached.mtimeMs, size: cached.size, byDay: pruned };
    } else {
      entry = parseFile(file, stat.mtimeMs, stat.size, cutoff30d, pricing);
    }

    // Skip files we couldn't parse — don't cache an empty entry, retry next scan.
    //
    // Deliberately we do NOT mark the whole scan as ok=false on per-file failures.
    // A single problematic file (permissions race with another tool, transient lock,
    // half-rotated log) would otherwise freeze all cache updates indefinitely.
    // Cost will appear slightly low until the file becomes readable again, which
    // is preferable to stale-forever; previously-successful entries are still
    // preserved through the prev/cached path above when mtime+size are unchanged.
    if (!entry) continue;

    out[file] = entry;

    for (const [day, cost] of Object.entries(entry.byDay)) {
      const ms = dayStartMs(day);
      if (ms >= cutoff30d) cost30d += cost;
      if (ms >= cutoff7d) cost7d += cost;
    }
  }

  return { cost7d, cost30d, files: out, ok: true };
}

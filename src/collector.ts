import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { calculateCost } from "./calculator.js";
import type { FileCostEntry } from "./cache.js";

const CLAUDE_PROJECTS_DIR = ".claude/projects";

interface CollectResult {
  cost7d: number;
  cost30d: number;
  files: Record<string, FileCostEntry>;
  scanFailed?: boolean;
}

/** Recursively find all .jsonl files under a directory */
function findJsonlFiles(dir: string, isRoot = true): { files: string[]; failed: boolean } {
  const results: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return { files: results, failed: isRoot };
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    let stat;
    try {
      stat = statSync(full);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      const nested = findJsonlFiles(full, false);
      results.push(...nested.files);
    } else if (entry.endsWith(".jsonl")) {
      results.push(full);
    }
  }
  return { files: results, failed: false };
}

function dayKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

function dayStartMs(key: string): number {
  return new Date(key + "T00:00:00Z").getTime();
}

/** Parse a single jsonl file and bucket per-entry cost by UTC day. */
function parseFile(file: string, mtimeMs: number, size: number, cutoffMs: number): FileCostEntry {
  const byDay: Record<string, number> = {};

  let content: string;
  try {
    content = readFileSync(file, "utf-8");
  } catch {
    return { mtimeMs, size, byDay };
  }

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
      {
        cacheCreation1hTokens: usage.cache_creation?.ephemeral_1h_input_tokens || 0,
        speed: usage.speed,
      },
    );

    const day = dayKey(ts);
    byDay[day] = (byDay[day] || 0) + cost;
  }

  return { mtimeMs, size, byDay };
}

/**
 * Scan all jsonl files under projectsDir and compute cost7d/cost30d.
 * Reuses prevFiles entries whose mtime+size haven't changed (incremental scan).
 */
export function collectCosts(
  baseDir?: string,
  prevFiles?: Record<string, FileCostEntry>,
): CollectResult {
  const projectsDir = baseDir || join(homedir(), CLAUDE_PROJECTS_DIR);
  try {
    if (!statSync(projectsDir).isDirectory()) {
      return { cost7d: 0, cost30d: 0, files: {} };
    }
  } catch {
    return { cost7d: 0, cost30d: 0, files: {} };
  }

  const scan = findJsonlFiles(projectsDir);
  const files = scan.files;

  if (files.length === 0) {
    return { cost7d: 0, cost30d: 0, files: {}, scanFailed: scan.failed };
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
      stat = statSync(file);
    } catch {
      continue;
    }

    // Files not touched in the last 30d cannot contribute to either window
    // (jsonl is append-only, so all entries inside are ≤ mtime).
    if (stat.mtimeMs < cutoff30d) continue;

    let entry: FileCostEntry;
    const cached = prev[file];
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      // Prune day buckets that have slid past the 30d window to keep cache from growing
      const pruned: Record<string, number> = {};
      for (const [day, cost] of Object.entries(cached.byDay)) {
        if (dayStartMs(day) >= cutoff30d) pruned[day] = cost;
      }
      entry = { mtimeMs: cached.mtimeMs, size: cached.size, byDay: pruned };
    } else {
      entry = parseFile(file, stat.mtimeMs, stat.size, cutoff30d);
    }

    out[file] = entry;

    for (const [day, cost] of Object.entries(entry.byDay)) {
      const ms = dayStartMs(day);
      if (ms >= cutoff30d) cost30d += cost;
      if (ms >= cutoff7d) cost7d += cost;
    }
  }

  return { cost7d, cost30d, files: out };
}

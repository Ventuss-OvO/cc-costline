import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync, mkdtempSync, statSync, utimesSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { collectCosts } from "../dist/collector.js";

let tmpDir: string;

function jsonlLine(overrides: Record<string, any> = {}): string {
  const now = new Date().toISOString();
  const base = {
    type: "assistant",
    timestamp: now,
    sessionId: "test-session",
    requestId: `req-${Math.random().toString(36).slice(2)}`,
    message: {
      model: "claude-sonnet-4-5-20250929",
      usage: {
        input_tokens: 1000,
        output_tokens: 500,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    },
  };

  // Deep merge overrides
  const merged = { ...base, ...overrides };
  if (overrides.message) {
    merged.message = { ...base.message, ...overrides.message };
    if (overrides.message.usage) {
      merged.message.usage = { ...base.message.usage, ...overrides.message.usage };
    }
  }
  return JSON.stringify(merged);
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "cc-collector-test-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("collectCosts", () => {
  it("returns zeros for empty directory", () => {
    mkdirSync(tmpDir, { recursive: true });
    const result = collectCosts(tmpDir);
    assert.equal(result.cost7d, 0);
    assert.equal(result.cost30d, 0);
    assert.equal(result.ok, true, "empty dir is a successful scan, not a failure");
  });

  it("returns zeros for non-existent directory", () => {
    const result = collectCosts(join(tmpDir, "nope"));
    assert.equal(result.cost7d, 0);
    assert.equal(result.cost30d, 0);
    // ENOENT is treated as "no data yet", not a catastrophic failure — the
    // caller may overwrite cache with 0 in that case.
    assert.equal(result.ok, true);
  });

  it("marks a successful scan with ok=true", () => {
    const dir = join(tmpDir, "project");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "session.jsonl"), jsonlLine() + "\n");
    const result = collectCosts(tmpDir);
    assert.equal(result.ok, true);
  });

  it("calculates cost from a single jsonl file", () => {
    const dir = join(tmpDir, "project");
    mkdirSync(dir, { recursive: true });

    // sonnet: input=$3/M, output=$15/M
    // 1000 input + 500 output = $0.003 + $0.0075 = $0.0105
    const line = jsonlLine();
    writeFileSync(join(dir, "session.jsonl"), line + "\n");

    const result = collectCosts(tmpDir);
    assert.ok(result.cost7d > 0, "cost7d should be > 0");
    assert.ok(result.cost30d > 0, "cost30d should be > 0");
    assert.ok(Math.abs(result.cost7d - 0.0105) < 0.001, `expected ~0.0105, got ${result.cost7d}`);
  });

  it("sums costs from multiple entries", () => {
    const dir = join(tmpDir, "project");
    mkdirSync(dir, { recursive: true });

    const lines = [
      jsonlLine({ requestId: "r1" }),
      jsonlLine({ requestId: "r2" }),
      jsonlLine({ requestId: "r3" }),
    ].join("\n");
    writeFileSync(join(dir, "session.jsonl"), lines + "\n");

    const result = collectCosts(tmpDir);
    assert.ok(Math.abs(result.cost7d - 0.0315) < 0.001, `expected ~0.0315, got ${result.cost7d}`);
  });

  it("deduplicates by requestId", () => {
    const dir = join(tmpDir, "project");
    mkdirSync(dir, { recursive: true });

    const lines = [
      jsonlLine({ requestId: "same-id", sessionId: "s1" }),
      jsonlLine({ requestId: "same-id", sessionId: "s1" }),
    ].join("\n");
    writeFileSync(join(dir, "session.jsonl"), lines + "\n");

    const result = collectCosts(tmpDir);
    // Should count only once
    assert.ok(Math.abs(result.cost7d - 0.0105) < 0.001, `expected ~0.0105, got ${result.cost7d}`);
  });

  it("ignores non-assistant entries", () => {
    const dir = join(tmpDir, "project");
    mkdirSync(dir, { recursive: true });

    const lines = [
      JSON.stringify({ type: "user", timestamp: new Date().toISOString(), message: { content: "hello" } }),
      JSON.stringify({ type: "system", timestamp: new Date().toISOString() }),
      jsonlLine({ requestId: "r1" }),
    ].join("\n");
    writeFileSync(join(dir, "session.jsonl"), lines + "\n");

    const result = collectCosts(tmpDir);
    assert.ok(Math.abs(result.cost7d - 0.0105) < 0.001);
  });

  it("ignores entries without usage", () => {
    const dir = join(tmpDir, "project");
    mkdirSync(dir, { recursive: true });

    const lines = [
      JSON.stringify({ type: "assistant", timestamp: new Date().toISOString(), message: { model: "claude-sonnet-4-5-20250929" } }),
      jsonlLine({ requestId: "r1" }),
    ].join("\n");
    writeFileSync(join(dir, "session.jsonl"), lines + "\n");

    const result = collectCosts(tmpDir);
    assert.ok(Math.abs(result.cost7d - 0.0105) < 0.001);
  });

  it("separates 7d and 30d costs", () => {
    const dir = join(tmpDir, "project");
    mkdirSync(dir, { recursive: true });

    const now = Date.now();
    const twoDaysAgo = new Date(now - 2 * 86400_000).toISOString();
    const fifteenDaysAgo = new Date(now - 15 * 86400_000).toISOString();

    const lines = [
      jsonlLine({ requestId: "recent", timestamp: twoDaysAgo }),
      jsonlLine({ requestId: "older", timestamp: fifteenDaysAgo }),
    ].join("\n");
    writeFileSync(join(dir, "session.jsonl"), lines + "\n");

    const result = collectCosts(tmpDir);
    // recent is in both 7d and 30d, older is only in 30d
    assert.ok(Math.abs(result.cost7d - 0.0105) < 0.001, `7d: expected ~0.0105, got ${result.cost7d}`);
    assert.ok(Math.abs(result.cost30d - 0.021) < 0.001, `30d: expected ~0.021, got ${result.cost30d}`);
  });

  it("ignores entries older than 30 days", () => {
    const dir = join(tmpDir, "project");
    mkdirSync(dir, { recursive: true });

    const old = new Date(Date.now() - 31 * 86400_000).toISOString();
    writeFileSync(join(dir, "session.jsonl"), jsonlLine({ requestId: "old", timestamp: old }) + "\n");

    const result = collectCosts(tmpDir);
    assert.equal(result.cost7d, 0);
    assert.equal(result.cost30d, 0);
  });

  it("scans nested directories", () => {
    const nested = join(tmpDir, "deep", "nested", "project");
    mkdirSync(nested, { recursive: true });

    writeFileSync(join(nested, "session.jsonl"), jsonlLine() + "\n");

    const result = collectCosts(tmpDir);
    assert.ok(result.cost7d > 0, "should find jsonl in nested dirs");
  });

  it("handles invalid JSON lines gracefully", () => {
    const dir = join(tmpDir, "project");
    mkdirSync(dir, { recursive: true });

    const lines = [
      "not valid json",
      "",
      jsonlLine({ requestId: "r1" }),
      "{broken",
    ].join("\n");
    writeFileSync(join(dir, "session.jsonl"), lines + "\n");

    const result = collectCosts(tmpDir);
    assert.ok(Math.abs(result.cost7d - 0.0105) < 0.001);
  });

  it("applies correct pricing for different models", () => {
    const dir = join(tmpDir, "project");
    mkdirSync(dir, { recursive: true });

    // opus: input=$5/M, output=$25/M → 1000*5/1M + 500*25/1M = 0.005 + 0.0125 = 0.0175
    const line = jsonlLine({
      requestId: "opus1",
      message: { model: "claude-opus-4-6", usage: { input_tokens: 1000, output_tokens: 500, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } },
    });
    writeFileSync(join(dir, "session.jsonl"), line + "\n");

    const result = collectCosts(tmpDir);
    assert.ok(Math.abs(result.cost7d - 0.0175) < 0.001, `expected ~0.0175, got ${result.cost7d}`);
  });

  it("does not falsely deduplicate entries without requestId that differ in model or cache tokens", () => {
    const dir = join(tmpDir, "project");
    mkdirSync(dir, { recursive: true });

    const ts = new Date().toISOString();
    // Two entries: same session, same timestamp, same input/output, but different model
    const line1 = JSON.stringify({
      type: "assistant", timestamp: ts, sessionId: "s1",
      message: { model: "claude-sonnet-4-5-20250929", usage: { input_tokens: 1000, output_tokens: 500, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } },
    });
    const line2 = JSON.stringify({
      type: "assistant", timestamp: ts, sessionId: "s1",
      message: { model: "claude-opus-4-6", usage: { input_tokens: 1000, output_tokens: 500, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } },
    });
    writeFileSync(join(dir, "session.jsonl"), [line1, line2].join("\n") + "\n");

    const result = collectCosts(tmpDir);
    // sonnet: 0.0105, opus: 0.0175, total: 0.028
    assert.ok(Math.abs(result.cost7d - 0.028) < 0.001, `expected ~0.028, got ${result.cost7d}`);
  });

  it("does not falsely deduplicate entries without requestId that differ in cache tokens", () => {
    const dir = join(tmpDir, "project");
    mkdirSync(dir, { recursive: true });

    const ts = new Date().toISOString();
    const line1 = JSON.stringify({
      type: "assistant", timestamp: ts, sessionId: "s1",
      message: { model: "claude-sonnet-4-5-20250929", usage: { input_tokens: 1000, output_tokens: 500, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } },
    });
    const line2 = JSON.stringify({
      type: "assistant", timestamp: ts, sessionId: "s1",
      message: { model: "claude-sonnet-4-5-20250929", usage: { input_tokens: 1000, output_tokens: 500, cache_creation_input_tokens: 5000, cache_read_input_tokens: 0 } },
    });
    writeFileSync(join(dir, "session.jsonl"), [line1, line2].join("\n") + "\n");

    const result = collectCosts(tmpDir);
    // line1: 0.0105, line2: 0.0105 + 5000*3.75/1M = 0.0105 + 0.01875 = 0.02925
    const expected = 0.0105 + 0.02925;
    assert.ok(Math.abs(result.cost7d - expected) < 0.001, `expected ~${expected}, got ${result.cost7d}`);
  });

  it("returns per-file scan cache in result.files", () => {
    const dir = join(tmpDir, "project");
    mkdirSync(dir, { recursive: true });
    const filePath = join(dir, "session.jsonl");
    writeFileSync(filePath, jsonlLine({ requestId: "r1" }) + "\n");

    const result = collectCosts(tmpDir) as any;
    assert.ok(result.files, "should return files map");
    assert.ok(result.files[filePath], `should include entry for ${filePath}`);
    const entry = result.files[filePath];
    assert.equal(typeof entry.mtimeMs, "number");
    assert.equal(typeof entry.size, "number");
    assert.ok(entry.byDay, "should have byDay buckets");
  });

  it("reuses cached entry when file mtime/size unchanged", () => {
    const dir = join(tmpDir, "project");
    mkdirSync(dir, { recursive: true });
    const filePath = join(dir, "session.jsonl");
    writeFileSync(filePath, jsonlLine({ requestId: "r1" }) + "\n");

    const first = collectCosts(tmpDir) as any;
    const firstEntry = first.files[filePath];

    // Re-run with prev cache. File untouched → entry should be reused (same byDay).
    const second = collectCosts(tmpDir, first.files) as any;
    const secondEntry = second.files[filePath];

    assert.equal(secondEntry.mtimeMs, firstEntry.mtimeMs);
    assert.equal(secondEntry.size, firstEntry.size);
    assert.deepEqual(secondEntry.byDay, firstEntry.byDay);
    assert.ok(Math.abs(second.cost7d - first.cost7d) < 0.0001);
  });

  it("re-parses file when mtime changes", () => {
    const dir = join(tmpDir, "project");
    mkdirSync(dir, { recursive: true });
    const filePath = join(dir, "session.jsonl");
    writeFileSync(filePath, jsonlLine({ requestId: "r1" }) + "\n");

    const first = collectCosts(tmpDir) as any;
    const firstCost = first.cost7d;

    // Append another entry, mtime + size both change
    appendFileSync(filePath, jsonlLine({ requestId: "r2" }) + "\n");
    // Force a new mtime in case the second write happened in the same millisecond
    const future = new Date(Date.now() + 1000);
    utimesSync(filePath, future, future);

    const second = collectCosts(tmpDir, first.files) as any;
    assert.ok(second.cost7d > firstCost, `expected cost to grow after append, got ${second.cost7d} vs ${firstCost}`);
  });

  it("skips files with mtime older than 30 days", () => {
    const dir = join(tmpDir, "project");
    mkdirSync(dir, { recursive: true });
    const filePath = join(dir, "old.jsonl");
    // Write a line with timestamp inside 30d (shouldn't matter — mtime gate hits first)
    writeFileSync(filePath, jsonlLine({ requestId: "r1" }) + "\n");
    const oldDate = new Date(Date.now() - 40 * 86400_000);
    utimesSync(filePath, oldDate, oldDate);

    const result = collectCosts(tmpDir) as any;
    assert.equal(result.cost7d, 0);
    assert.equal(result.cost30d, 0);
    assert.equal(result.files[filePath], undefined, "should not include stale file in files map");
  });

  it("prunes day buckets that have slid past the 30d window when reusing cached entry", () => {
    const dir = join(tmpDir, "project");
    mkdirSync(dir, { recursive: true });
    const filePath = join(dir, "session.jsonl");
    writeFileSync(filePath, jsonlLine({ requestId: "r1" }) + "\n");
    const stat = statSync(filePath);

    // Synthesize a prev cache that includes an ancient day bucket (40 days ago)
    const ancientDay = (() => {
      const d = new Date(Date.now() - 40 * 86400_000);
      return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
    })();
    const prev = {
      [filePath]: {
        mtimeMs: stat.mtimeMs,
        size: stat.size,
        byDay: { [ancientDay]: 999, "2026-05-14": 0.5 },
      },
    };

    const result = collectCosts(tmpDir, prev) as any;
    const entry = result.files[filePath];
    assert.equal(entry.byDay[ancientDay], undefined, "ancient day should be pruned");
  });

  it("includes cache token costs", () => {
    const dir = join(tmpDir, "project");
    mkdirSync(dir, { recursive: true });

    // sonnet cache: write=$3.75/M, read=$0.30/M
    // 10000 cache_write + 50000 cache_read = 0.0375 + 0.015 = 0.0525
    // plus input/output: 0 + 0 = 0
    const line = jsonlLine({
      requestId: "cache1",
      message: {
        model: "claude-sonnet-4-5-20250929",
        usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 10000, cache_read_input_tokens: 50000 },
      },
    });
    writeFileSync(join(dir, "session.jsonl"), line + "\n");

    const result = collectCosts(tmpDir);
    assert.ok(Math.abs(result.cost7d - 0.0525) < 0.001, `expected ~0.0525, got ${result.cost7d}`);
  });
});

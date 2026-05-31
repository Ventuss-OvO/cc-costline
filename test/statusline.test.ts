import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  formatTokens,
  formatCost,
  ctxColor,
  formatCountdown,
  rankColor,
  shouldRefreshLocalCostCache,
} from "../dist/statusline.js";

describe("formatTokens", () => {
  it("formats millions", () => {
    assert.equal(formatTokens(1_500_000), "1.5M");
    assert.equal(formatTokens(2_000_000), "2.0M");
  });

  it("formats thousands", () => {
    assert.equal(formatTokens(1_500), "1.5k");
    assert.equal(formatTokens(14_600), "14.6k");
  });

  it("formats small numbers as-is", () => {
    assert.equal(formatTokens(0), "0");
    assert.equal(formatTokens(999), "999");
  });
});

describe("formatCost", () => {
  it("formats large costs (>= $1000) with no decimals", () => {
    assert.equal(formatCost(1234), "$1,234");
    assert.equal(formatCost(9999.5), "$10,000");
  });

  it("formats medium costs (>= $100) with no decimals", () => {
    assert.equal(formatCost(100), "$100");
    assert.equal(formatCost(866.3), "$866");
  });

  it("formats small-medium costs (>= $10) with 1 decimal", () => {
    assert.equal(formatCost(10), "$10.0");
    assert.equal(formatCost(53.67), "$53.7");
  });

  it("formats small costs with 2 decimals", () => {
    assert.equal(formatCost(0), "$0.00");
    assert.equal(formatCost(2.42), "$2.42");
    assert.equal(formatCost(9.99), "$9.99");
  });
});

describe("ctxColor", () => {
  it("returns red for >= 80%", () => {
    assert.equal(ctxColor(80), "\x1b[38;5;167m");
    assert.equal(ctxColor(100), "\x1b[38;5;167m");
  });

  it("returns orange for 60-79%", () => {
    assert.equal(ctxColor(60), "\x1b[38;5;208m");
    assert.equal(ctxColor(79), "\x1b[38;5;208m");
  });

  it("returns green for < 60%", () => {
    assert.equal(ctxColor(0), "\x1b[38;5;29m");
    assert.equal(ctxColor(59), "\x1b[38;5;29m");
  });
});

describe("formatCountdown", () => {
  it("formats hours and minutes", () => {
    const now = Date.now();
    assert.equal(formatCountdown(now + 3 * 3600_000 + 20 * 60_000), "-03:20");
  });

  it("formats minutes only (< 1 hour)", () => {
    const now = Date.now();
    assert.equal(formatCountdown(now + 45 * 60_000), "-00:45");
  });

  it("shows -00:00 when past reset time", () => {
    assert.equal(formatCountdown(Date.now() - 1000), "-00:00");
  });

  it("pads minutes to 2 digits", () => {
    const now = Date.now();
    assert.equal(formatCountdown(now + 2 * 3600_000 + 5 * 60_000), "-02:05");
  });
});

describe("rankColor", () => {
  it("returns yellow for #1", () => {
    assert.equal(rankColor(1), "\x1b[38;2;229;192;123m");
  });

  it("returns white for #2", () => {
    assert.equal(rankColor(2), "\x1b[38;5;255m");
  });

  it("returns orange for #3", () => {
    assert.equal(rankColor(3), "\x1b[38;5;208m");
  });

  it("returns cyan for others", () => {
    assert.equal(rankColor(4), "\x1b[38;5;109m");
    assert.equal(rankColor(10), "\x1b[38;5;109m");
  });
});

describe("shouldRefreshLocalCostCache", () => {
  it("refreshes when cache is missing", () => {
    assert.equal(shouldRefreshLocalCostCache(null, ""), true);
  });

  it("refreshes immediately when transcript is newer than cache", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "cc-costline-statusline-"));
    try {
      const transcriptPath = join(tmpDir, "session.jsonl");
      writeFileSync(transcriptPath, "{}\n");

      const now = new Date("2026-03-17T10:00:00.000Z");
      utimesSync(transcriptPath, now, now);

      const cache = {
        cost7d: 1,
        cost30d: 2,
        updatedAt: new Date(now.getTime() - 5_000).toISOString(),
      };

      assert.equal(shouldRefreshLocalCostCache(cache, transcriptPath, now.getTime()), true);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("keeps fresh cache when transcript has not changed", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "cc-costline-statusline-"));
    try {
      const transcriptPath = join(tmpDir, "session.jsonl");
      writeFileSync(transcriptPath, "{}\n");

      const now = new Date("2026-03-17T10:00:00.000Z");
      const transcriptTime = new Date(now.getTime() - 10_000);
      utimesSync(transcriptPath, transcriptTime, transcriptTime);

      const cache = {
        cost7d: 1,
        cost30d: 2,
        updatedAt: new Date(now.getTime() - 5_000).toISOString(),
      };

      assert.equal(shouldRefreshLocalCostCache(cache, transcriptPath, now.getTime()), false);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

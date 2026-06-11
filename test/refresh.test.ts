import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  parseUtilization,
  parseAnthropicReset,
  parseAnthropicUsage,
  parseCcclubRank,
  buildCcclubUrl,
  acquireLock,
  releaseLock,
} from "../dist/refresh.js";

// ─── parseUtilization ─────────────────────────────────────────────────────

describe("parseUtilization", () => {
  it("rounds finite numbers", () => {
    assert.equal(parseUtilization(42), 42);
    assert.equal(parseUtilization(42.4), 42);
    assert.equal(parseUtilization(42.6), 43);
    assert.equal(parseUtilization(0), 0);
  });

  it("parses percent strings", () => {
    assert.equal(parseUtilization("42%"), 42);
    assert.equal(parseUtilization("42.6%"), 43);
    assert.equal(parseUtilization("100%"), 100);
  });

  it("parses bare numeric strings", () => {
    assert.equal(parseUtilization("42"), 42);
    assert.equal(parseUtilization("0"), 0);
  });

  it("returns null for invalid values", () => {
    assert.equal(parseUtilization(null), null);
    assert.equal(parseUtilization(undefined), null);
    assert.equal(parseUtilization(NaN), null);
    assert.equal(parseUtilization(Infinity), null);
    assert.equal(parseUtilization("abc"), null);
    assert.equal(parseUtilization({}), null);
    assert.equal(parseUtilization([]), null);
  });

  it("rejects partial-numeric strings like '42abc'", () => {
    // Without the strict regex, parseFloat('42abc') would yield 42.
    assert.equal(parseUtilization("42abc"), null);
    assert.equal(parseUtilization("42 percent"), null);
    assert.equal(parseUtilization("0x42"), null);
    assert.equal(parseUtilization("4.2.1"), null);
  });

  it("tolerates surrounding whitespace and sign", () => {
    assert.equal(parseUtilization("  42  "), 42);
    assert.equal(parseUtilization("-5%"), -5);
  });
});

// ─── parseAnthropicReset ──────────────────────────────────────────────────

describe("parseAnthropicReset", () => {
  const now = Date.parse("2026-01-01T00:00:00Z");

  it("parses ISO string in the future", () => {
    const future = "2026-01-01T01:00:00Z";
    assert.equal(parseAnthropicReset(future, now), Date.parse(future));
  });

  it("returns undefined for ISO string in the past", () => {
    assert.equal(parseAnthropicReset("2025-12-31T23:00:00Z", now), undefined);
  });

  it("treats large numeric value as milliseconds", () => {
    const futureMs = now + 3600_000;
    assert.equal(parseAnthropicReset(futureMs, now), futureMs);
  });

  it("treats small numeric value as seconds", () => {
    const futureS = (now + 3600_000) / 1000;
    assert.equal(parseAnthropicReset(futureS, now), Math.floor(futureS) * 1000);
  });

  it("returns undefined for past numeric timestamps", () => {
    assert.equal(parseAnthropicReset(now - 1000, now), undefined);
    assert.equal(parseAnthropicReset((now - 1000) / 1000, now), undefined);
  });

  it("returns undefined for invalid input", () => {
    assert.equal(parseAnthropicReset(null, now), undefined);
    assert.equal(parseAnthropicReset(undefined, now), undefined);
    assert.equal(parseAnthropicReset("not a date", now), undefined);
    assert.equal(parseAnthropicReset(NaN, now), undefined);
    assert.equal(parseAnthropicReset(Infinity, now), undefined);
  });
});

// ─── parseAnthropicUsage ──────────────────────────────────────────────────

describe("parseAnthropicUsage", () => {
  const now = Date.parse("2026-01-01T00:00:00Z");

  it("parses a typical valid response", () => {
    const result = parseAnthropicUsage(
      {
        five_hour: { utilization: 42, resets_at: "2026-01-01T01:00:00Z" },
        seven_day: { utilization: "65%" },
      },
      now,
    );
    assert.deepEqual(result, {
      fiveHour: 42,
      sevenDay: 65,
      fiveHourResetsAt: Date.parse("2026-01-01T01:00:00Z"),
    });
  });

  it("returns null when five_hour.utilization is missing", () => {
    assert.equal(parseAnthropicUsage({ seven_day: { utilization: 10 } }, now), null);
  });

  it("returns null when seven_day.utilization is missing", () => {
    assert.equal(parseAnthropicUsage({ five_hour: { utilization: 10 } }, now), null);
  });

  it("returns null when utilization is NaN", () => {
    assert.equal(
      parseAnthropicUsage(
        { five_hour: { utilization: "garbage" }, seven_day: { utilization: 10 } },
        now,
      ),
      null,
    );
  });

  it("returns null for non-object input", () => {
    assert.equal(parseAnthropicUsage(null, now), null);
    assert.equal(parseAnthropicUsage("string", now), null);
    assert.equal(parseAnthropicUsage(42, now), null);
  });

  it("omits resets_at when API doesn't return it", () => {
    const result = parseAnthropicUsage(
      { five_hour: { utilization: 100 }, seven_day: { utilization: 50 } },
      now,
    );
    assert.deepEqual(result, { fiveHour: 100, sevenDay: 50 });
  });

  it("accepts reset_at and next_reset as fallback keys", () => {
    const futureMs = now + 3600_000;
    const r1 = parseAnthropicUsage(
      { five_hour: { utilization: 50, reset_at: futureMs }, seven_day: { utilization: 50 } },
      now,
    );
    assert.equal(r1?.fiveHourResetsAt, futureMs);

    const r2 = parseAnthropicUsage(
      { five_hour: { utilization: 50, next_reset: futureMs }, seven_day: { utilization: 50 } },
      now,
    );
    assert.equal(r2?.fiveHourResetsAt, futureMs);
  });
});

// ─── parseCcclubRank ──────────────────────────────────────────────────────

describe("parseCcclubRank", () => {
  it("extracts the matching user's rank", () => {
    const data = {
      rankings: [
        { userId: "u1", rank: 1, costUSD: 100 },
        { userId: "u2", rank: 2, costUSD: 50 },
      ],
    };
    assert.deepEqual(parseCcclubRank(data, "u2"), { rank: 2, total: 2, cost: 50 });
  });

  it("returns null when user is not in rankings", () => {
    const data = { rankings: [{ userId: "u1", rank: 1, costUSD: 100 }] };
    assert.equal(parseCcclubRank(data, "missing"), null);
  });

  it("returns null when rankings is not an array", () => {
    assert.equal(parseCcclubRank({ rankings: "not array" }, "u1"), null);
    assert.equal(parseCcclubRank({}, "u1"), null);
    assert.equal(parseCcclubRank(null, "u1"), null);
  });

  it("returns null when rank is non-numeric", () => {
    const data = { rankings: [{ userId: "u1", rank: "1", costUSD: 100 }] };
    assert.equal(parseCcclubRank(data, "u1"), null);
  });

  it("returns null when costUSD is missing or NaN", () => {
    assert.equal(parseCcclubRank({ rankings: [{ userId: "u1", rank: 1 }] }, "u1"), null);
    assert.equal(parseCcclubRank({ rankings: [{ userId: "u1", rank: 1, costUSD: NaN }] }, "u1"), null);
    assert.equal(parseCcclubRank({ rankings: [{ userId: "u1", rank: 1, costUSD: "free" }] }, "u1"), null);
  });

  it("skips malformed entries before the target", () => {
    const data = { rankings: [null, undefined, { userId: "u1", rank: 1, costUSD: 100 }] };
    assert.deepEqual(parseCcclubRank(data, "u1"), { rank: 1, total: 3, cost: 100 });
  });
});

// ─── buildCcclubUrl ───────────────────────────────────────────────────────

describe("buildCcclubUrl", () => {
  it("builds an https URL with code and tz", () => {
    const url = buildCcclubUrl("https://ccclub.dev", "groupX", 480);
    assert.equal(url, "https://ccclub.dev/api/rank/groupX?period=today&tz=480");
  });

  it("encodes special characters in code", () => {
    const url = buildCcclubUrl("https://ccclub.dev", "group/with spaces", 0);
    assert.ok(url?.includes("group%2Fwith%20spaces"), `expected encoded code, got: ${url}`);
  });

  it("strips trailing slash on apiUrl gracefully", () => {
    const url = buildCcclubUrl("https://ccclub.dev/", "g", 0);
    assert.equal(url, "https://ccclub.dev/api/rank/g?period=today&tz=0");
  });

  it("preserves a path prefix on apiUrl (self-hosted on a subpath)", () => {
    const url = buildCcclubUrl("https://host.example/ccclub", "g", 0);
    assert.equal(url, "https://host.example/ccclub/api/rank/g?period=today&tz=0");
  });

  it("preserves a path prefix with trailing slash", () => {
    const url = buildCcclubUrl("https://host.example/ccclub/", "g", 0);
    assert.equal(url, "https://host.example/ccclub/api/rank/g?period=today&tz=0");
  });

  it("preserves a deep path prefix", () => {
    const url = buildCcclubUrl("https://host.example/app/v2/ccclub", "g", 0);
    assert.equal(url, "https://host.example/app/v2/ccclub/api/rank/g?period=today&tz=0");
  });

  it("accepts http:// for self-hosted clubs", () => {
    const url = buildCcclubUrl("http://localhost:8080", "g", 0);
    assert.equal(url, "http://localhost:8080/api/rank/g?period=today&tz=0");
  });

  it("rejects non-http(s) protocols", () => {
    assert.equal(buildCcclubUrl("javascript:alert(1)", "g", 0), null);
    assert.equal(buildCcclubUrl("file:///etc/passwd", "g", 0), null);
    assert.equal(buildCcclubUrl("ftp://example.com", "g", 0), null);
  });

  it("rejects unparseable URLs", () => {
    assert.equal(buildCcclubUrl("not a url", "g", 0), null);
    assert.equal(buildCcclubUrl("", "g", 0), null);
  });

  it("rejects non-string apiUrl", () => {
    assert.equal(buildCcclubUrl(null as any, "g", 0), null);
    assert.equal(buildCcclubUrl(undefined as any, "g", 0), null);
    assert.equal(buildCcclubUrl(42 as any, "g", 0), null);
  });
});

// ─── acquireLock / releaseLock ────────────────────────────────────────────

describe("acquireLock + releaseLock", () => {
  let tmpDir: string;
  let lockPath: string;
  let markerPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "cc-lock-test-"));
    lockPath = join(tmpDir, "lock");
    markerPath = join(tmpDir, "marker");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("acquires a fresh lock and writes an owner token", () => {
    const acquired = acquireLock(lockPath, 60_000);
    assert.equal(acquired, true);
    assert.ok(existsSync(lockPath), "lock file should exist after acquire");
    const owner = readFileSync(lockPath, "utf-8");
    assert.match(owner, /^\d+:[0-9a-f-]+$/, `unexpected owner token: ${owner}`);
  });

  it("releaseLock unlinks the lock we own and touches the marker", () => {
    acquireLock(lockPath, 60_000);
    releaseLock(lockPath, markerPath);
    assert.equal(existsSync(lockPath), false, "lock should be removed after release");
    assert.ok(existsSync(markerPath), "marker should be touched on release");
  });

  it("releaseLock does NOT remove a lock we don't own", () => {
    acquireLock(lockPath, 60_000);
    // Simulate another process stealing the lock.
    writeFileSync(lockPath, "9999:foreign-owner");

    releaseLock(lockPath, markerPath);
    assert.equal(existsSync(lockPath), true, "foreign-owned lock must NOT be unlinked");
    assert.equal(readFileSync(lockPath, "utf-8"), "9999:foreign-owner");
  });

  it("returns false when a fresh lock is held by another", () => {
    writeFileSync(lockPath, "9999:foreign-owner");

    const acquired = acquireLock(lockPath, 60_000);
    assert.equal(acquired, false);
    // Foreign lock contents must be unchanged.
    assert.equal(readFileSync(lockPath, "utf-8"), "9999:foreign-owner");
  });

  it("steals a stale lock past the staleMs threshold", () => {
    writeFileSync(lockPath, "9999:foreign-owner");
    // Mark the lock as 2 hours old.
    const twoHoursAgo = new Date(Date.now() - 2 * 3600 * 1000);
    utimesSync(lockPath, twoHoursAgo, twoHoursAgo);

    const acquired = acquireLock(lockPath, 60_000);
    assert.equal(acquired, true, "stale lock should have been reclaimed");
    // The owner token should now be ours, not the foreign one.
    const owner = readFileSync(lockPath, "utf-8");
    assert.notEqual(owner, "9999:foreign-owner");
  });

  it("touches marker even when there's nothing to unlink", () => {
    // No lock acquired before; releaseLock should still touch the marker.
    releaseLock(lockPath, markerPath);
    assert.ok(existsSync(markerPath), "marker should be touched regardless of lock state");
  });
});

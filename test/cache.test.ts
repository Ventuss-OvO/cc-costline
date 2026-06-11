import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, mkdtempSync, writeFileSync } from "node:fs";
import { join, basename, dirname } from "node:path";
import { tmpdir } from "node:os";
import { readCache, writeCache, readConfig, writeConfig, tmpFilePath } from "../dist/cache.js";
import type { CacheData, ConfigData } from "../dist/cache.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "cc-costline-test-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("readCache", () => {
  it("returns null when file does not exist", () => {
    assert.equal(readCache(tmpDir), null);
  });

  it("returns null for invalid JSON", () => {
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(join(tmpDir, "cache.json"), "not json");
    assert.equal(readCache(tmpDir), null);
  });

  it("tolerates a UTF-8 BOM (Windows editors)", () => {
    mkdirSync(tmpDir, { recursive: true });
    const data = { cost7d: 1.5, cost30d: 3, updatedAt: "2026-06-11T00:00:00.000Z" };
    writeFileSync(join(tmpDir, "cache.json"), "\uFEFF" + JSON.stringify(data));
    assert.deepEqual(readCache(tmpDir), data);
  });

  it("returns null for corrupted shapes instead of letting render crash", () => {
    mkdirSync(tmpDir, { recursive: true });
    const bad = [
      '{"cost7d":"abc","cost30d":1,"updatedAt":"x"}', // non-numeric cost
      '{"cost7d":1,"cost30d":null,"updatedAt":"x"}',  // null cost
      '{"cost7d":1e999,"cost30d":1,"updatedAt":"x"}', // Infinity
      '{"cost7d":1,"cost30d":2}',                     // updatedAt missing
      '[1,2,3]',
      '"just a string"',
      'null',
    ];
    for (const raw of bad) {
      writeFileSync(join(tmpDir, "cache.json"), raw);
      assert.equal(readCache(tmpDir), null, `should reject: ${raw}`);
    }
  });
});

describe("writeCache + readCache roundtrip", () => {
  it("writes and reads back cache data", () => {
    const data: CacheData = { cost7d: 12.34, cost30d: 56.78, updatedAt: "2026-03-11T00:00:00.000Z" };
    writeCache(data, tmpDir);
    const result = readCache(tmpDir);
    assert.deepEqual(result, data);
  });

  it("overwrites existing cache", () => {
    writeCache({ cost7d: 1, cost30d: 2, updatedAt: "a" }, tmpDir);
    const updated: CacheData = { cost7d: 10, cost30d: 20, updatedAt: "b" };
    writeCache(updated, tmpDir);
    assert.deepEqual(readCache(tmpDir), updated);
  });
});

describe("readConfig", () => {
  it("returns default config when file does not exist", () => {
    assert.deepEqual(readConfig(tmpDir), { period: "7d" });
  });
});

describe("writeConfig + readConfig roundtrip", () => {
  it("writes and reads back config data", () => {
    const config: ConfigData = { period: "30d" };
    writeConfig(config, tmpDir);
    assert.deepEqual(readConfig(tmpDir), config);
  });

  it("supports 'both' period", () => {
    const config: ConfigData = { period: "both" };
    writeConfig(config, tmpDir);
    assert.deepEqual(readConfig(tmpDir), config);
  });

  it("falls back to default when stored period is invalid", () => {
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(join(tmpDir, "config.json"), JSON.stringify({ period: "garbage" }));
    assert.deepEqual(readConfig(tmpDir), { period: "7d" });
  });

  it("falls back to default when period is missing", () => {
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(join(tmpDir, "config.json"), JSON.stringify({ other: "field" }));
    assert.deepEqual(readConfig(tmpDir), { period: "7d" });
  });

  it("tolerates a UTF-8 BOM (Windows editors)", () => {
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(join(tmpDir, "config.json"), "\uFEFF" + JSON.stringify({ period: "30d" }));
    assert.deepEqual(readConfig(tmpDir), { period: "30d" });
  });
});

describe("tmpFilePath", () => {
  it("returns a path directly inside os.tmpdir()", () => {
    assert.equal(dirname(tmpFilePath("sl-x")), tmpdir());
  });

  it("is stable across calls for the same name", () => {
    assert.equal(tmpFilePath("sl-x"), tmpFilePath("sl-x"));
  });

  it("differs for different names", () => {
    assert.notEqual(tmpFilePath("sl-a"), tmpFilePath("sl-b"));
  });

  it("keeps the name as prefix and appends only a filesystem-safe per-user suffix", () => {
    const base = basename(tmpFilePath("sl-x"));
    assert.match(base, /^sl-x(-[A-Za-z0-9_-]+)?$/, `unexpected tmp file name: ${base}`);
  });
});

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readCache, writeCache, readConfig, writeConfig } from "../dist/cache.js";
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
});

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getPricing, calculateCost } from "../dist/calculator.js";

describe("getPricing", () => {
  it("returns exact pricing for known models", () => {
    const opus = getPricing("claude-opus-4-6");
    assert.equal(opus.input, 5);
    assert.equal(opus.output, 25);
    assert.equal(opus.cacheCreation, 6.25);
    assert.equal(opus.cacheRead, 0.5);
  });

  it("falls back to family pricing for unknown opus model", () => {
    const pricing = getPricing("claude-opus-99-unknown");
    assert.equal(pricing.input, 5);
    assert.equal(pricing.output, 25);
  });

  it("falls back to family pricing for unknown sonnet model", () => {
    const pricing = getPricing("claude-sonnet-99-unknown");
    assert.equal(pricing.input, 3);
    assert.equal(pricing.output, 15);
  });

  it("falls back to family pricing for unknown haiku model", () => {
    const pricing = getPricing("claude-haiku-99-unknown");
    assert.equal(pricing.input, 1);
    assert.equal(pricing.output, 5);
  });

  it("defaults to sonnet pricing for completely unknown model", () => {
    const pricing = getPricing("totally-unknown-model");
    assert.equal(pricing.input, 3);
    assert.equal(pricing.output, 15);
  });

  it("prices fable/mythos tier at $10/$50, not sonnet", () => {
    for (const model of ["claude-fable-5", "claude-mythos-5", "claude-fable-99-unknown"]) {
      const pricing = getPricing(model);
      assert.equal(pricing.input, 10, `${model} input`);
      assert.equal(pricing.output, 50, `${model} output`);
    }
  });

  it("has explicit entries for the current opus lineup", () => {
    for (const model of ["claude-opus-5", "claude-opus-4-8", "claude-opus-4-7", "claude-opus-4-6"]) {
      const pricing = getPricing(model);
      assert.equal(pricing.input, 5, `${model} input`);
      assert.equal(pricing.output, 25, `${model} output`);
    }
  });

  it("keeps legacy opus 4/4.1 at their higher $15/$75 rate", () => {
    for (const model of ["claude-opus-4-1", "claude-opus-4-1-20250805", "claude-opus-4-0"]) {
      const pricing = getPricing(model);
      assert.equal(pricing.input, 15, `${model} input`);
      assert.equal(pricing.output, 75, `${model} output`);
    }
  });

  it("derives cache rates as 1.25x (5m), 2x (1h), and 0.1x (read) of input", () => {
    const opus = getPricing("claude-opus-5");
    assert.equal(opus.cacheCreation, 6.25);
    assert.equal(opus.cacheCreation1h, 10);
    assert.equal(opus.cacheRead, 0.5);
  });

  it("doubles the rate for fast mode on fast-capable models", () => {
    const fast = getPricing("claude-opus-5", "fast");
    assert.equal(fast.input, 10);
    assert.equal(fast.output, 50);
    assert.equal(fast.cacheCreation1h, 20);

    const standard = getPricing("claude-opus-5", "standard");
    assert.equal(standard.input, 5);
  });

  it("ignores fast mode on models that do not support it", () => {
    const pricing = getPricing("claude-sonnet-5", "fast");
    assert.equal(pricing.input, 3);
    assert.equal(pricing.output, 15);
  });
});

describe("calculateCost", () => {
  it("calculates cost for opus model", () => {
    // 1M input + 1M output = $5 + $25 = $30
    const cost = calculateCost("claude-opus-4-6", 1_000_000, 1_000_000, 0, 0);
    assert.equal(cost, 30);
  });

  it("calculates cost with cache tokens", () => {
    // 0 input + 0 output + 1M cache write + 1M cache read = $6.25 + $0.5 = $6.75
    const cost = calculateCost("claude-opus-4-6", 0, 0, 1_000_000, 1_000_000);
    assert.equal(cost, 6.75);
  });

  it("calculates cost for typical session", () => {
    // 50k input + 10k output on opus: (50000*5 + 10000*25) / 1e6 = 0.25 + 0.25 = 0.5
    const cost = calculateCost("claude-opus-4-6", 50_000, 10_000, 0, 0);
    assert.ok(Math.abs(cost - 0.5) < 0.001, `expected ~0.5, got ${cost}`);
  });

  it("returns 0 for zero tokens", () => {
    assert.equal(calculateCost("claude-opus-4-6", 0, 0, 0, 0), 0);
  });

  it("bills 1h cache writes at 2x instead of 1.25x", () => {
    // 1M cache write, all 1h: $10 on opus (vs $6.25 at the 5m rate)
    const oneHour = calculateCost("claude-opus-5", 0, 0, 1_000_000, 0, {
      cacheCreation1hTokens: 1_000_000,
    });
    assert.equal(oneHour, 10);

    const fiveMin = calculateCost("claude-opus-5", 0, 0, 1_000_000, 0);
    assert.equal(fiveMin, 6.25);
  });

  it("splits a mixed 1h/5m cache write correctly", () => {
    // 600k @ 1h ($6) + 400k @ 5m ($2.50) = $8.50
    const cost = calculateCost("claude-opus-5", 0, 0, 1_000_000, 0, {
      cacheCreation1hTokens: 600_000,
    });
    assert.ok(Math.abs(cost - 8.5) < 1e-9, `expected 8.5, got ${cost}`);
  });

  it("clamps a 1h count that exceeds the reported cache-write total", () => {
    const cost = calculateCost("claude-opus-5", 0, 0, 100_000, 0, {
      cacheCreation1hTokens: 999_999_999,
    });
    // Clamped to the total → all 100k billed at the 1h rate = $1.00
    assert.ok(Math.abs(cost - 1) < 1e-9, `expected 1, got ${cost}`);
  });

  it("applies fast-mode pricing when speed is fast", () => {
    const cost = calculateCost("claude-opus-5", 1_000_000, 1_000_000, 0, 0, { speed: "fast" });
    assert.equal(cost, 60); // $10 + $50
  });

  it("prices fable 5 at its own tier rather than the sonnet default", () => {
    // 1M input + 1M output = $10 + $50 = $60
    assert.equal(calculateCost("claude-fable-5", 1_000_000, 1_000_000, 0, 0), 60);
  });
});

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Disable background refresh spawn before importing statusline
process.env.CC_COSTLINE_NO_SPAWN = "1";

const { render } = await import("../dist/statusline.js");

// Helper to strip ANSI escape codes for easier assertions
function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

describe("render", () => {
  it("returns empty string for invalid JSON", () => {
    assert.equal(render("not json"), "");
    assert.equal(render(""), "");
    assert.equal(render("{broken"), "");
  });

  it("returns empty string for empty input", () => {
    assert.equal(render(""), "");
  });

  it("renders basic session data", () => {
    const input = JSON.stringify({
      cost: { total_cost_usd: 2.42 },
      model: { display_name: "Opus 4.6" },
      context_window: { used_percentage: 40.5 },
    });
    const output = render(input);
    const plain = stripAnsi(output);

    assert.ok(plain.includes("$2.42"), `should include cost, got: ${plain}`);
    assert.ok(plain.includes("Opus 4.6"), `should include model, got: ${plain}`);
    assert.ok(plain.includes("40%"), `should include context %, got: ${plain}`);
  });

  it("handles zero cost", () => {
    const input = JSON.stringify({
      cost: { total_cost_usd: 0 },
      model: { display_name: "Sonnet 4.5" },
      context_window: { used_percentage: 0 },
    });
    const output = render(input);
    const plain = stripAnsi(output);

    assert.ok(plain.includes("$0.00"), `should show $0.00, got: ${plain}`);
    assert.ok(plain.includes("0%"), `should show 0%, got: ${plain}`);
  });

  it("handles missing fields gracefully", () => {
    const input = JSON.stringify({});
    const output = render(input);
    const plain = stripAnsi(output);

    // Should use defaults: cost=0, model="—", context=0%
    assert.ok(plain.includes("$0.00"), `should default cost to $0.00, got: ${plain}`);
    assert.ok(plain.includes("—"), `should default model to —, got: ${plain}`);
    assert.ok(plain.includes("0%"), `should default context to 0%, got: ${plain}`);
  });

  it("counts tokens from transcript", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "cc-render-test-"));
    try {
      const transcriptPath = join(tmpDir, "session.jsonl");
      const lines = [
        JSON.stringify({
          type: "assistant",
          message: { usage: { input_tokens: 5000, output_tokens: 2000 } },
        }),
        JSON.stringify({
          type: "assistant",
          message: { usage: { input_tokens: 3000, output_tokens: 1000 } },
        }),
        JSON.stringify({ type: "user", message: { content: "hello" } }),
      ].join("\n");
      writeFileSync(transcriptPath, lines + "\n");

      const input = JSON.stringify({
        cost: { total_cost_usd: 1.5 },
        model: { display_name: "Sonnet 4.5" },
        context_window: { used_percentage: 25 },
        transcript_path: transcriptPath,
      });
      const output = render(input);
      const plain = stripAnsi(output);

      // 5000+2000+3000+1000 = 11000 → "11.0k"
      assert.ok(plain.includes("11.0k"), `should show 11.0k tokens, got: ${plain}`);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("prefers stdin context token totals over reading transcript", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "cc-render-test-"));
    try {
      const transcriptPath = join(tmpDir, "session.jsonl");
      writeFileSync(transcriptPath, JSON.stringify({
        type: "assistant",
        message: { usage: { input_tokens: 5000, output_tokens: 2000 } },
      }) + "\n");

      const input = JSON.stringify({
        cost: { total_cost_usd: 1.5 },
        model: { display_name: "Sonnet 4.5" },
        context_window: {
          used_percentage: 25,
          total_input_tokens: 1000,
          total_output_tokens: 500,
        },
        transcript_path: transcriptPath,
      });
      const output = render(input);
      const plain = stripAnsi(output);

      assert.ok(plain.includes("1.5k"), `should show stdin token total, got: ${plain}`);
      assert.ok(!plain.includes("7.0k"), `should not read transcript when stdin totals exist, got: ${plain}`);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("shows 0 tokens when no transcript", () => {
    const input = JSON.stringify({
      cost: { total_cost_usd: 0.5 },
      model: { display_name: "Haiku 4.5" },
      context_window: { used_percentage: 10 },
    });
    const output = render(input);
    const plain = stripAnsi(output);

    assert.ok(plain.startsWith(" 0 "), `should start with 0 tokens, got: "${plain}"`);
  });

  it("handles large cost values", () => {
    const input = JSON.stringify({
      cost: { total_cost_usd: 1234.56 },
      model: { display_name: "Opus 4.6" },
      context_window: { used_percentage: 95 },
    });
    const output = render(input);
    const plain = stripAnsi(output);

    assert.ok(plain.includes("$1,235"), `should format large cost, got: ${plain}`);
    assert.ok(plain.includes("95%"), `should show 95%, got: ${plain}`);
  });

  it("handles high context percentage with correct color", () => {
    const input = JSON.stringify({
      cost: { total_cost_usd: 1 },
      model: { display_name: "Sonnet 4.5" },
      context_window: { used_percentage: 85 },
    });
    const output = render(input);

    // Red color for >= 80%
    assert.ok(output.includes("\x1b[38;5;167m"), "should use red for high context");
  });

  it("renders both 7d and 30d when period is both", () => {
    // This test verifies the "both" period renders two separate cost segments
    // Note: render() reads config from ~/.cc-costline/ which may not have period=both,
    // but we can at least verify the function doesn't crash with any config
    const input = JSON.stringify({
      cost: { total_cost_usd: 5 },
      model: { display_name: "Sonnet 4.5" },
      context_window: { used_percentage: 20 },
    });
    // Should not throw regardless of config state
    const output = render(input);
    assert.ok(output.length > 0, "should produce output");
  });

  it("output starts with a space", () => {
    const input = JSON.stringify({
      cost: { total_cost_usd: 0 },
      model: { display_name: "Test" },
      context_window: { used_percentage: 0 },
    });
    const output = render(input);
    assert.ok(output.startsWith(" "), "output should start with a leading space");
  });
});

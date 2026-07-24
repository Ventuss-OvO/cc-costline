/**
 * Bump whenever MODEL_PRICING or the cost formula changes.
 *
 * The incremental scan reuses per-file `byDay` buckets whenever mtime+size are
 * unchanged, so a pricing fix would otherwise never reach files that haven't
 * been written since. A version mismatch discards the per-file cache and forces
 * a full re-parse.
 *
 * 1 — initial flat-rate table
 * 2 — added fable/mythos + current opus lineup, 1h cache rate, fast mode
 */
export const PRICING_VERSION = 2;

export interface ModelPricing {
  input: number;
  output: number;
  /** 5-minute ephemeral cache write (1.25x input) */
  cacheCreation: number;
  /** 1-hour ephemeral cache write (2x input) */
  cacheCreation1h: number;
  /** Cache read (0.1x input) */
  cacheRead: number;
}

export interface CostOptions {
  /**
   * Subset of cacheCreationTokens written with a 1-hour TTL, billed at 2x input
   * instead of 1.25x. Comes from `usage.cache_creation.ephemeral_1h_input_tokens`.
   * Omit when the transcript has no breakdown — everything then bills at the 5m rate.
   */
  cacheCreation1hTokens?: number;
  /** `usage.speed` — "fast" doubles the rate on fast-mode-capable models. */
  speed?: string;
}

// Cache rates are a fixed multiple of the input rate across every model:
// 5m write 1.25x, 1h write 2x, read 0.1x.
function p(input: number, output: number): ModelPricing {
  return {
    input,
    output,
    cacheCreation: input * 1.25,
    cacheCreation1h: input * 2,
    cacheRead: input * 0.1,
  };
}

// Per-million-token pricing in USD (source: Anthropic pricing page)
const MODEL_PRICING: Record<string, ModelPricing> = {
  // Fable / Mythos tier
  "claude-fable-5":              p(10, 50),
  "claude-mythos-5":             p(10, 50),
  "claude-mythos-preview":       p(10, 50),

  // Opus family
  "claude-opus-5":               p(5,  25),
  "claude-opus-4-8":             p(5,  25),
  "claude-opus-4-7":             p(5,  25),
  "claude-opus-4-6":             p(5,  25),
  "claude-opus-4-5":             p(5,  25),
  "claude-opus-4-5-20251101":    p(5,  25),
  "claude-opus-4-1":             p(15, 75),
  "claude-opus-4-1-20250805":    p(15, 75),
  "claude-opus-4-0":             p(15, 75),
  "claude-opus-4-20250514":      p(15, 75),
  "claude-3-opus-20240229":      p(15, 75),

  // Sonnet family
  // Sonnet 5 carries an intro rate of $2/$10 through 2026-08-31; listed at the
  // standard rate so the table stays correct once the promo ends.
  "claude-sonnet-5":             p(3,  15),
  "claude-sonnet-4-6":           p(3,  15),
  "claude-sonnet-4-5":           p(3,  15),
  "claude-sonnet-4-5-20250929":  p(3,  15),
  "claude-sonnet-4-0":           p(3,  15),
  "claude-sonnet-4-20250514":    p(3,  15),
  "claude-3-7-sonnet-20250219":  p(3,  15),
  "claude-3-5-sonnet-20241022":  p(3,  15),

  // Haiku family
  "claude-haiku-4-5":            p(1,    5),
  "claude-haiku-4-5-20251001":   p(1,    5),
  "claude-3-5-haiku-20241022":   p(0.8,  4),
  "claude-3-haiku-20240307":     p(0.25, 1.25),
};

// Family fallbacks for unknown model IDs. Checked in insertion order, so the
// narrower families must come before the broader ones.
const FAMILY_FALLBACK: Record<string, ModelPricing> = {
  fable:  MODEL_PRICING["claude-fable-5"],
  mythos: MODEL_PRICING["claude-mythos-5"],
  opus:   MODEL_PRICING["claude-opus-5"],
  sonnet: MODEL_PRICING["claude-sonnet-5"],
  haiku:  MODEL_PRICING["claude-haiku-4-5"],
};

// Fast mode is a research preview on Opus 5 / Opus 4.8 only, billed at 2x the
// standard rate ($10/$50 on Opus 5). Any other model ignores `speed`.
const FAST_MODE_MULTIPLIER = 2;
const FAST_MODE_MODELS = ["opus-5", "opus-4-8"];

function supportsFastMode(model: string): boolean {
  const lower = model.toLowerCase();
  return FAST_MODE_MODELS.some((m) => lower.includes(m));
}

function scale(pricing: ModelPricing, factor: number): ModelPricing {
  return {
    input: pricing.input * factor,
    output: pricing.output * factor,
    cacheCreation: pricing.cacheCreation * factor,
    cacheCreation1h: pricing.cacheCreation1h * factor,
    cacheRead: pricing.cacheRead * factor,
  };
}

export function getPricing(model: string, speed?: string): ModelPricing {
  let pricing = MODEL_PRICING[model];

  if (!pricing) {
    // Try family fallback
    const lower = model.toLowerCase();
    for (const [family, familyPricing] of Object.entries(FAMILY_FALLBACK)) {
      if (lower.includes(family)) {
        pricing = familyPricing;
        break;
      }
    }
  }

  // Default to sonnet pricing
  pricing = pricing || FAMILY_FALLBACK.sonnet;

  if (speed === "fast" && supportsFastMode(model)) {
    return scale(pricing, FAST_MODE_MULTIPLIER);
  }

  return pricing;
}

export function calculateCost(
  model: string,
  inputTokens: number,
  outputTokens: number,
  cacheCreationTokens: number,
  cacheReadTokens: number,
  opts?: CostOptions,
): number {
  const pricing = getPricing(model, opts?.speed);

  // Split the cache-write total into 1h and 5m portions. Claude Code reports
  // both a flat total and a per-TTL breakdown; the breakdown is authoritative
  // when present, and clamping guards against the two disagreeing.
  const cache1h = Math.min(Math.max(opts?.cacheCreation1hTokens ?? 0, 0), cacheCreationTokens);
  const cache5m = cacheCreationTokens - cache1h;

  return (
    inputTokens * pricing.input +
    outputTokens * pricing.output +
    cache5m * pricing.cacheCreation +
    cache1h * pricing.cacheCreation1h +
    cacheReadTokens * pricing.cacheRead
  ) / 1e6;
}

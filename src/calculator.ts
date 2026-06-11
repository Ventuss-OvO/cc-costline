export interface ModelPricing {
  input: number;
  output: number;
  cacheCreation: number;
  cacheRead: number;
}

// A pricing table keyed by model id. Values are per-million-token USD.
export type PricingTable = Record<string, ModelPricing>;

// Per-million-token pricing in USD. Built-in OFFLINE FALLBACK for the Claude
// family (source: Anthropic pricing page). At runtime this is augmented/overridden
// by a cloud table fetched from LiteLLM, which also covers non-Claude models that
// Claude Code can route to via ANTHROPIC_BASE_URL.
const BUILTIN_PRICING: PricingTable = {
  // Opus family
  "claude-opus-4-6":            { input: 5,   output: 25,  cacheCreation: 6.25,  cacheRead: 0.5  },
  "claude-opus-4-5-20251101":   { input: 5,   output: 25,  cacheCreation: 6.25,  cacheRead: 0.5  },
  "claude-opus-4-1-20250805":   { input: 15,  output: 75,  cacheCreation: 18.75, cacheRead: 1.5  },

  // Sonnet family
  "claude-sonnet-4-5-20250929": { input: 3,   output: 15,  cacheCreation: 3.75,  cacheRead: 0.3  },
  "claude-sonnet-4-20250514":   { input: 3,   output: 15,  cacheCreation: 3.75,  cacheRead: 0.3  },
  "claude-3-5-sonnet-20241022": { input: 3,   output: 15,  cacheCreation: 3.75,  cacheRead: 0.3  },

  // Haiku family
  "claude-haiku-4-5-20251001":  { input: 1,   output: 5,   cacheCreation: 1.25,  cacheRead: 0.1  },
  "claude-3-5-haiku-20241022":  { input: 0.8, output: 4,   cacheCreation: 1,     cacheRead: 0.08 },
};

// Family fallbacks for unknown model IDs
const FAMILY_FALLBACK: Record<string, ModelPricing> = {
  opus:   BUILTIN_PRICING["claude-opus-4-6"],
  sonnet: BUILTIN_PRICING["claude-sonnet-4-5-20250929"],
  haiku:  BUILTIN_PRICING["claude-haiku-4-5-20251001"],
};

/**
 * Look up a model id in a pricing table, tolerating common id variations.
 * Tries, in order: the id as-is, with the provider prefix stripped
 * ("anthropic/claude-..." → "claude-..."), with a trailing date snapshot stripped
 * ("claude-...-20250805" → "claude-..."), and with BOTH stripped
 * ("openai/gpt-x-20250101" → "gpt-x").
 */
function lookup(table: PricingTable, model: string): ModelPricing | undefined {
  const stripDate = (s: string) => s.replace(/-\d{8}$/, "");
  const slash = model.lastIndexOf("/");
  const bare = slash !== -1 ? model.slice(slash + 1) : "";

  const candidates = [model];
  if (bare) candidates.push(bare);
  const noDate = stripDate(model);
  if (noDate !== model) candidates.push(noDate);
  if (bare) {
    const bareNoDate = stripDate(bare);
    if (bareNoDate !== bare) candidates.push(bareNoDate);
  }

  for (const c of candidates) {
    if (table[c]) return table[c];
  }
  return undefined;
}

/**
 * Resolve pricing for a model id.
 *
 * Precedence: cloud table (LiteLLM — also covers non-Claude models) → built-in
 * Claude table → family heuristic (opus/sonnet/haiku) → Sonnet default for
 * completely unknown ids.
 */
export function getPricing(model: string, cloud?: PricingTable): ModelPricing {
  if (cloud) {
    const hit = lookup(cloud, model);
    if (hit) return hit;
  }

  const builtin = lookup(BUILTIN_PRICING, model);
  if (builtin) return builtin;

  // Try family fallback
  const lower = model.toLowerCase();
  for (const [family, pricing] of Object.entries(FAMILY_FALLBACK)) {
    if (lower.includes(family)) return pricing;
  }

  // Default to sonnet pricing
  return FAMILY_FALLBACK.sonnet;
}

/**
 * Convert a LiteLLM per-token cost to per-million-token USD.
 * Returns null when the value is absent or not a non-negative finite number.
 */
function toPerMillion(v: unknown): number | null {
  return typeof v === "number" && isFinite(v) && v >= 0 ? v * 1e6 : null;
}

// Allowlist of providers whose LiteLLM price is the DIRECT/official price the user
// actually bills at — first-party model makers (anthropic, openai, gemini, xai,
// mistral, deepseek, moonshot, dashscope/Qwen, zai/GLM, minimax, volcengine/Doubao)
// plus direct first-party inference/answer APIs the user connects to straight
// (perplexity, groq, cerebras).
//
// We use an ALLOWLIST (not a denylist) because the requirement is official/direct
// pricing ONLY: LiteLLM also lists dozens of multi-vendor gateways/aggregators
// (openrouter, vercel_ai_gateway, …) and cloud-platform resellers (azure, bedrock,
// vertex_ai*, …) that re-price others' models. An allowlist guarantees only direct
// prices survive. This membership is CURATED per project requirement — do not
// auto-expand it from LiteLLM's provider list. Anything not listed is dropped and
// resolved via the built-in/family fallback instead.
const DIRECT_PROVIDERS = new Set([
  "anthropic",
  "openai", "text-completion-openai",                      // OpenAI direct
  "gemini", "palm",                                         // Google (AI Studio / direct)
  "xai",                                                    // Grok
  "mistral", "codestral", "text-completion-codestral",      // Mistral
  "deepseek",
  "moonshot",                                               // Kimi
  "dashscope",                                              // Alibaba Qwen (official API)
  "zai",                                                    // Z.ai / Zhipu GLM
  "minimax",
  "volcengine",                                             // ByteDance Volcano Engine (Doubao)
  "perplexity",                                             // Perplexity (direct API)
  "groq",                                                   // Groq (direct API)
  "cerebras",                                               // Cerebras (direct API)
]);

/**
 * True when a LiteLLM entry comes from a direct/official first-party API (the curated
 * DIRECT_PROVIDERS set), as opposed to a multi-vendor gateway/aggregator or a
 * cloud-platform reseller. Authoritative signal is `litellm_provider`.
 */
function isDirectVendor(provider: string): boolean {
  return DIRECT_PROVIDERS.has(provider.toLowerCase());
}

/**
 * Parse LiteLLM's `model_prices_and_context_window.json` into a compact PricingTable.
 *
 * - Skips the `sample_spec` schema doc and any entry lacking per-token input/output cost
 *   (embeddings, rerankers, image models, etc. have no chat token pricing).
 * - Keeps ONLY official/direct-from-vendor entries (see isDirectVendor); cloud-platform,
 *   aggregator, and hosted-reseller listings are dropped.
 * - LiteLLM stores per-TOKEN costs; we convert to per-MILLION to match the built-in table.
 * - Cache costs fall back to the input price when the provider doesn't specify them
 *   (most non-caching models never report cache tokens, so this rarely matters).
 */
export function parseLiteLLMPricing(raw: any): PricingTable {
  if (!raw || typeof raw !== "object") return {};
  const out: PricingTable = {};
  for (const [name, entry] of Object.entries(raw)) {
    if (name === "sample_spec") continue;
    if (!entry || typeof entry !== "object") continue;
    const e = entry as any;
    const provider = typeof e.litellm_provider === "string" ? e.litellm_provider : "";
    if (!isDirectVendor(provider)) continue;
    const input = toPerMillion(e.input_cost_per_token);
    const output = toPerMillion(e.output_cost_per_token);
    if (input === null || output === null) continue;
    const cacheCreation = toPerMillion(e.cache_creation_input_token_cost) ?? input;
    const cacheRead = toPerMillion(e.cache_read_input_token_cost) ?? input;
    out[name] = { input, output, cacheCreation, cacheRead };
  }
  return out;
}

export function calculateCost(
  model: string,
  inputTokens: number,
  outputTokens: number,
  cacheCreationTokens: number,
  cacheReadTokens: number,
  cloud?: PricingTable,
): number {
  const pricing = getPricing(model, cloud);
  return (
    inputTokens * pricing.input +
    outputTokens * pricing.output +
    cacheCreationTokens * pricing.cacheCreation +
    cacheReadTokens * pricing.cacheRead
  ) / 1e6;
}

import { readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { execSync } from "node:child_process";

// ============================================================================
// Types
// ============================================================================

interface ModelPricing {
  input: number;
  output: number;
  cacheCreation?: number;
  cacheRead?: number;
}

interface ModelUsageRecord {
  hour: string;
  count: number;
  tokens: number;
}

interface ModelUsageApiResponse {
  x_time: string[];
  modelCallCount: (number | null)[];
  tokensUsage: (number | null)[];
  totalUsage: {
    totalTokensUsage: number;
    totalModelCallCount: number;
  };
}

interface ToolUsage {
  "search-prime": number;
  "web-reader": number;
  "zread": number;
}

interface QuotaLimitApiResponse {
  type: string;
  percentage: number;
  currentValue: number;
  usage: number;
  nextResetTime?: string;
  usageDetails?: ToolUsage;
}

export interface ZhipuUsageResult {
  modelUsage: {
    totalTokens: number;
    totalCount: number;
    cost: number;
  } | null;
  monthlyUsage: {
    totalTokens: number;
    cost: number;
  } | null;
  quotaLimit: {
    tokens5h: {
      percentage: number;
      current: number;
      limit: number;
      resetsAt: number | null;
    } | null;
    mcpMonthly: {
      percentage: number;
      current: number;
      limit: number;
      details: ToolUsage;
    } | null;
  } | null;
  toolUsage: ToolUsage | null;
}

interface ZhipuCacheData {
  modelUsage: {
    totalTokens: number;
    totalCount: number;
    cost: number;
  };
  monthlyUsage: {
    totalTokens: number;
    cost: number;
  };
  quotaLimit: {
    tokens5h: {
      percentage: number;
      current: number;
      limit: number;
      resetsAt: number | null;
    };
    mcpMonthly: {
      percentage: number;
      current: number;
      limit: number;
      details: ToolUsage;
    };
  };
  toolUsage: ToolUsage;
  cycleStartTime: number | null;
  previousPercentage: number | null;
  updatedAt: number;
}

interface ClaudeSettings {
  env?: {
    ANTHROPIC_AUTH_TOKEN?: string;
    ANTHROPIC_BASE_URL?: string;
  };
}

// ============================================================================
// Constants
// ============================================================================

const ZHIPU_CACHE_FILE = "/tmp/sl-zhipu-usage";
const CACHE_TTL = 60; // 60 seconds
const SETTINGS_PATH = join(homedir(), ".claude", "settings.json");

// 主要智谱模型定价（美元/Token，从 LiteLLM 提取）
const ZHIPU_PRICING: Record<string, ModelPricing> = {
  "zai/glm-4.7": {
    input: 6E-7,
    output: 2.2E-6,
    cacheRead: 1.1E-7,
  },
  "zai/glm-4.6": {
    input: 6E-7,
    output: 2.2E-6,
    cacheRead: 1.1E-7,
  },
  "zai/glm-4.5-air": {
    input: 2E-7,
    output: 1.1E-6,
  },
  "zai/glm-5": {
    input: 1E-6,
    output: 3.2E-6,
    cacheRead: 2E-7,
  },
};

// ============================================================================
// Authentication
// ============================================================================

function readClaudeSettings(): ClaudeSettings | null {
  try {
    const content = readFileSync(SETTINGS_PATH, "utf-8");
    return JSON.parse(content) as ClaudeSettings;
  } catch {
    return null;
  }
}

function getZhipuAuth(): { token: string; baseUrl: string } | null {
  const settings = readClaudeSettings();
  const token = settings?.env?.ANTHROPIC_AUTH_TOKEN;
  const baseUrl = settings?.env?.ANTHROPIC_BASE_URL;

  if (!token || !baseUrl) {
    return null;
  }

  // 从 baseUrl 提取基础域名（去除 /api/anthropic 后缀）
  const baseDomain = baseUrl.replace(/\/api\/anthropic$/, "");

  return { token, baseUrl: baseDomain };
}

// ============================================================================
// Time Window Helpers
// ============================================================================

function formatDateTime(date: Date): string {
  const yyyy = date.getFullYear();
  const MM = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  const HH = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  const ss = String(date.getSeconds()).padStart(2, "0");
  return `${yyyy}-${MM}-${dd} ${HH}:${mm}:${ss}`;
}

function get24HourWindow(): { startTime: string; endTime: string } {
  const now = new Date();
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  yesterday.setMinutes(59, 59, 999);

  const start = new Date(yesterday);
  start.setMinutes(0, 0, 0);

  const end = new Date(now);
  end.setMinutes(59, 59, 999);

  return {
    startTime: formatDateTime(start),
    endTime: formatDateTime(end),
  };
}

function getMonthWindow(): { startTime: string; endTime: string } {
  const now = new Date();
  const firstDay = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
  const endOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);

  return {
    startTime: formatDateTime(firstDay),
    endTime: formatDateTime(endOfToday),
  };
}

// ============================================================================
// Cost Calculation
// ============================================================================

function getPricing(model: string): ModelPricing {
  if (ZHIPU_PRICING[model]) return ZHIPU_PRICING[model];

  // Try fuzzy match
  const lower = model.toLowerCase();
  for (const [key, pricing] of Object.entries(ZHIPU_PRICING)) {
    if (lower.includes(key.toLowerCase()) || key.toLowerCase().includes(lower)) {
      return pricing;
    }
  }

  // Default pricing
  return ZHIPU_PRICING["zai/glm-4.7"];
}

function calculateZhipuCost(tokens: number, model: string): number {
  const pricing = getPricing(model);
  return tokens * pricing.input;
}

// ============================================================================
// API Request
// ============================================================================

interface ApiRequestOptions {
  endpoint: string;
  params?: Record<string, string>;
}

async function zhipuApiRequest<T>(options: ApiRequestOptions): Promise<T | null> {
  const auth = getZhipuAuth();
  if (!auth) return null;

  const { token, baseUrl } = auth;

  // 手动构建 URL，使用 encodeURIComponent 确保 %20 而不是 +
  let url = `${baseUrl}${options.endpoint}`;
  if (options.params && Object.keys(options.params).length > 0) {
    const searchParams = Object.entries(options.params)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v).replace(/\%20/g, '%20')}`)
      .join('&');
    url += `?${searchParams}`;
  }

  try {
    // 使用单引号包裹 URL，避免 shell 解析问题
    const curlCmd = `curl -sf -H 'Authorization: ${token}' -H 'Content-Type: application/json' '${url}'`;

    const response = execSync(curlCmd, {
      encoding: 'utf-8',
      timeout: 5000,
      shell: '/bin/bash',
    });

    if (!response) return null;

    const apiResponse: { code: number; message: string; data: T } = JSON.parse(response);

    if (apiResponse.code !== 200) {
      return null;
    }

    return apiResponse.data;
  } catch (error) {
    return null;
  }
}

// ============================================================================
// Model Usage
// ============================================================================

async function getModelUsage24h(): Promise<{ totalTokens: number; totalCount: number } | null> {
  const window = get24HourWindow();

  const data = await zhipuApiRequest<ModelUsageApiResponse>({
    endpoint: '/api/monitor/usage/model-usage',
    params: {
      startTime: window.startTime,
      endTime: window.endTime,
    },
  });

  if (!data?.totalUsage) return null;

  return {
    totalTokens: data.totalUsage.totalTokensUsage,
    totalCount: data.totalUsage.totalModelCallCount,
  };
}

async function getModelUsageMonthly(): Promise<{ totalTokens: number; totalCount: number } | null> {
  const window = getMonthWindow();

  const data = await zhipuApiRequest<ModelUsageApiResponse>({
    endpoint: '/api/monitor/usage/model-usage',
    params: {
      startTime: window.startTime,
      endTime: window.endTime,
    },
  });

  if (!data?.totalUsage) return null;

  return {
    totalTokens: data.totalUsage.totalTokensUsage,
    totalCount: data.totalUsage.totalModelCallCount,
  };
}

// ============================================================================
// Tool Usage
// ============================================================================

async function getToolUsage(): Promise<ToolUsage | null> {
  const window = get24HourWindow();
  return await zhipuApiRequest<ToolUsage>({
    endpoint: '/api/monitor/usage/tool-usage',
    params: {
      startTime: window.startTime,
      endTime: window.endTime,
    },
  });
}

// ============================================================================
// Quota Limit
// ============================================================================

function parseNextResetTime(resetTimeStr: string): number {
  const timestamp = Date.parse(resetTimeStr);
  if (!isNaN(timestamp)) {
    return timestamp;
  }
  if (/^\d+$/.test(resetTimeStr)) {
    return parseInt(resetTimeStr) * 1000;
  }
  return Date.now() + 5 * 60 * 60 * 1000;
}

async function getQuotaLimit(): Promise<{
  tokens5h: {
    percentage: number;
    current: number;
    limit: number;
    resetsAt: number | null;
  } | null;
  mcpMonthly: {
    percentage: number;
    current: number;
    limit: number;
    details: ToolUsage;
  } | null;
} | null> {
  const data = await zhipuApiRequest<{ limits: QuotaLimitApiResponse[] }>({
    endpoint: '/api/monitor/usage/quota/limit',
  });

  if (!data || !data.limits) return null;

  const tokensLimit = data.limits.find((l) => l.type === 'TOKENS_LIMIT');
  const timeLimit = data.limits.find((l) => l.type === 'TIME_LIMIT');

  let resetsAt: number | undefined;
  if (tokensLimit?.nextResetTime) {
    resetsAt = parseNextResetTime(tokensLimit.nextResetTime);
  }

  return {
    tokens5h: tokensLimit
      ? {
          percentage: tokensLimit.percentage,
          current: tokensLimit.currentValue,
          limit: tokensLimit.usage,
          resetsAt: resetsAt ?? null,
        }
      : null,
    mcpMonthly: timeLimit
      ? {
          percentage: timeLimit.percentage,
          current: timeLimit.currentValue,
          limit: timeLimit.usage,
          details:
            timeLimit.usageDetails ||
            ({ 'search-prime': 0, 'web-reader': 0, 'zread': 0 } as ToolUsage),
        }
      : null,
  };
}

// ============================================================================
// Cache Management
// ============================================================================

function readZhipuCache(): ZhipuCacheData | null {
  try {
    const content = readFileSync(ZHIPU_CACHE_FILE, "utf-8");
    return JSON.parse(content) as ZhipuCacheData;
  } catch {
    return null;
  }
}

function writeZhipuCache(data: ZhipuCacheData): void {
  try {
    writeFileSync(ZHIPU_CACHE_FILE, JSON.stringify(data), "utf-8");
  } catch (error) {
    console.error('写入智谱缓存失败:', error);
  }
}

function isCacheValid(): boolean {
  try {
    const stats = statSync(ZHIPU_CACHE_FILE);
    const age = (Date.now() - stats.mtimeMs) / 1000;
    return age <= CACHE_TTL;
  } catch {
    return false;
  }
}

// ============================================================================
// Main Export Function
// ============================================================================

export async function getZhipuUsage(forceRefresh = false): Promise<ZhipuUsageResult | null> {
  // Check cache first
  if (!forceRefresh && isCacheValid()) {
    const cached = readZhipuCache();
    if (cached) {
      return {
        modelUsage: cached.modelUsage,
        monthlyUsage: cached.monthlyUsage,
        quotaLimit: cached.quotaLimit,
        toolUsage: cached.toolUsage,
      };
    }
  }

  // Fetch all data in parallel
  const [modelUsage24h, modelUsageMonthly, quotaLimit, toolUsage] = await Promise.all([
    getModelUsage24h(),
    getModelUsageMonthly(),
    getQuotaLimit(),
    getToolUsage(),
  ]);

  if (!modelUsage24h && !modelUsageMonthly && !quotaLimit && !toolUsage) {
    return null;
  }

  // Calculate costs
  const modelUsageCost = modelUsage24h ? calculateZhipuCost(modelUsage24h.totalTokens, "zai/glm-4.7") : 0;
  const monthlyUsageCost = modelUsageMonthly ? calculateZhipuCost(modelUsageMonthly.totalTokens, "zai/glm-4.7") : 0;

  // Add cost to usage data
  const modelUsageWithCost = modelUsage24h
    ? {
        ...modelUsage24h,
        cost: modelUsageCost,
      }
    : null;

  const monthlyUsageWithCost = modelUsageMonthly
    ? {
        totalTokens: modelUsageMonthly.totalTokens,
        cost: monthlyUsageCost,
      }
    : null;

  // Handle cycle start time for quota reset
  let cycleStartTime: number | null = null;
  const previousCache = readZhipuCache();

  if (quotaLimit?.tokens5h) {
    const currentPercentage = quotaLimit.tokens5h.percentage;
    const previousPercentage = previousCache?.previousPercentage ?? null;

    // Record cycle start when percentage reaches 100%
    if (currentPercentage >= 100 && previousPercentage !== null && previousPercentage < 100) {
      cycleStartTime = Date.now();
    } else if (currentPercentage < 100) {
      // Clear when percentage drops below 100%
      cycleStartTime = null;
    } else {
      // Use cached cycle start time
      cycleStartTime = previousCache?.cycleStartTime || null;
    }

    // Calculate resetsAt if not provided by API
    if (!quotaLimit.tokens5h.resetsAt && currentPercentage >= 100 && cycleStartTime) {
      quotaLimit.tokens5h.resetsAt = cycleStartTime + 5 * 60 * 60 * 1000;
    }
  }

  // Prepare cache data
  const defaultQuotaLimit = {
    tokens5h: { percentage: 0, current: 0, limit: 0, resetsAt: null },
    mcpMonthly: { percentage: 0, current: 0, limit: 0, details: { 'search-prime': 0, 'web-reader': 0, 'zread': 0 } },
  };

  const cacheData: ZhipuCacheData = {
    modelUsage: modelUsageWithCost || { totalTokens: 0, totalCount: 0, cost: 0 },
    monthlyUsage: monthlyUsageWithCost || { totalTokens: 0, cost: 0 },
    quotaLimit: quotaLimit ? {
      tokens5h: quotaLimit.tokens5h || defaultQuotaLimit.tokens5h,
      mcpMonthly: quotaLimit.mcpMonthly || defaultQuotaLimit.mcpMonthly,
    } : defaultQuotaLimit,
    toolUsage: toolUsage || { 'search-prime': 0, 'web-reader': 0, 'zread': 0 },
    cycleStartTime,
    previousPercentage: quotaLimit?.tokens5h?.percentage || null,
    updatedAt: Date.now(),
  };

  // Write cache
  writeZhipuCache(cacheData);

  return {
    modelUsage: modelUsageWithCost,
    monthlyUsage: monthlyUsageWithCost,
    quotaLimit,
    toolUsage,
  };
}

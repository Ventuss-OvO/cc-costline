# 智谱用量查询集成工作记录

## 日期
2026-03-07

## 任务
集成智谱 GLM 用量查询 API 到 cc-costline 状态栏工具

## 实现功能

### 1. 新增模块 `src/zhipu.ts`
完整的智谱 API 集成模块，包含：

**核心接口：**
- `getZhipuUsage(forceRefresh?: boolean)` - 统一入口函数
- 支持的 API 端点：
  - `/api/monitor/usage/model-usage` - 模型 Token 使用量
  - `/api/monitor/usage/tool-usage` - MCP 工具使用量
  - `/api/monitor/usage/quota/limit` - 额度限制信息

**数据结构：**
```typescript
interface ZhipuUsageResult {
  modelUsage: { totalTokens, totalCount, percentage, cost } | null;
  monthlyUsage: { totalTokens, cost } | null;  // 本月累计（1号到当天）
  quotaLimit: {
    tokens5h: { percentage, current, limit, resetsAt } | null;
    mcpMonthly: { percentage, current, limit, details } | null;
  } | null;
  toolUsage: ToolUsage | null;
}
```

**定价数据（来自 LiteLLM）：**
```typescript
const ZHIPU_PRICING = {
  "zai/glm-4.7": { input: 6E-7, output: 2.2E-6, cacheRead: 1.1E-7 },
  "zai/glm-4.6": { input: 6E-7, output: 2.2E-6, cacheRead: 1.1E-7 },
  "zai/glm-4.5-air": { input: 2E-7, output: 1.1E-6 },
  "zai/glm-5": { input: 1E-6, output: 3.2E-6, cacheRead: 2E-7 },
};
```

**特性：**
- 60 秒文件缓存（`/tmp/sl-zhipu-usage`）
- 优先使用 API 返回的 `nextResetTime` 字段
- 自动记录周期开始时间用于倒计时计算
- 本月累计使用量（从 1 号 00:00:00 到当天 23:59:59）

### 2. 状态栏显示格式

**完整显示示例：**
```
ZHIPU: 14.6M (29%) ~ $0.73 · 5h:26% · MCP:9/100 · M: 450.8M ~ $18.52
```

**各部分说明：**
- `ZHIPU:14.6M (29%) ~ $0.73` - 24小时模型 Token 使用量、百分比、计算成本
- `5h:26%` - 5小时 Token 使用率
- `5h:2:30` - 当使用率 ≥100% 时，显示距离刷新的倒计时
- `MCP:9/100` - MCP 工具月度使用量（search-prime + web-reader + zread）
- `M:450.8M ~ $18.52` - 本月累计（1号到当天）Token 总量和计算成本

**颜色规则：**
- ≥80%: 红色
- ≥60%: 橙色
- <60%: 绿色

### 3. 修改的文件

**`src/cache.ts`**
- 添加 `showZhipu: boolean` 到 `ConfigData` 接口
- 默认值：`{ period: "7d", showZhipu: true }`

**`src/statusline.ts`**
- 导入 `getZhipuUsage` 函数
- `render()` 函数改为 `async`
- 添加智谱信息显示逻辑
- 新增 `formatResetTime()` 辅助函数

**`src/cli.ts`**
- `cmdRender()` 改为 `async function`
- `cmdConfig()` 支持 `--zhipu <true|false>` 参数
- `cmdInstall()` 默认配置包含 `showZhipu: true`

### 4. 配置命令

```bash
# 查看当前配置
cc-costline config

# 显示智谱信息
cc-costline config --zhipu true

# 隐藏智谱信息
cc-costline config --zhipu false
```

## 技术要点

### 时间窗口计算
```typescript
// 24小时滚动窗口
function get24HourWindow(): { startTime: string; endTime: string }

// 本月时间窗口（1号 00:00:00 到当天 23:59:59）
function getMonthWindow(): { startTime: string; endTime: string }
```

### 刷新时间解析
```typescript
// 支持 ISO 8601 字符串和秒级时间戳
function parseNextResetTime(resetTimeStr: string): number
```

### 周期开始时间记录
- 当 5h 使用率从 <100% 变为 ≥100% 时，记录周期开始时间
- 当使用率下降到 <100% 时，清除周期开始时间
- 用于准确计算倒计时

### 成本计算
- 使用 LiteLLM 定价数据
- 按 Token 数量 × 单价计算
- 默认使用 zai/glm-4.7 定价

## 验证测试

```bash
# 编译
npm run build

# 测试渲染
echo '{"cost":{"total_cost_usd":1.23},"model":{"display_name":"Test"}}' | cc-costline render

# 刷新缓存
cc-costline refresh

# 配置开关
cc-costline config --zhipu false
cc-costline config --zhipu true
```

## 文件清单

**新增：**
- `src/zhipu.ts` (~540 行)

**修改：**
- `src/cache.ts` (+3 行)
- `src/statusline.ts` (+90 行)
- `src/cli.ts` (+15 行)

**编译输出：**
- `dist/zhipu.js` (~12KB)
- `dist/zhipu.d.ts`
- `dist/statusline.js` (已更新)
- `dist/cli.js` (已更新)

## 依赖

**运行时依赖：**
- Node.js 内置模块：`fs`, `path`, `os`, `child_process`
- 认证来源：`~/.claude/settings.json`（只读，不修改）

**开发依赖：**
- `@types/node` - TypeScript 类型定义
- `typescript` - 编译器

## 错误处理

遵循静默失败模式：
- API 请求失败 → 返回 null，不影响其他功能
- 认证缺失 → 跳过智谱显示
- 缓存读取失败 → 触发 API 请求重新获取
- 网络超时 → 5秒超时，降级到过期缓存或返回 null

## 后续优化建议

1. 添加更多智谱模型的定价数据
2. 支持自定义定价配置
3. 添加用量告警阈值配置
4. 支持多账号切换显示

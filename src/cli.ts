#!/usr/bin/env node

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf-8"));
import { collectCosts } from "./collector.js";
import { readCache, writeCache, writeConfig, readConfig, CACHE_DIR } from "./cache.js";
import { render } from "./statusline.js";
import { refreshAll } from "./refresh.js";

const SETTINGS_PATH = join(homedir(), ".claude", "settings.json");
const RENDER_COMMAND = "cc-costline render";
const REFRESH_COMMAND = "cc-costline refresh-bg";

// ─── Helpers ──────────────────────────────────────────────

function readSettings(): any {
  if (!existsSync(SETTINGS_PATH)) return {};
  const raw = readFileSync(SETTINGS_PATH, "utf-8");
  try {
    return JSON.parse(raw);
  } catch {
    console.error(`✗ Failed to parse ${SETTINGS_PATH} — aborting to avoid overwriting your config.`);
    console.error("  Please fix the JSON syntax and retry.");
    process.exit(1);
  }
}

function saveSettings(settings: any): void {
  writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2) + "\n");
}

function readStdin(): string {
  try {
    return readFileSync(0, "utf-8");
  } catch {
    return "";
  }
}

// ─── Commands ─────────────────────────────────────────────

function cmdInstall(): void {
  const settings = readSettings();

  // 1. Set statusLine command
  settings.statusLine = {
    type: "command",
    command: RENDER_COMMAND,
  };

  // 2. Add SessionEnd hook for background refresh
  if (!settings.hooks) settings.hooks = {};

  for (const event of ["SessionEnd", "Stop"] as const) {
    if (!settings.hooks[event]) settings.hooks[event] = [];

    // Remove any old cc-costline / cc-statusline hooks first
    settings.hooks[event] = settings.hooks[event].filter(
      (h: any) => !h.hooks?.some((hh: any) =>
        hh.command?.includes("cc-costline") || hh.command?.includes("cc-statusline")
      )
    );

    // Add fresh hook
    settings.hooks[event].push({
      matcher: "",
      hooks: [
        {
          type: "command",
          command: REFRESH_COMMAND,
          timeout: 60,
          async: true,
        },
      ],
    });
  }

  saveSettings(settings);

  // 3. Create config dir + default config
  mkdirSync(CACHE_DIR, { recursive: true });
  if (!existsSync(join(CACHE_DIR, "config.json"))) {
    writeConfig({ period: "7d" });
  }

  // 4. Initial refresh
  console.log("✓ settings.json updated (statusLine + hooks)");
  console.log("✓ Config directory created: " + CACHE_DIR);
  console.log("  Running initial cost calculation...");
  cmdRefresh();
  console.log("✓ Installation complete!");
}

function cmdUninstall(): void {
  const settings = readSettings();

  // Remove statusLine if it's ours
  if (settings.statusLine?.command?.includes("cc-costline") ||
      settings.statusLine?.command?.includes("cc-statusline")) {
    delete settings.statusLine;
  }

  // Remove our hooks from SessionEnd and Stop
  for (const event of ["SessionEnd", "Stop"] as const) {
    if (!settings.hooks?.[event]) continue;
    settings.hooks[event] = settings.hooks[event].filter(
      (h: any) => !h.hooks?.some((hh: any) =>
        hh.command?.includes("cc-costline") || hh.command?.includes("cc-statusline")
      )
    );
    if (settings.hooks[event].length === 0) {
      delete settings.hooks[event];
    }
  }

  saveSettings(settings);
  console.log("✓ Removed cc-costline from settings.json");
  console.log("  Cache directory preserved at: " + CACHE_DIR);
}

function cmdConfig(args: string[]): void {
  const periodIdx = args.indexOf("--period");
  if (periodIdx === -1 || !args[periodIdx + 1]) {
    const config = readConfig();
    console.log("Current config:", JSON.stringify(config, null, 2));
    console.log("\nUsage: cc-costline config --period <7d|30d|both>");
    return;
  }

  const period = args[periodIdx + 1];
  if (!["7d", "30d", "both"].includes(period)) {
    console.error("Invalid period. Use: 7d, 30d, or both");
    process.exit(1);
  }

  writeConfig({ period: period as "7d" | "30d" | "both" });
  console.log(`✓ Period set to: ${period}`);
}

function cmdRefresh(): void {
  const prev = readCache();
  const result = collectCosts(undefined, prev?.files);
  writeCache({
    cost7d: result.cost7d,
    cost30d: result.cost30d,
    updatedAt: new Date().toISOString(),
    files: result.files,
  });
  console.log(
    `✓ Cache updated — 7d: $${result.cost7d.toFixed(2)} | 30d: $${result.cost30d.toFixed(2)}`
  );
}

function cmdRender(): void {
  const input = readStdin();
  if (!input.trim()) return;
  const output = render(input);
  if (output) process.stdout.write(output);
}

async function cmdRefreshBg(args: string[]): Promise<void> {
  const transcriptPath = args[0] || "";
  await refreshAll(transcriptPath);
}

// ─── Main ─────────────────────────────────────────────────

const args = process.argv.slice(2);
const command = args[0];

switch (command) {
  case "install":
    cmdInstall();
    break;
  case "uninstall":
    cmdUninstall();
    break;
  case "config":
    cmdConfig(args.slice(1));
    break;
  case "refresh":
    cmdRefresh();
    break;
  case "refresh-bg":
    await cmdRefreshBg(args.slice(1));
    break;
  case "render":
    cmdRender();
    break;
  default:
    console.log(`cc-costline v${pkg.version} — Enhanced statusline for Claude Code

Commands:
  install     Configure Claude Code to use cc-costline
  uninstall   Remove cc-costline from Claude Code settings
  config      View/update display settings
  refresh     Manually recalculate cost cache
  render      Output statusline (reads stdin from Claude Code)

Examples:
  cc-costline install
  cc-costline config --period 7d
  cc-costline config --period 30d
  cc-costline config --period both
  cc-costline refresh`);
    break;
}

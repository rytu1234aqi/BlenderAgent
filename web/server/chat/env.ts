import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const WEB_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** 简单 .env 解析：不覆盖已存在的环境变量；支持 export 前缀、单双引号与 # 注释。 */
export function loadEnvFile(file: string): void {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return;
  }
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const body = trimmed.startsWith("export ") ? trimmed.slice(7).trim() : trimmed;
    const eq = body.indexOf("=");
    if (eq <= 0) continue;
    const key = body.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    if (process.env[key] !== undefined) continue;
    let value = body.slice(eq + 1).trim();
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    else if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1);
    if (!value) continue;
    process.env[key] = value;
  }
}

/** 同时加载仓库根与 BlenderAgent-main 根下的 .env（近端优先；空值视为未设置）。 */
export function loadChatEnvFiles(): void {
  loadEnvFile(path.resolve(WEB_ROOT, "..", ".env"));
  loadEnvFile(path.resolve(WEB_ROOT, "../..", ".env"));
}

function nonblank(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export interface ChatConfig {
  bridgeUrl: string;
  bridgeToken: string;
  bridgeTokenFile: string;
  blenderExe: string;
  scriptTimeoutMs: number;
  deepseekKey: string;
  deepseekModel: string;
  deepseekBaseUrl: string;
  runsDir: string;
}

export function resolveChatConfig(env: NodeJS.ProcessEnv = process.env): ChatConfig {
  const base = env.APPDATA || path.dirname(path.dirname(process.execPath)) || env.USERPROFILE || ".";
  return {
    bridgeUrl: (nonblank(env.BLENDER_BRIDGE_URL) ?? "http://127.0.0.1:9878").replace(/\/+$/, ""),
    bridgeToken: nonblank(env.BLENDER_BRIDGE_TOKEN) ?? "",
    bridgeTokenFile:
      nonblank(env.BLENDER_BRIDGE_TOKEN_FILE) ?? path.join(base, "blender-bridge", "token"),
    blenderExe: nonblank(env.BLENDER_EXECUTABLE) ?? "D:\\Blender\\blender.exe",
    scriptTimeoutMs: Number(nonblank(env.BLENDER_SCRIPT_TIMEOUT_MS) ?? 180_000),
    deepseekKey: nonblank(env.DEEPSEEK_API_KEY) ?? "",
    deepseekModel: nonblank(env.DEEPSEEK_MODEL) ?? "deepseek-chat",
    deepseekBaseUrl: (nonblank(env.DEEPSEEK_BASE_URL) ?? "https://api.deepseek.com").replace(/\/+$/, ""),
    runsDir: path.resolve(
      nonblank(env.BLENDGUARD_WEB_RUNS_DIR) ?? path.join(WEB_ROOT, "..", "runs", "web"),
    ),
  };
}

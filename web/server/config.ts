import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const WEB_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export type PlannerProvider = "deepseek" | "claude" | "deterministic";

export interface AppConfig {
  rootDir: string;
  webRoot: string;
  distDir: string;
  assetsDir: string;
  runsDir: string;
  python: string;
  blender?: string;
  planner: PlannerProvider;
  model: string;
  port: number;
  blenderTimeoutSeconds: number;
  processTimeoutMs: number;
  maxProcessOutput: number;
  maxInstructionLength: number;
}

function nonblank(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function resolvePlannerConfig(env: NodeJS.ProcessEnv = process.env): Pick<AppConfig, "planner" | "model"> {
  const requested = env.BLENDGUARD_PLANNER;
  const planner = requested === undefined ? "deepseek" : requested;
  if (planner !== "deepseek" && planner !== "claude" && planner !== "deterministic") {
    throw new Error(`BLENDGUARD_PLANNER 必须是 deepseek、claude 或 deterministic；收到：${JSON.stringify(requested)}`);
  }
  if (planner === "deepseek") {
    return {
      planner,
      model: nonblank(env.DEEPSEEK_MODEL) ?? nonblank(env.BLENDGUARD_MODEL) ?? "deepseek-flash",
    };
  }
  if (planner === "claude") {
    return { planner, model: nonblank(env.BLENDGUARD_MODEL) ?? "claude-opus-5-5" };
  }
  return { planner, model: "deterministic" };
}

const existingBlender = process.env.BLENDER_EXECUTABLE ??
  (process.platform === "win32" && fs.existsSync("D:\\Blender\\blender.exe") ? "D:\\Blender\\blender.exe" : undefined);

export const config: AppConfig = {
  rootDir: path.resolve(WEB_ROOT, ".."),
  webRoot: WEB_ROOT,
  distDir: path.join(WEB_ROOT, "dist"),
  assetsDir: path.resolve(process.env.BLENDGUARD_ASSETS_DIR ?? path.join(WEB_ROOT, "..", "assets")),
  runsDir: path.resolve(process.env.BLENDGUARD_WEB_RUNS_DIR ?? path.join(WEB_ROOT, "..", "runs", "web")),
  python: process.env.PYTHON_EXECUTABLE ?? "python",
  blender: existingBlender,
  ...resolvePlannerConfig(),
  port: Number(process.env.PORT ?? 8787),
  blenderTimeoutSeconds: Number(process.env.BLENDGUARD_BLENDER_TIMEOUT ?? 300),
  processTimeoutMs: Number(process.env.BLENDGUARD_PROCESS_TIMEOUT_MS ?? 20 * 60 * 1000),
  maxProcessOutput: 1_000_000,
  maxInstructionLength: 1000,
};

export function inspectCacheDirectory(config: Pick<AppConfig, "runsDir">): string {
  return path.join(config.runsDir, ".inspect-cache");
}

export function isPathInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

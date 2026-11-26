import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { WebError } from "./errors";

export async function readJson<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new WebError("REPORT_READ_FAILED", `无法读取机器可读报告：${(error as Error).message}`, 500);
  }
}

export async function fileSha256(filePath: string): Promise<string> {
  const content = await fs.readFile(filePath);
  return createHash("sha256").update(content).digest("hex");
}

export async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export function assertRunId(runId: string): void {
  if (!/^web-[a-z0-9-]{1,80}$/.test(runId)) {
    throw new WebError("INVALID_RUN_ID", "运行 ID 不合法。", 400);
  }
}

export function errorDetails(error: unknown): Record<string, unknown> | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const details = (error as { details?: unknown }).details;
  return typeof details === "object" && details !== null ? details as Record<string, unknown> : undefined;
}

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { BlenderInfo, ChatConnState } from "../../shared/types.js";

export class BridgeError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "BridgeError";
  }
}

export interface SnapshotResult {
  path: string;
  size: number;
  sha256?: string;
}

/**
 * 直连 Blender Bridge 插件（127.0.0.1:9878）的极窄客户端。
 * 只做四件事：健康检查、另存快照、加载文件、导出 GLB。
 */
export class BlenderBridge {
  state: ChatConnState = "unknown";
  error: string | undefined;
  info: BlenderInfo | undefined;

  constructor(
    private readonly url: string,
    private readonly tokenOverride: string,
    private readonly tokenFile: string,
    private readonly timeoutMs = 30_000,
  ) {}

  get tokenPath(): string {
    return this.tokenFile;
  }

  get baseUrl(): string {
    return this.url;
  }

  private token(): string {
    if (this.tokenOverride) {
      return this.tokenOverride;
    }
    try {
      return fs.readFileSync(this.tokenFile, "utf8").trim();
    } catch {
      return "";
    }
  }

  async connect(): Promise<boolean> {
    this.state = "connecting";
    try {
      const data = await this.request<BlenderInfo>("GET", "/health", undefined, 5_000);
      this.info = data;
      this.state = "connected";
      this.error = undefined;
      return true;
    } catch (error) {
      this.state = "error";
      this.error = describeBridgeError(error);
      return false;
    }
  }

  async snapshot(target: string): Promise<SnapshotResult> {
    return this.request<SnapshotResult>("POST", "/snapshot", { path: target }, this.timeoutMs);
  }

  async load(target: string, backup?: string): Promise<{ path: string; file: string | null }> {
    return this.request<{ path: string; file: string | null }>(
      "POST",
      "/load",
      backup ? { path: target, backup } : { path: target },
      this.timeoutMs,
    );
  }

  async exportGlb(target: string): Promise<{ path: string; size: number }> {
    return this.request<{ path: string; size: number }>("POST", "/export", { path: target }, this.timeoutMs);
  }

  private async request<T>(
    method: "GET" | "POST",
    route: string,
    body: unknown,
    timeoutMs: number,
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(new URL(route, this.url), {
        method,
        headers: {
          "X-Bridge-Token": this.token(),
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
      const text = await response.text();
      let payload: unknown = undefined;
      if (text) {
        try {
          payload = JSON.parse(text);
        } catch {
          payload = undefined;
        }
      }
      const data = (payload ?? {}) as Record<string, unknown>;
      if (!response.ok || data.ok === false) {
        const reason =
          (typeof data.error === "string" && data.error) || response.statusText || "桥接返回错误";
        throw new BridgeError(`Blender Bridge：${reason}`, response.status);
      }
      return (data.data ?? data) as T;
    } catch (error) {
      if (error instanceof BridgeError) {
        throw error;
      }
      if (error instanceof Error && error.name === "AbortError") {
        throw new BridgeError(`Blender Bridge 在 ${(timeoutMs / 1000).toFixed(0)}s 内没有响应`);
      }
      throw new BridgeError(describeBridgeError(error));
    } finally {
      clearTimeout(timer);
    }
  }
}

export function defaultTokenFile(): string {
  const base = process.env.APPDATA || os.homedir();
  return path.join(base, "blender-bridge", "token");
}

export function describeBridgeError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  if (/fetch failed|ECONNREFUSED|ECONNRESET/i.test(raw)) {
    return `连不上 Blender Bridge（127.0.0.1:9878）：请在 Blender 的 3D 视图按 N → Bridge → Start Bridge，确认插件已启用`;
  }
  if (/401|X-Bridge-Token/.test(raw)) {
    return `Blender Bridge 令牌不匹配：请确认 %APPDATA%\\blender-bridge\\token 与后端读取的是同一份`;
  }
  return raw;
}

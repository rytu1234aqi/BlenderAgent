import fs from "node:fs";
import path from "node:path";

import type { BlenderBridge } from "./bridge";
import type { ChatHub } from "./hub";

export interface SyncResult {
  ok: boolean;
  error?: string;
}

/**
 * GLB 参考镜像：
 * - 每个建模步骤后，把 headless 工作副本导出的 mirror.glb 复制成网页可读的 scene.glb；
 * - 手动同步时，从正在运行的 Blender 现场导出一份 GLB；
 * - 镜像只是给用户参考/注释用，不是交付物。
 */
export class SceneMirror {
  private version = 0;
  private lastError: string | null = null;

  constructor(
    private readonly hub: ChatHub,
    private readonly runsDir: string,
  ) {}

  get file(): string {
    return path.join(this.runsDir, "chat", ".sync", "scene.glb");
  }

  get error(): string | null {
    return this.lastError;
  }

  /** 把一步产出的 GLB 提升为当前参考镜像。 */
  publish(glbFile: string): boolean {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.copyFileSync(glbFile, this.file);
      const size = fs.statSync(this.file).size;
      if (size === 0) throw new Error("GLB 为空");
      this.version += 1;
      this.lastError = null;
      this.hub.setScene({ url: `/api/chat/scene?v=${this.version}`, version: this.version, at: Date.now() });
      return true;
    } catch (error) {
      this.lastError = (error as Error).message;
      return false;
    }
  }

  /** 从正在运行的 Blender 现场导出 GLB 并刷新镜像。 */
  async previewLive(bridge: BlenderBridge): Promise<SyncResult> {
    if (bridge.state !== "connected") {
      return { ok: false, error: bridge.error ?? "Blender Bridge 未连接" };
    }
    const temp = path.join(this.runsDir, "chat", ".sync", "live-export.glb");
    try {
      fs.mkdirSync(path.dirname(temp), { recursive: true });
      await bridge.exportGlb(temp);
      if (!this.publish(temp)) {
        throw new Error(this.lastError ?? "镜像更新失败");
      }
      this.hub.setStatus({ blender: "connected", blenderError: undefined });
      return { ok: true };
    } catch (error) {
      this.lastError = (error as Error).message;
      this.hub.setStatus({ blender: "error", blenderError: this.lastError });
      return { ok: false, error: this.lastError };
    }
  }
}

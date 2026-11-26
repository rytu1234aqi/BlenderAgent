import fsp from "node:fs/promises";
import path from "node:path";
import type { PlanReview } from "../shared/types";
import type { WorkbenchHub } from "./events";

interface RunnerEvent {
  event?: string;
  status?: string;
  operation_id?: string;
  tool?: string;
  result?: unknown;
  [key: string]: unknown;
}

export class ProgressTailer {
  private timer: NodeJS.Timeout | null = null;
  private readonly lineCounts = new Map<string, number>();
  private readonly toolEntries = new Map<string, string>();
  private scanning = false;

  constructor(
    private readonly runDir: string,
    private readonly plan: PlanReview,
    private readonly hub: WorkbenchHub,
  ) {}

  start(): void {
    this.timer = setInterval(() => void this.scan(), 400);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.scan();
  }

  private async scan(): Promise<void> {
    if (this.scanning) return;
    this.scanning = true;
    try {
      const attemptsDir = path.join(this.runDir, "attempts");
      const attempts = await fsp.readdir(attemptsDir, { withFileTypes: true }).catch(() => []);
      for (const attempt of attempts) {
        if (!attempt.isDirectory()) continue;
        const file = path.join(attemptsDir, attempt.name, "reports", "events.jsonl");
        const text = await fsp.readFile(file, "utf8").catch(() => "");
        const parts = text.split("\n");
        if (text && !text.endsWith("\n")) parts.pop();
        const lines = parts.filter((line) => line.trim());
        const previous = this.lineCounts.get(file) ?? 0;
        for (const line of lines.slice(previous)) {
          try {
            this.publish(JSON.parse(line) as RunnerEvent);
          } catch {
            // Only newline-terminated records are counted, so a partial final line is retried.
          }
        }
        this.lineCounts.set(file, lines.length);
      }
    } finally {
      this.scanning = false;
    }
  }

  private publish(event: RunnerEvent): void {
    if (!event.event) return;
    if (event.event === "tool.started" && event.operation_id) {
      const operation = this.plan.request?.operations.find((item) => item.operation_id === event.operation_id);
      const entry = this.hub.addEntry({
        kind: "tool",
        text: "",
        toolName: event.tool ?? event.operation_id,
        args: operation?.arguments,
        status: "running",
      });
      this.toolEntries.set(event.operation_id, entry.id);
      return;
    }
    if (event.event === "tool.finished" && event.operation_id) {
      const id = this.toolEntries.get(event.operation_id);
      if (id) {
        this.hub.patch(id, {
          status: event.status === "SUCCEEDED" ? "ok" : "error",
          result: event.result === undefined ? event.status : JSON.stringify(event.result, null, 2),
        });
      }
      return;
    }
    const messages: Record<string, string> = {
      "run.received": "Blender Runner 已接收固定契约与工具计划。",
      "scene.inspected": "工作副本场景快照已生成。",
      "run.validated": "Runner 目标与局部性门禁已记录 VALIDATED。",
      "rollback.completed": "Runner 已记录事务恢复完成。",
      "run.aborted": "Runner 已中止本次尝试。",
    };
    const text = messages[event.event];
    if (text) {
      this.hub.addEntry({ kind: event.event === "run.aborted" ? "error" : "system", text });
    }
  }
}

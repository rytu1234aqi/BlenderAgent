import { randomUUID } from "node:crypto";
import type { Response } from "express";
import type {
  AssetInfo,
  RunDetail,
  RunSummary,
  SceneInfo,
  ServerEvent,
  TimelineEntry,
  WorkbenchSnapshot,
  WorkStatus,
} from "../shared/types";

const MAX_ENTRIES = 500;

export class WorkbenchHub {
  private readonly clients = new Set<Response>();
  private entries: TimelineEntry[] = [];

  constructor(
    public status: WorkStatus,
    public assets: AssetInfo[] = [],
    public runs: RunSummary[] = [],
    public plan: WorkbenchSnapshot["plan"] = null,
    public currentRun: RunDetail | null = null,
    public scene: SceneInfo | null = null,
  ) {}

  snapshot(): WorkbenchSnapshot {
    return {
      status: this.status,
      assets: this.assets,
      runs: this.runs,
      entries: this.entries,
      plan: this.plan,
      currentRun: this.currentRun,
      scene: this.scene,
    };
  }

  addClient(response: Response): void {
    response.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    response.setHeader("Cache-Control", "no-cache, no-transform");
    response.setHeader("Connection", "keep-alive");
    response.setHeader("X-Accel-Buffering", "no");
    response.flushHeaders();
    this.clients.add(response);
    this.write(response, { type: "snapshot", snapshot: this.snapshot() });
    response.on("close", () => this.clients.delete(response));
  }

  private write(response: Response, event: ServerEvent): void {
    try {
      response.write(`data: ${JSON.stringify(event)}\n\n`);
    } catch {
      this.clients.delete(response);
    }
  }

  broadcast(event: ServerEvent): void {
    for (const client of this.clients) this.write(client, event);
  }

  heartbeat(): void {
    for (const client of this.clients) client.write(": ping\n\n");
  }

  setStatus(patch: Partial<WorkStatus>): void {
    Object.assign(this.status, patch);
    this.broadcast({ type: "status", status: this.status });
  }

  addEntry(input: Pick<TimelineEntry, "kind" | "text"> & Partial<TimelineEntry>): TimelineEntry {
    const entry: TimelineEntry = {
      id: randomUUID(),
      ts: Date.now(),
      kind: input.kind,
      text: input.text,
      toolName: input.toolName,
      args: input.args,
      status: input.status,
      result: input.result,
      durationMs: input.durationMs,
    };
    this.entries.push(entry);
    if (this.entries.length > MAX_ENTRIES) this.entries.splice(0, this.entries.length - MAX_ENTRIES);
    this.broadcast({ type: "entry", entry });
    return entry;
  }

  patch(id: string, patch: Partial<TimelineEntry>): void {
    const entry = this.entries.find((item) => item.id === id);
    if (!entry) return;
    Object.assign(entry, patch);
    this.broadcast({ type: "patch", id, patch });
  }

  setPlan(plan: WorkbenchSnapshot["plan"]): void {
    this.plan = plan;
    this.broadcast({ type: "plan", plan });
  }

  setRun(run: RunDetail | null): void {
    this.currentRun = run;
    this.broadcast({ type: "run", run });
  }

  setRuns(runs: RunSummary[]): void {
    this.runs = runs;
    this.broadcast({ type: "runs", runs });
  }

  setScene(scene: SceneInfo | null): void {
    this.scene = scene;
    this.broadcast({ type: "scene", scene });
  }

  clear(): void {
    this.entries = [];
    this.plan = null;
    this.currentRun = null;
    this.scene = null;
    this.broadcast({ type: "clear" });
  }
}

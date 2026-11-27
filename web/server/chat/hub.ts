import { randomUUID } from "node:crypto";
import type { Response } from "express";
import type { ChatEntry, ChatEvent, ChatQuestion, ChatScene, ChatStatus, ChatTurn } from "../../shared/types";

const MAX_ENTRIES = 500;

interface Pending {
  resolve: (answer: string) => void;
  reject: (error: Error) => void;
}

/** Studio 模式的事件中心：对话时间线、连接状态、参考镜像与待答问题。 */
export class ChatHub {
  private entries: ChatEntry[] = [];
  private clients = new Set<Response>();
  private pending: Pending | null = null;
  private pendingQuestion: ChatQuestion | null = null;
  scene: ChatScene | null = null;

  readonly status: ChatStatus;

  constructor(deepseek: boolean, model: string) {
    this.status = {
      bridge: "unknown",
      blender: "unknown",
      deepseek,
      model,
      busy: false,
      conversationId: null,
      conversationBaseline: null,
      turn: null,
    };
  }

  setQuestion(question: ChatQuestion | null): void {
    this.pendingQuestion = question;
    this.setStatus({ pendingQuestion: question ?? undefined });
  }

  setTurn(turn: ChatTurn | null): void {
    this.status.turn = turn;
    this.broadcast({ type: "status", status: this.status });
  }

  addClient(response: Response): void {
    response.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    response.setHeader("Cache-Control", "no-cache, no-transform");
    response.setHeader("Connection", "keep-alive");
    response.setHeader("X-Accel-Buffering", "no");
    response.flushHeaders?.();
    this.clients.add(response);
    response.write(`data: ${JSON.stringify({ type: "snapshot", snapshot: this.snapshot() })}\n\n`);
    response.on("close", () => this.clients.delete(response));
  }

  snapshot() {
    return {
      status: this.status,
      entries: this.entries,
      scene: this.scene,
    };
  }

  private write(response: Response, event: ChatEvent): void {
    try {
      response.write(`data: ${JSON.stringify(event)}\n\n`);
    } catch {
      this.clients.delete(response);
    }
  }

  broadcast(event: ChatEvent): void {
    for (const client of this.clients) this.write(client, event);
  }

  heartbeat(): void {
    for (const client of this.clients) {
      try {
        client.write(": ping\n\n");
      } catch {
        this.clients.delete(client);
      }
    }
  }

  setStatus(patch: Partial<ChatStatus>): void {
    Object.assign(this.status, patch);
    this.broadcast({ type: "status", status: this.status });
  }

  addEntry(input: Pick<ChatEntry, "kind"> & Partial<ChatEntry>): ChatEntry {
    const entry: ChatEntry = {
      id: randomUUID(),
      ts: Date.now(),
      kind: input.kind,
      text: input.text ?? "",
      streaming: input.streaming ?? false,
      toolName: input.toolName,
      args: input.args,
      status: input.status,
      result: input.result,
      options: input.options,
    };
    this.entries.push(entry);
    if (this.entries.length > MAX_ENTRIES) this.entries.splice(0, this.entries.length - MAX_ENTRIES);
    this.broadcast({ type: "entry", entry });
    return entry;
  }

  delta(id: string, text: string): void {
    const entry = this.entries.find((item) => item.id === id);
    if (!entry) return;
    entry.text += text;
    this.broadcast({ type: "delta", id, text });
  }

  patch(id: string, patch: Partial<ChatEntry>): void {
    const entry = this.entries.find((item) => item.id === id);
    if (!entry) return;
    Object.assign(entry, patch);
    this.broadcast({ type: "patch", id, patch });
  }

  setScene(scene: ChatScene | null): void {
    this.scene = scene;
    this.broadcast({ type: "scene", scene });
  }

  clear(): void {
    this.entries = [];
    this.scene = null;
    this.status.turn = null;
    this.broadcast({ type: "clear" });
  }

  hasPendingQuestion(): boolean {
    return this.pendingQuestion !== null;
  }

  askUser(question: string, options?: string[]): Promise<string> {
    if (this.pendingQuestion) throw new Error("已有未回答的问题");
    const entry = this.addEntry({ kind: "question", text: question, options, status: "running" });
    const pendingQuestion: ChatQuestion = { id: entry.id, question, options };
    this.pendingQuestion = pendingQuestion;

    return new Promise<string>((resolve, reject) => {
      this.pending = {
        resolve: (answer) => {
          this.patch(entry.id, { answer, status: "ok" });
          this.pending = null;
          this.setQuestion(null);
          resolve(answer);
        },
        reject: (error) => {
          this.patch(entry.id, { status: "error" });
          this.pending = null;
          this.setQuestion(null);
          reject(error);
        },
      };
      this.setQuestion(pendingQuestion);
    });
  }

  answerQuestion(answer: string): boolean {
    if (!this.pending) return false;
    const text = answer.trim();
    if (!text) return false;
    this.pending.resolve(text);
    return true;
  }

  cancelQuestion(reason = "已取消"): void {
    if (!this.pending) return;
    this.pending.reject(new Error(reason));
  }
}

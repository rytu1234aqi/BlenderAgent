import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { ChatBaseline, ChatTurn, ChatTurnSummary } from "../../shared/types";
import type { BlenderBridge } from "./bridge";
import type { ChatHub } from "./hub";

function sha256File(file: string): string {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

export interface JournalItem {
  at: number;
  tool: string;
  args?: unknown;
  status: "ok" | "error";
  durationMs?: number;
  summary?: string;
}

interface TurnRecord extends ChatTurn {
  dir: string;
  workingFile: string;
  journalPath: string;
  manifestPath: string;
  journal: JournalItem[];
}

/**
 * 事务与审计点（无 MCP 版）：
 * - 对话开始：把用户当前打开的工程（含未保存改动）另存一份基线快照；
 * - 每回合开始：再拍一次快照作为本回合审计点，并复制成隔离工作副本；
 * - 建模只改工作副本；采纳 = 工作副本 → output.blend + 审计 JSON，再推回 Blender；
 * - 回退 = 用基线快照覆盖回 Blender（覆盖前先备份现场）。
 */
export class ChatTx {
  private conversationId: string | null = null;
  private conversationBaseline: ChatBaseline | null = null;
  private turns = new Map<string, TurnRecord>();

  constructor(
    private readonly hub: ChatHub,
    private readonly bridge: BlenderBridge,
    private readonly runsDir: string,
  ) {}

  private chatRoot(): string {
    return path.join(this.runsDir, "chat");
  }

  get baseline(): ChatBaseline | null {
    return this.conversationBaseline;
  }

  async ensureConversation(): Promise<{ conversationId: string; baseline: ChatBaseline }> {
    if (this.conversationId && this.conversationBaseline) {
      return { conversationId: this.conversationId, baseline: this.conversationBaseline };
    }
    const conversationId = `conv-${Date.now()}-${randomUUID().slice(0, 6)}`;
    const dir = path.join(this.chatRoot(), conversationId);
    fs.mkdirSync(dir, { recursive: true });
    const baselinePath = path.join(dir, "baseline.blend");
    const baseline = await this.snapshotTo(baselinePath);
    fs.writeFileSync(
      path.join(dir, "conversation.json"),
      JSON.stringify({ conversationId, createdAt: Date.now(), baseline }, null, 2),
      "utf8",
    );
    this.conversationId = conversationId;
    this.conversationBaseline = baseline;
    this.hub.setStatus({ conversationId, conversationBaseline: baseline });
    return { conversationId, baseline };
  }

  /** 回合开始：快照当前活会话 + 生成工作副本。 */
  async beginTurn(instruction: string): Promise<{ turnId: string; baseline: ChatBaseline; workingFile: string }> {
    const { conversationId } = await this.ensureConversation();
    const turnId = `turn-${Date.now()}-${randomUUID().slice(0, 6)}`;
    const dir = path.join(this.chatRoot(), conversationId, "turns", turnId);
    fs.mkdirSync(dir, { recursive: true });
    const baselinePath = path.join(dir, "baseline.blend");
    const baseline = await this.snapshotTo(baselinePath);
    const workingFile = path.join(dir, "working.blend");
    fs.copyFileSync(baselinePath, workingFile);

    const manifestPath = path.join(dir, "manifest.json");
    const journalPath = path.join(dir, "journal.jsonl");
    const record: TurnRecord = {
      turnId,
      instruction,
      startedAt: Date.now(),
      baseline,
      committed: false,
      dir,
      workingFile,
      journalPath,
      manifestPath,
      journal: [],
    };
    fs.writeFileSync(
      manifestPath,
      JSON.stringify(
        {
          conversationId,
          turnId,
          instruction,
          startedAt: record.startedAt,
          baseline,
          workingFile,
          conversationBaseline: this.conversationBaseline,
        },
        null,
        2,
      ),
      "utf8",
    );
    fs.writeFileSync(journalPath, "", "utf8");
    this.turns.set(turnId, record);
    this.hub.setTurn({ turnId, instruction, startedAt: record.startedAt, baseline, committed: false });
    this.hub.addEntry({
      kind: "system",
      text: `审计点：已快照当前工程并建立隔离工作副本（baseline ${baseline.sha256.slice(0, 12)}…）`,
    });
    return { turnId, baseline, workingFile };
  }

  workingFile(turnId: string): string | null {
    return this.turns.get(turnId)?.workingFile ?? null;
  }

  appendJournal(turnId: string, item: JournalItem): void {
    const turn = this.turns.get(turnId);
    if (!turn) return;
    turn.journal.push(item);
    try {
      fs.appendFileSync(turn.journalPath, `${JSON.stringify(item)}\n`, "utf8");
    } catch {
      /* 审计日志失败不阻断建模 */
    }
  }

  /** 采纳：工作副本落成 output.blend，写审计，并推回正在运行的 Blender。 */
  async commit(turnId: string): Promise<{ path: string; sha256: string; size: number; pushed: boolean }> {
    const turn = this.turns.get(turnId);
    if (!turn) {
      throw new Error("找不到本回合的审计点，请先发送一条消息。");
    }
    if (!fs.existsSync(turn.workingFile)) {
      throw new Error("工作副本不存在，可能已被清理。");
    }
    const outputPath = path.join(turn.dir, "output.blend");
    fs.copyFileSync(turn.workingFile, outputPath);
    const sha256 = sha256File(outputPath);
    const size = fs.statSync(outputPath).size;
    const audit = {
      turnId,
      instruction: turn.instruction,
      committedAt: Date.now(),
      baseline: turn.baseline,
      conversationBaseline: this.conversationBaseline,
      output: { path: outputPath, sha256, size },
      journal: turn.journal,
    };

    let pushed = false;
    let pushError: string | undefined;
    try {
      await this.bridge.load(outputPath, path.join(turn.dir, "live-before-commit.blend"));
      pushed = true;
    } catch (error) {
      pushError = (error as Error).message;
    }
    fs.writeFileSync(
      path.join(turn.dir, "audit.json"),
      JSON.stringify({ ...audit, pushedToBlender: pushed, pushError }, null, 2),
      "utf8",
    );

    turn.committed = true;
    const manifest = JSON.parse(fs.readFileSync(turn.manifestPath, "utf8")) as Record<string, unknown>;
    manifest.committed = true;
    manifest.committedAt = audit.committedAt;
    manifest.output = audit.output;
    fs.writeFileSync(turn.manifestPath, JSON.stringify(manifest, null, 2), "utf8");
    this.hub.setTurn({
      turnId: turn.turnId,
      instruction: turn.instruction,
      startedAt: turn.startedAt,
      baseline: turn.baseline,
      committed: true,
    });
    this.hub.addEntry({
      kind: "system",
      text: pushed
        ? `已采纳：交付副本 ${path.basename(outputPath)}（sha256 ${sha256.slice(0, 12)}…）已推送到 Blender。`
        : `已生成交付副本 ${path.basename(outputPath)}，但推送到 Blender 失败：${pushError}`,
    });
    if (!pushed) {
      throw new Error(`交付副本已生成，但推送到 Blender 失败：${pushError}（可手动打开 ${outputPath}）`);
    }
    return { path: outputPath, sha256, size, pushed };
  }

  /** 回退：把基线快照推回 Blender（覆盖前会先备份现场）。 */
  async revert(scope: "turn" | "conversation"): Promise<{ scope: string; path: string }> {
    const current = this.hub.status.turn ? this.turns.get(this.hub.status.turn.turnId) : null;
    const baseline =
      scope === "conversation" ? this.conversationBaseline : current?.baseline ?? this.conversationBaseline;
    if (!baseline) {
      throw new Error("还没有可回退的审计点。");
    }
    if (!fs.existsSync(baseline.path)) {
      throw new Error(`基线快照不存在：${baseline.path}`);
    }
    const backup = path.join(this.chatRoot(), ".revert-backup.blend");
    fs.mkdirSync(path.dirname(backup), { recursive: true });
    await this.bridge.load(baseline.path, backup);
    if (current && scope === "turn") {
      this.hub.setTurn({
        turnId: current.turnId,
        instruction: current.instruction,
        startedAt: current.startedAt,
        baseline: current.baseline,
        committed: false,
      });
    }
    this.hub.addEntry({
      kind: "system",
      text: scope === "conversation" ? "已回退到对话开始前的审计点。" : "已回退到本回合开始前的审计点。",
    });
    return { scope, path: baseline.path };
  }

  resetConversation(): void {
    this.conversationId = null;
    this.conversationBaseline = null;
    this.turns.clear();
    this.hub.setStatus({ conversationId: null, conversationBaseline: null, turn: null });
  }

  listTurns(): ChatTurnSummary[] {
    const root = this.chatRoot();
    if (!fs.existsSync(root)) return [];
    const summaries: ChatTurnSummary[] = [];
    for (const conversation of fs.readdirSync(root)) {
      const turnsDir = path.join(root, conversation, "turns");
      if (!fs.existsSync(turnsDir)) continue;
      for (const turnName of fs.readdirSync(turnsDir)) {
        const dir = path.join(turnsDir, turnName);
        const manifestPath = path.join(dir, "manifest.json");
        if (!fs.existsSync(manifestPath)) continue;
        try {
          const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
            turnId?: string;
            instruction?: string;
            startedAt?: number;
            committed?: boolean;
            baseline?: ChatBaseline;
          };
          const journalPath = path.join(dir, "journal.jsonl");
          const steps = fs.existsSync(journalPath)
            ? fs.readFileSync(journalPath, "utf8").split("\n").filter(Boolean).length
            : 0;
          summaries.push({
            turnId: manifest.turnId ?? turnName,
            instruction: manifest.instruction ?? "",
            startedAt: manifest.startedAt ?? 0,
            committed: Boolean(manifest.committed),
            steps,
            baselineSha256: manifest.baseline?.sha256 ?? null,
            journalPath: fs.existsSync(journalPath) ? journalPath : null,
          });
        } catch {
          /* 忽略坏文件 */
        }
      }
    }
    return summaries.sort((a, b) => b.startedAt - a.startedAt);
  }

  private async snapshotTo(target: string): Promise<ChatBaseline> {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const result = await this.bridge.snapshot(target);
    const stat = fs.statSync(target, { throwIfNoEntry: false });
    if (!stat || stat.size === 0) {
      throw new Error("审计点快照失败：快照文件为空");
    }
    return {
      path: target,
      sha256: sha256File(target),
      size: stat.size ?? result.size,
      at: Date.now(),
    };
  }
}

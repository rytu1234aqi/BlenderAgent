import {
  streamChat,
  type ChatMessage,
  type ChatResult,
  type ChatTool,
  type DeepSeekConnection,
  type ToolCall,
} from "./deepseek";
import type { ChatHub } from "./hub";
import { SYSTEM_PROMPT } from "./prompt";
import type { JournalItem } from "./tx";

const MAX_STEPS = 24;
const MAX_HISTORY = 40;
const MAX_LOG_FOR_MODEL = 5000;
const MAX_LOG_FOR_UI = 3500;

const VERIFY_INSTRUCTION = `（系统质检指令，非用户发言）你还没有做收尾自检。请再调用一次 run_blender_script：
1) 打印场景统计：对象名与类型、关键部件尺寸（x/y/z，米）、材质数量与名称、灯光与相机数量；
2) 对照质量清单自查：部件是否齐全、比例是否真实、有无穿模/悬空/缺面、材质是否生效、相机是否对正主体；
3) 发现问题立即在同一个脚本里修正，修正后重新打印统计确认；
4) 这一步的 summary 必须包含「自检」二字。之后再用中文总结交付。`;

export interface StepOutcome {
  ok: boolean;
  /** 给模型和界面看的结果（stdout/stderr 尾部） */
  log: string;
  glbFile?: string;
  durationMs: number;
}

export interface AgentDeps {
  hub: ChatHub;
  connection: DeepSeekConnection;
  runStep: (code: string, summary: string) => Promise<StepOutcome>;
  journal: (item: JournalItem) => void;
}

const RUN_SCRIPT_TOOL: ChatTool = {
  type: "function",
  function: {
    name: "run_blender_script",
    description:
      "在隔离工作副本上执行一段 Blender Python 脚本（可用 bpy/mathutils/bmesh）。执行成功后系统自动保存并导出 GLB 参考镜像。脚本要完整、可顺序执行；用 print 输出自检信息，用 result 变量返回数据。",
    parameters: {
      type: "object",
      properties: {
        code: { type: "string", description: "完整可执行的 Python 脚本（bpy 环境）" },
        summary: { type: "string", description: "这一步做了什么（中文，一句话）" },
      },
      required: ["code", "summary"],
    },
  },
};

const ASK_USER_TOOL: ChatTool = {
  type: "function",
  function: {
    name: "ask_user",
    description: "遇到重要决策或信息不足时向用户提问。问题应简短，提供 2~4 个可点击选项，一次只问一个关键问题。",
    parameters: {
      type: "object",
      properties: {
        question: { type: "string", description: "要询问用户的问题" },
        options: { type: "array", items: { type: "string" }, description: "可点击的选项（可选，2~4 个）" },
      },
      required: ["question"],
    },
  },
};

function isAbortError(error: unknown): boolean {
  const name = (error as Error)?.name ?? "";
  const message = (error as Error)?.message ?? "";
  return name === "AbortError" || /aborted|已取消|任务已取消/i.test(message);
}

function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n…（已截断，共 ${text.length} 字符）`;
}

/**
 * Studio Agent：DeepSeek function-calling 循环。模型只输出脚本，
 * 由后端在隔离工作副本上执行并刷新参考镜像。
 * 换工作流/换模型时只需替换本文件（对外接口 run / cancel / reset / busy）。
 */
export class StudioAgent {
  private history: ChatMessage[] = [];
  private abortController: AbortController | null = null;
  private readonly deps: AgentDeps;

  private modelingTouched = false;
  private verified = false;
  private verifyForced = false;

  constructor(deps: AgentDeps) {
    this.deps = deps;
  }

  get busy(): boolean {
    return this.abortController !== null;
  }

  reset(): void {
    this.history = [];
  }

  cancel(): void {
    this.abortController?.abort();
    this.deps.hub.cancelQuestion("任务已取消");
  }

  async run(userText: string): Promise<void> {
    if (this.busy) throw new Error("Agent 正在执行，请稍候或先取消");
    const { hub } = this.deps;
    this.abortController = new AbortController();
    this.modelingTouched = false;
    this.verified = false;
    this.verifyForced = false;
    hub.setStatus({ busy: true });
    hub.addEntry({ kind: "user", text: userText });
    this.history.push({ role: "user", content: userText });

    try {
      for (let step = 0; step < MAX_STEPS; step++) {
        if (this.abortController.signal.aborted) throw new Error("aborted");
        const result = await this.callModel(this.abortController.signal);
        const calls = result.toolCalls;
        if (calls.length === 0) {
          if (this.modelingTouched && !this.verified && !this.verifyForced) {
            this.verifyForced = true;
            hub.addEntry({ kind: "system", text: "质检：要求先自检再收尾" });
            this.history.push({ role: "user", content: VERIFY_INSTRUCTION });
            continue;
          }
          break;
        }
        for (let i = 0; i < calls.length; i++) {
          try {
            await this.runTool(calls[i]);
          } catch (error) {
            if (isAbortError(error)) {
              for (let j = i + 1; j < calls.length; j++) {
                this.history.push({ role: "tool", tool_call_id: calls[j].id, content: "（任务已取消）" });
              }
            }
            throw error;
          }
        }
      }
    } catch (error) {
      if (isAbortError(error)) hub.addEntry({ kind: "system", text: "已取消当前任务" });
      else hub.addEntry({ kind: "error", text: `执行失败：${(error as Error).message}` });
    } finally {
      this.abortController = null;
      hub.setStatus({ busy: false, pendingQuestion: undefined });
    }
  }

  private messages(): ChatMessage[] {
    const history = this.history;
    let tail: ChatMessage[] = history;
    if (history.length > MAX_HISTORY) {
      let start = history.length - MAX_HISTORY;
      while (start < history.length && history[start].role !== "user") start++;
      tail = history.slice(start);
    }
    return [{ role: "system", content: SYSTEM_PROMPT }, ...tail];
  }

  private async callModel(signal: AbortSignal): Promise<ChatResult> {
    const hub = this.deps.hub;
    let thinkingId: string | null = null;
    let assistantId: string | null = null;
    try {
      const result = await streamChat(this.deps.connection, {
        messages: this.messages(),
        tools: [RUN_SCRIPT_TOOL, ASK_USER_TOOL],
        signal,
        model: this.deps.connection.model,
        onReasoning: (text) => {
          if (!thinkingId) thinkingId = hub.addEntry({ kind: "thinking", text: "", streaming: true }).id;
          hub.delta(thinkingId, text);
        },
        onContent: (text) => {
          if (!assistantId) assistantId = hub.addEntry({ kind: "assistant", text: "", streaming: true }).id;
          hub.delta(assistantId, text);
        },
      });
      if (thinkingId) hub.patch(thinkingId, { streaming: false });
      if (assistantId) hub.patch(assistantId, { streaming: false });
      this.history.push({
        role: "assistant",
        content: result.content || null,
        tool_calls: result.toolCalls.length ? result.toolCalls : undefined,
      });
      return result;
    } catch (error) {
      if (thinkingId) hub.patch(thinkingId, { streaming: false });
      if (assistantId) hub.patch(assistantId, { streaming: false });
      throw error;
    }
  }

  private async runTool(call: ToolCall): Promise<void> {
    const { hub } = this.deps;
    const name = call.function.name;

    let args: Record<string, unknown> = {};
    try {
      args = call.function.arguments ? (JSON.parse(call.function.arguments) as Record<string, unknown>) : {};
    } catch {
      hub.addEntry({
        kind: "tool",
        text: "",
        toolName: name,
        args: call.function.arguments,
        status: "error",
        result: "工具参数 JSON 解析失败",
      });
      this.history.push({ role: "tool", tool_call_id: call.id, content: "工具参数 JSON 解析失败，请检查参数格式。" });
      return;
    }

    if (name === "ask_user") {
      const question = String(args.question ?? "").trim() || "请补充更多信息";
      const options = Array.isArray(args.options) ? args.options.map(String).filter(Boolean).slice(0, 5) : undefined;
      const answer = await hub.askUser(question, options);
      this.history.push({ role: "tool", tool_call_id: call.id, content: `用户回答：${answer}` });
      return;
    }

    if (name !== "run_blender_script") {
      hub.addEntry({ kind: "tool", text: "", toolName: name, status: "error", result: "未知工具" });
      this.history.push({ role: "tool", tool_call_id: call.id, content: `未知工具 ${name}，只能使用 run_blender_script 或 ask_user。` });
      return;
    }

    const code = String(args.code ?? "");
    const summary = String(args.summary ?? "").trim() || "未命名步骤";
    if (!code.trim()) {
      hub.addEntry({ kind: "tool", text: "", toolName: name, args: { summary }, status: "error", result: "脚本为空" });
      this.history.push({ role: "tool", tool_call_id: call.id, content: "脚本为空，请提供完整 Python 代码。" });
      return;
    }

    const entry = hub.addEntry({
      kind: "tool",
      text: summary,
      toolName: "run_blender_script",
      args: { summary, bytes: code.length, code },
      status: "running",
    });
    try {
      const outcome = await this.deps.runStep(code, summary);
      hub.patch(entry.id, {
        status: outcome.ok ? "ok" : "error",
        result: truncate(outcome.log || (outcome.ok ? "脚本执行成功" : "脚本执行失败"), MAX_LOG_FOR_UI),
        durationMs: outcome.durationMs,
      });
      this.deps.journal({
        at: Date.now(),
        tool: "run_blender_script",
        args: { summary, bytes: code.length },
        status: outcome.ok ? "ok" : "error",
        durationMs: outcome.durationMs,
        summary: truncate(outcome.log, 800),
      });
      if (outcome.ok) {
        this.modelingTouched = true;
        if (/自检/.test(summary)) this.verified = true;
        this.history.push({
          role: "tool",
          tool_call_id: call.id,
          content: truncate(`步骤成功（${outcome.durationMs}ms）\n${outcome.log || "（无输出）"}`, MAX_LOG_FOR_MODEL),
        });
      } else {
        this.history.push({
          role: "tool",
          tool_call_id: call.id,
          content: truncate(`步骤失败：\n${outcome.log}`, MAX_LOG_FOR_MODEL),
        });
      }
    } catch (error) {
      const message = (error as Error).message;
      hub.patch(entry.id, { status: "error", result: truncate(message, MAX_LOG_FOR_UI) });
      this.deps.journal({
        at: Date.now(),
        tool: "run_blender_script",
        args: { summary, bytes: code.length },
        status: "error",
        summary: truncate(message, 800),
      });
      this.history.push({ role: "tool", tool_call_id: call.id, content: `步骤执行失败：${truncate(message, MAX_LOG_FOR_MODEL)}` });
    }
  }
}

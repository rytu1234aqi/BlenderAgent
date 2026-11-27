import { useState } from "react";
import {
  AlertTriangle,
  Bot,
  CircleHelp,
  CornerDownLeft,
  Loader2,
  MessageSquare,
  Sparkles,
  Square,
  Terminal,
  User,
} from "lucide-react";
import type { ChatEntry, ChatStatus } from "../../../shared/types";

function time(ts: number): string {
  return new Date(ts).toLocaleTimeString("zh-CN", { hour12: false });
}

function statusColor(status: ChatEntry["status"]): string {
  if (status === "running") return "text-[#d7a64a]";
  if (status === "ok") return "text-[#4fc3b1]";
  if (status === "error") return "text-[#e1746b]";
  return "text-[#82939e]";
}

function ChatEntryView({ entry, onAnswer }: { entry: ChatEntry; onAnswer: (text: string) => void }) {
  const [open, setOpen] = useState(false);
  if (entry.kind === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-l-lg rounded-tr-lg border border-[#34505a] bg-[#16262c] px-3 py-2">
          <div className="mb-1 flex items-center gap-1.5 text-[9.5px] text-[#7f9aa4]">
            <User className="h-3 w-3" />
            你 · {time(entry.ts)}
          </div>
          <p className="whitespace-pre-wrap text-[11.5px] leading-relaxed text-[#e7eef0]">{entry.text}</p>
        </div>
      </div>
    );
  }
  if (entry.kind === "assistant") {
    return (
      <div className="flex gap-2">
        <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded border border-[#2f4a43] bg-[#14211f] text-[#4fc3b1]">
          <Bot className="h-3.5 w-3.5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="mb-1 text-[9.5px] text-[#5f707b]">建模 Agent · {time(entry.ts)}</div>
          <p className="whitespace-pre-wrap text-[11.5px] leading-relaxed text-[#dbe6ea]">
            {entry.text}
            {entry.streaming ? <span className="ml-0.5 inline-block h-3 w-1 animate-pulse bg-[#4fc3b1]" /> : null}
          </p>
        </div>
      </div>
    );
  }
  if (entry.kind === "thinking") {
    return (
      <details className="group rounded border border-[#1f2a33] bg-[#0d1318] px-2.5 py-1.5" open={entry.streaming}>
        <summary className="flex cursor-pointer items-center gap-1.5 text-[10px] text-[#5f707b]">
          <Sparkles className="h-3 w-3" />
          思考过程
          {entry.streaming ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
        </summary>
        <p className="mt-1 whitespace-pre-wrap text-[10.5px] leading-relaxed text-[#7b8f9b]">{entry.text}</p>
      </details>
    );
  }
  if (entry.kind === "tool") {
    return (
      <div className="rounded border border-[#1f2a33] bg-[#0d1318]">
        <button
          type="button"
          onClick={() => setOpen(!open)}
          className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left"
        >
          <Terminal className={`h-3 w-3 shrink-0 ${statusColor(entry.status)}`} />
          <span className="mono truncate text-[10.5px] text-[#a9bcc5]">{entry.toolName ?? "tool"}</span>
          <span className={`ml-auto flex shrink-0 items-center gap-1 text-[9.5px] ${statusColor(entry.status)}`}>
            {entry.status === "running" ? <Loader2 className="h-2.5 w-2.5 animate-spin" /> : null}
            {entry.status ?? "done"}
            {entry.durationMs !== undefined ? <span className="text-[#5f707b]"> {(entry.durationMs / 1000).toFixed(1)}s</span> : null}
          </span>
        </button>
        {open ? (
          <div className="max-h-56 overflow-auto border-t border-[#1f2a33] px-2.5 py-2">
            <div className="text-[9px] uppercase tracking-wide text-[#5f707b]">参数</div>
            <pre className="mt-0.5 whitespace-pre-wrap break-all text-[9.5px] leading-relaxed text-[#82939e]">
              {typeof entry.args === "string" ? entry.args : JSON.stringify(entry.args, null, 2)}
            </pre>
            {entry.result ? (
              <>
                <div className="mt-2 text-[9px] uppercase tracking-wide text-[#5f707b]">结果</div>
                <pre className="mt-0.5 whitespace-pre-wrap break-all text-[9.5px] leading-relaxed text-[#a9bcc5]">{entry.result}</pre>
              </>
            ) : null}
          </div>
        ) : null}
      </div>
    );
  }
  if (entry.kind === "question") {
    const answered = Boolean(entry.answer);
    return (
      <div className="rounded border border-[#8a6d2f]/50 bg-[#221c12] px-2.5 py-2">
        <div className="flex items-center gap-1.5 text-[10px] text-[#d7a64a]">
          <CircleHelp className="h-3 w-3" />
          需要你的决定
        </div>
        <p className="mt-1 text-[11.5px] leading-relaxed text-[#f1e3c2]">{entry.text}</p>
        {answered ? (
          <p className="mt-1.5 text-[10.5px] text-[#9fb0ba]">已回答：{entry.answer}</p>
        ) : entry.options?.length ? (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {entry.options.map((option) => (
              <button
                key={option}
                type="button"
                onClick={() => onAnswer(option)}
                className="rounded border border-[#8a6d2f]/60 px-2 py-1 text-[10.5px] text-[#e8d3a8] hover:bg-[#8a6d2f]/20"
              >
                {option}
              </button>
            ))}
          </div>
        ) : null}
      </div>
    );
  }
  if (entry.kind === "error") {
    return (
      <div className="rounded border border-[#e1746b]/40 bg-[#2b1d20] px-2.5 py-2">
        <div className="flex items-center gap-1.5 text-[10px] text-[#e1746b]">
          <AlertTriangle className="h-3 w-3" />
          出错
        </div>
        <p className="mt-0.5 text-[10.5px] leading-relaxed text-[#efb1aa]">{entry.text}</p>
      </div>
    );
  }
  return (
    <div className="rounded border border-[#1f2a33] px-2.5 py-1.5 text-[10.5px] leading-relaxed text-[#7b8f9b]">
      {entry.text}
    </div>
  );
}

export function ChatPanel({
  entries,
  status,
  connected,
  draft,
  suggestions,
  onDraftChange,
  onSend,
  onAnswer,
  onCancel,
  onRemoveSuggestion,
}: {
  entries: ChatEntry[];
  status: ChatStatus;
  connected: boolean;
  draft: string;
  suggestions: string[];
  onDraftChange: (value: string) => void;
  onSend: () => void;
  onAnswer: (text: string) => void;
  onCancel: () => void;
  onRemoveSuggestion: (index: number) => void;
}) {
  const pending = status.pendingQuestion;
  const submit = () => {
    if (!draft.trim() || status.busy) return;
    onSend();
  };
  return (
    <div className="flex h-full min-h-0 flex-col bg-[#0e141a]">
      <div className="shrink-0 border-b border-[#1f2a33] px-3 py-2.5">
        <div className="flex items-center gap-2 text-[11px] font-medium tracking-[0.08em] text-[#c3d0d6]">
          <MessageSquare className="h-3.5 w-3.5 text-[#4fc3b1]" />
          与建模 Agent 对话
          <span className={`ml-auto flex items-center gap-1 text-[9.5px] ${connected ? "text-[#4fc3b1]" : "text-[#e1746b]"}`}>
            {connected ? "事件流已连接" : "事件流断开"}
          </span>
        </div>
        <p className="mt-1 text-[9.5px] leading-relaxed text-[#5f707b]">
          Blender 是主战场。Agent 会写 Blender 脚本，在隔离工作副本里真实建模；参考镜像只用于查看与注释。
        </p>
      </div>

      <div className="min-h-0 flex-1 space-y-2.5 overflow-y-auto px-3 py-3">
        {entries.length === 0 ? (
          <div className="rounded border border-dashed border-[#2a3640] px-3 py-4 text-center">
            <Bot className="mx-auto h-6 w-6 text-[#41525e]" />
            <p className="mt-2 text-[11px] text-[#9fb0ba]">先描述你要做的模型</p>
            <p className="mt-1 text-[10px] leading-relaxed text-[#5f707b]">
              例如「做一盏北欧风格的台灯，木质底座，暖光」「把参考里选中的灯罩旋转 15 度」。
            </p>
          </div>
        ) : (
          entries.map((entry) => <ChatEntryView key={entry.id} entry={entry} onAnswer={onAnswer} />)
        )}
      </div>

      {pending ? (
        <div className="shrink-0 border-t border-[#8a6d2f]/40 bg-[#221c12] px-3 py-2 text-[10.5px] text-[#e8d3a8]">
          Agent 在等你回答：{pending.question}
        </div>
      ) : null}

      <div className="shrink-0 border-t border-[#1f2a33] px-3 py-2.5">
        {suggestions.length ? (
          <div className="mb-2 space-y-1">
            <div className="flex items-center justify-between text-[9.5px] text-[#5f707b]">
              <span>参考镜像上的调整建议（会随消息一起发送）</span>
              <button type="button" onClick={() => onRemoveSuggestion(-1)} className="hover:text-[#c3d0d6]">
                清空
              </button>
            </div>
            {suggestions.map((note, index) => (
              <div key={`${index}-${note.slice(0, 8)}`} className="flex items-start gap-1.5 rounded border border-[#2a3640] bg-[#10151b] px-2 py-1.5">
                <span className="flex-1 text-[10px] leading-relaxed text-[#a9bcc5]">{note}</span>
                <button type="button" aria-label="删除建议" onClick={() => onRemoveSuggestion(index)} className="text-[9px] text-[#5f707b] hover:text-[#efb1aa]">
                  删
                </button>
              </div>
            ))}
          </div>
        ) : null}
        <div className="rounded border border-[#2a3640] bg-[#10151b] focus-within:border-[#4fc3b1]/50">
          <textarea
            value={draft}
            onChange={(event) => onDraftChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                submit();
              }
            }}
            rows={3}
            placeholder={pending ? "直接回答上面的问题…" : "描述你要做的模型，或对参考镜像提出修改意见…"}
            className="h-[72px] w-full resize-none bg-transparent px-2.5 py-2 text-[11.5px] leading-relaxed text-[#e7eef0] outline-none placeholder:text-[#4d5f6a]"
          />
          <div className="flex items-center justify-between border-t border-[#1f2a33] px-2 py-1.5">
            <span className="text-[9px] text-[#5f707b]">Enter 发送 · Shift+Enter 换行</span>
            {status.busy ? (
              <button
                type="button"
                onClick={onCancel}
                className="flex h-6 items-center gap-1 rounded border border-[#e1746b]/50 px-2 text-[10px] text-[#efb1aa] hover:bg-[#e1746b]/10"
              >
                <Square className="h-2.5 w-2.5" />
                取消
              </button>
            ) : (
              <button
                type="button"
                onClick={submit}
                disabled={!draft.trim()}
                className="flex h-6 items-center gap-1 rounded bg-[#4fc3b1] px-2 text-[10px] font-medium text-[#0c1116] hover:bg-[#6fd6c5] disabled:cursor-not-allowed disabled:opacity-40"
              >
                <CornerDownLeft className="h-2.5 w-2.5" />
                发送
              </button>
            )}
          </div>
        </div>
        <p className="mt-1.5 text-[9px] text-[#4d5f6a]">
          {status.deepseek ? `模型 ${status.model}` : "未配置 DEEPSEEK_API_KEY，对话不可用"}
        </p>
      </div>
    </div>
  );
}

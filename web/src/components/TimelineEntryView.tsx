import { AlertCircle, Bot, CheckCircle2, ChevronDown, Circle, Loader2, User, Wrench } from "lucide-react";
import type { TimelineEntry } from "../../shared/types";

export function TimelineEntryView({ entry }: { entry: TimelineEntry }) {
  const Icon = entry.kind === "user" ? User : entry.kind === "tool" ? Wrench : entry.kind === "error" ? AlertCircle : Bot;
  const time = new Date(entry.ts).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  return (
    <article className={`border-l-2 py-2 pl-3 pr-1 ${entry.kind === "error" || entry.status === "error" ? "border-[#e1746b]" : entry.kind === "tool" ? "border-[#41535f]" : "border-transparent"}`}>
      <div className="flex items-center gap-2">
        <Icon className={`h-3.5 w-3.5 shrink-0 ${entry.kind === "error" ? "text-[#e1746b]" : "text-[#71838e]"}`} />
        <span className="text-[10px] font-medium text-[#9fb0ba]">
          {entry.kind === "user" ? "编辑指令" : entry.kind === "tool" ? entry.toolName ?? "受控工具" : entry.kind === "error" ? "流程错误" : "BlendGuard"}
        </span>
        {entry.status ? (
          <span className={`mono flex items-center gap-1 text-[9px] ${entry.status === "ok" ? "text-[#4fc3b1]" : entry.status === "error" ? "text-[#e1746b]" : "text-[#d7a64a]"}`}>
            {entry.status === "running" ? <Loader2 className="h-3 w-3 animate-spin" /> : entry.status === "ok" ? <CheckCircle2 className="h-3 w-3" /> : <Circle className="h-3 w-3" />}
            {entry.status}
          </span>
        ) : null}
        <time className="mono ml-auto shrink-0 text-[9px] text-[#536570]">{time}</time>
      </div>
      <p className="mt-1.5 whitespace-pre-wrap break-words text-[11px] leading-relaxed text-[#aebdc5]">{entry.text}</p>
      {entry.durationMs !== undefined ? <div className="mono mt-1 text-[9px] text-[#637681]">{entry.durationMs.toFixed(0)} ms</div> : null}
      {entry.args !== undefined ? (
        <details className="mt-1.5">
          <summary className="flex cursor-pointer items-center gap-1 text-[9.5px] text-[#637681]"><ChevronDown className="h-3 w-3" />工具参数</summary>
          <pre className="mono mt-1 max-h-44 overflow-auto whitespace-pre-wrap break-all rounded bg-[#0d1217] p-2 text-[9px] leading-relaxed text-[#71838e]">{JSON.stringify(entry.args, null, 2)}</pre>
        </details>
      ) : null}
      {entry.result ? <pre className="mono mt-1.5 max-h-36 overflow-auto whitespace-pre-wrap break-all rounded bg-[#0d1217] p-2 text-[9px] text-[#82939e]">{entry.result}</pre> : null}
    </article>
  );
}

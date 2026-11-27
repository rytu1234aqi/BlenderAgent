import { PenTool, ShieldCheck } from "lucide-react";
import type { ChatStatus } from "../../../shared/types";

export function StudioHeader({
  status,
  onSwitchWorkbench,
  onReset,
}: {
  status: ChatStatus;
  onSwitchWorkbench: () => void;
  onReset: () => void;
}) {
  const dot = (state: "ok" | "warn" | "error") =>
    state === "ok" ? "bg-[#4fc3b1]" : state === "warn" ? "bg-[#d7a64a]" : "bg-[#e1746b]";
  return (
    <header className="flex h-14 shrink-0 items-center gap-4 border-b border-[#2a3640] bg-[#10151b] px-4">
      <div className="flex items-center gap-3">
        <span className="flex h-8 w-8 items-center justify-center rounded border border-[#4fc3b1]/40 bg-[#4fc3b1]/10 text-[#4fc3b1]">
          <PenTool className="h-4 w-4" />
        </span>
        <div>
          <div className="text-[14px] font-semibold tracking-[0.08em] text-[#edf3f5]">模鉴 · Studio</div>
          <div className="text-[10px] tracking-[0.12em] text-[#82939e]">Blender 主战场对话建模</div>
        </div>
      </div>
      <div className="hidden h-6 w-px bg-[#2a3640] sm:block" />
      <div className="hidden min-w-0 flex-1 items-center gap-5 text-[11px] text-[#9fb0ba] sm:flex">
        <span className="flex items-center gap-2" title={status.blenderError ?? status.bridgeError}>
          <span className={`h-1.5 w-1.5 rounded-full ${dot(status.blender === "connected" ? "ok" : status.blender === "error" ? "error" : "warn")}`} />
          Blender {status.blender === "connected" ? "已连接" : status.blender === "error" ? "未连接" : "等待连接"}
        </span>
        <span className="flex items-center gap-2">
          <span className={`h-1.5 w-1.5 rounded-full ${dot(status.deepseek ? "ok" : "warn")}`} />
          DeepSeek {status.deepseek ? status.model : "未配置 Key"}
        </span>
        {status.busy ? <span className="text-[#d7a64a]">Agent 正在建模…</span> : null}
      </div>
      <div className="ml-auto flex items-center gap-2">
        <div className="flex rounded border border-[#2a3640] p-0.5 text-[10.5px]">
          <span className="rounded bg-[#1a2530] px-2 py-1 text-[#edf3f5]">Studio 建模</span>
          <button type="button" onClick={onSwitchWorkbench} className="flex items-center gap-1 rounded px-2 py-1 text-[#82939e] hover:text-white">
            <ShieldCheck className="h-3 w-3" />
            可信编辑
          </button>
        </div>
        <button
          type="button"
          onClick={onReset}
          disabled={status.busy}
          className="h-8 rounded border border-[#34434e] px-2.5 text-[11px] text-[#c3d0d6] hover:border-[#4fc3b1]/50 disabled:cursor-not-allowed disabled:opacity-40"
        >
          新对话
        </button>
      </div>
    </header>
  );
}

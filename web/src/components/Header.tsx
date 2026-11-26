import { Plus, ShieldCheck } from "lucide-react";
import type { WorkStatus } from "../../shared/types";

function StateDot({ state }: { state: "ok" | "warn" | "error" }) {
  const color = state === "ok" ? "bg-[#4fc3b1]" : state === "warn" ? "bg-[#d7a64a]" : "bg-[#e1746b]";
  return <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${color}`} />;
}

export function Header({ status, connected, onReset }: { status: WorkStatus; connected: boolean; onReset: () => void }) {
  const blenderState = status.blender === "connected" ? "ok" : status.blender === "error" ? "error" : "warn";
  return (
    <header className="flex h-14 shrink-0 items-center gap-4 border-b border-[#2a3640] bg-[#10151b] px-4">
      <div className="flex items-center gap-3">
        <span className="flex h-8 w-8 items-center justify-center rounded border border-[#4fc3b1]/40 bg-[#4fc3b1]/10 text-[#4fc3b1]">
          <ShieldCheck className="h-4.5 w-4.5" />
        </span>
        <div>
          <div className="text-[14px] font-semibold tracking-[0.08em] text-[#edf3f5]">模鉴</div>
          <div className="text-[10px] tracking-[0.12em] text-[#82939e]">BlendGuard</div>
        </div>
      </div>
      <div className="hidden h-6 w-px bg-[#2a3640] sm:block" />
      <div className="hidden min-w-0 flex-1 items-center gap-5 text-[11px] text-[#9fb0ba] sm:flex">
        <span className="flex items-center gap-2" title={status.blenderError}>
          <StateDot state={blenderState} />
          Blender {status.blender === "connected" ? "可用" : status.blender === "error" ? "不可用" : "自动发现"}
        </span>
        <span className="flex min-w-0 items-center gap-2">
          <StateDot state={status.planner.isLlm ? "warn" : "ok"} />
          <span className="truncate">{status.planner.label}</span>
          {status.planner.model ? <span className="shrink-0 text-[#82939e]">{status.planner.model}</span> : null}
        </span>
      </div>
      <div className="ml-auto flex items-center gap-3">
        <span className="flex items-center gap-2 text-[10.5px] text-[#82939e]" title={connected ? "本地事件流已连接" : "正在重新连接本地事件流"}>
          <StateDot state={connected ? "ok" : "error"} />
          <span className="hidden md:inline">{connected ? "本地服务已连接" : "正在重连"}</span>
        </span>
        <button
          type="button"
          onClick={onReset}
          disabled={status.busy}
          className="flex h-8 items-center gap-1.5 rounded border border-[#34434e] px-2.5 text-[11.5px] text-[#c3d0d6] transition hover:border-[#4fc3b1]/50 hover:text-[#edf3f5] disabled:cursor-not-allowed disabled:opacity-40"
        >
          <Plus className="h-3.5 w-3.5" />
          新编辑
        </button>
      </div>
    </header>
  );
}

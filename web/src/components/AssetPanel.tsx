import { Box, CheckCircle2, Clock3, FileBox, History, ShieldX } from "lucide-react";
import type { AssetInfo, RunSummary } from "../../shared/types";

function formatSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatTime(value: number): string {
  return new Date(value).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

export function AssetPanel({
  assets,
  runs,
  selectedAsset,
  activeRun,
  busy,
  onSelectAsset,
  onSelectRun,
}: {
  assets: AssetInfo[];
  runs: RunSummary[];
  selectedAsset: string | null;
  activeRun: string | null;
  busy: boolean;
  onSelectAsset: (assetId: string) => void;
  onSelectRun: (runId: string) => void;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col bg-[#131a21]">
      <div className="border-b border-[#2a3640] px-4 py-3">
        <div className="flex items-center gap-2 text-[12px] font-medium text-[#c7d3d9]">
          <FileBox className="h-4 w-4 text-[#82939e]" />
          源资产
        </div>
        <p className="mt-1 text-[10.5px] leading-relaxed text-[#71838e]">只允许项目资产目录中的现有工程</p>
      </div>
      <div className="p-2">
        {assets.map((asset) => {
          const active = selectedAsset === asset.id;
          return (
            <button
              type="button"
              key={asset.id}
              disabled={busy}
              onClick={() => onSelectAsset(asset.id)}
              className={`flex w-full items-center gap-2.5 border-l-2 px-2.5 py-2.5 text-left transition disabled:cursor-not-allowed ${
                active ? "border-[#4fc3b1] bg-[#4fc3b1]/[0.07]" : "border-transparent hover:bg-white/[0.025]"
              }`}
            >
              <Box className={`h-4 w-4 shrink-0 ${active ? "text-[#4fc3b1]" : "text-[#71838e]"}`} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[12px] text-[#d8e1e5]">{asset.name}</span>
                <span className="mt-0.5 block text-[10px] text-[#71838e]">{formatSize(asset.size)} · 只读源文件</span>
              </span>
            </button>
          );
        })}
        {assets.length === 0 ? <p className="px-3 py-6 text-center text-[11px] text-[#71838e]">未发现可用的 .blend 源资产</p> : null}
      </div>

      <div className="mt-2 flex items-center justify-between border-y border-[#2a3640] px-4 py-3">
        <span className="flex items-center gap-2 text-[12px] font-medium text-[#c7d3d9]">
          <History className="h-4 w-4 text-[#82939e]" />
          运行记录
        </span>
        <span className="mono text-[10px] text-[#71838e]">{runs.length}</span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {runs.map((run) => {
          const active = activeRun === run.runId;
          return (
            <button
              type="button"
              key={run.runId}
              disabled={busy}
              onClick={() => onSelectRun(run.runId)}
              className={`mb-1 w-full border-l-2 px-2.5 py-2.5 text-left transition disabled:cursor-not-allowed ${
                active ? "border-[#4fc3b1] bg-[#4fc3b1]/[0.07]" : "border-transparent hover:bg-white/[0.025]"
              }`}
            >
              <span className="flex items-center gap-2">
                {run.verified ? <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-[#4fc3b1]" /> : <ShieldX className="h-3.5 w-3.5 shrink-0 text-[#d7a64a]" />}
                <span className={`mono text-[10px] ${run.verified ? "text-[#4fc3b1]" : "text-[#d7a64a]"}`}>{run.status}</span>
                <span className="ml-auto text-[9.5px] text-[#637681]">{formatTime(run.createdAt)}</span>
              </span>
              <span className="mt-1.5 line-clamp-2 block text-[11px] leading-relaxed text-[#aebdc5]">{run.instruction || run.runId}</span>
            </button>
          );
        })}
        {runs.length === 0 ? (
          <div className="px-4 py-8 text-center">
            <Clock3 className="mx-auto h-5 w-5 text-[#41535f]" />
            <p className="mt-2 text-[11px] text-[#71838e]">完成一次运行后，可在这里重新打开证据。</p>
          </div>
        ) : null}
      </div>
      <div className="border-t border-[#2a3640] px-4 py-3 text-[10px] leading-relaxed text-[#637681]">
        网页不能删除源文件，也不能把任意路径交给 Blender。
      </div>
    </div>
  );
}

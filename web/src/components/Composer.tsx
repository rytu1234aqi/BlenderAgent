import { CornerDownLeft, FileCheck2 } from "lucide-react";
import { useState } from "react";
import type { AssetInfo, PlannerInfo } from "../../shared/types";

const examples = [
  "将 server_03 下移 1U",
  "把 server_02 宽度改为 0.5 米",
  "给 server_03 添加 2 毫米倒角",
  "复制 server_02 命名为 server_05，放到 [0.8, 0, 1.2]",
];

export function Composer({
  assets,
  selectedAsset,
  planner,
  busy,
  onSelectAsset,
  onSubmit,
}: {
  assets: AssetInfo[];
  selectedAsset: string | null;
  planner: PlannerInfo;
  busy: boolean;
  onSelectAsset: (assetId: string) => void;
  onSubmit: (assetId: string, instruction: string) => Promise<void>;
}) {
  const [instruction, setInstruction] = useState(examples[0]);
  const [submitting, setSubmitting] = useState(false);
  const working = busy || submitting;

  const submit = async () => {
    if (!selectedAsset || !instruction.trim() || working) return;
    setSubmitting(true);
    try {
      await onSubmit(selectedAsset, instruction);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="shrink-0 border-t border-[#2a3640] bg-[#131a21] p-3">
      <div className="mb-2 flex flex-wrap gap-1.5">
        {examples.map((example, index) => (
          <button
            key={example}
            type="button"
            disabled={working}
            onClick={() => setInstruction(example)}
            className="rounded border border-[#2a3640] px-2 py-1 text-[9.5px] text-[#71838e] hover:border-[#41535f] hover:text-[#aebdc5] disabled:opacity-40"
          >
            {["下移 1U", "调整宽度", "添加倒角", "复制装配"][index]}
          </button>
        ))}
      </div>
      <div className="rounded border border-[#34434e] bg-[#0d1217] focus-within:border-[#4fc3b1]/60">
        <textarea
          aria-label="局部编辑指令"
          value={instruction}
          disabled={working}
          maxLength={1000}
          rows={2}
          onChange={(event) => setInstruction(event.target.value)}
          onKeyDown={(event) => {
            if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
              event.preventDefault();
              void submit();
            }
          }}
          placeholder="描述一次已有资产的局部编辑，例如：将 server_03 下移 1U"
          className="block w-full resize-none bg-transparent px-3 py-2.5 text-[12px] leading-relaxed text-[#d8e1e5] outline-none placeholder:text-[#536570] disabled:opacity-50"
        />
        <div className="flex items-center gap-2 border-t border-[#202b34] px-2 py-2">
          <select
            aria-label="选择源资产"
            value={selectedAsset ?? ""}
            disabled={working}
            onChange={(event) => onSelectAsset(event.target.value)}
            className="h-8 min-w-0 max-w-[42%] rounded border border-[#2a3640] bg-[#131a21] px-2 text-[10.5px] text-[#9fb0ba] outline-none"
          >
            <option value="" disabled>选择源资产</option>
            {assets.map((asset) => <option key={asset.id} value={asset.id}>{asset.name}</option>)}
          </select>
          <span className="hidden min-w-0 flex-1 truncate text-right text-[9px] text-[#637681] sm:block">
            {planner.label}
          </span>
          <button
            type="button"
            disabled={working || !selectedAsset || !instruction.trim()}
            onClick={() => void submit()}
            className="ml-auto flex h-8 shrink-0 items-center gap-1.5 rounded bg-[#d8e1e5] px-3 text-[11px] font-medium text-[#172027] hover:bg-white disabled:cursor-not-allowed disabled:bg-[#2a3640] disabled:text-[#71838e]"
          >
            <FileCheck2 className="h-3.5 w-3.5" />生成编辑计划
            <CornerDownLeft className="h-3 w-3 opacity-50" />
          </button>
        </div>
      </div>
      <p className="mt-2 text-center text-[9.5px] text-[#637681]">只生成计划，不会自动执行 · Ctrl + Enter</p>
    </div>
  );
}

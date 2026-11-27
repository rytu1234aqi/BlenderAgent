import { useCallback, useEffect, useState } from "react";
import { AlertCircle, X } from "lucide-react";
import { useWorkbench } from "./hooks/useWorkbench";
import { ResizableLayout } from "./components/ResizableLayout";
import { Header } from "./components/Header";
import { AssetPanel } from "./components/AssetPanel";
import { Viewport } from "./components/Viewport";
import { TrustRail } from "./components/TrustRail";
import { Composer } from "./components/Composer";
import { WorkflowPanel, type WorkflowTab } from "./components/WorkflowPanel";
import type { PlanResolution } from "../shared/types";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "本地服务请求失败，请检查运行事件。";
}

/** 可信局部编辑模式（原有 BlendGuard Workbench 工作台）。 */
export function WorkbenchApp({ onSwitchStudio }: { onSwitchStudio: () => void }) {
  const { snapshot, connected, plan, resolve, execute, openRun, reset } = useWorkbench();
  const [selectedAsset, setSelectedAsset] = useState<string | null>(null);
  const [mode, setMode] = useState<"source" | "verified">("source");
  const [tab, setTab] = useState<WorkflowTab>("plan");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (snapshot.status.assetId && snapshot.assets.some((asset) => asset.id === snapshot.status.assetId)) {
      setSelectedAsset(snapshot.status.assetId);
      return;
    }
    if (!selectedAsset || !snapshot.assets.some((asset) => asset.id === selectedAsset)) {
      setSelectedAsset(snapshot.assets[0]?.id ?? null);
    }
  }, [snapshot.assets, snapshot.status.assetId, selectedAsset]);

  useEffect(() => {
    if (snapshot.scene) setMode("verified");
    else if (["PLANNING", "EXECUTING", "FAILED"].includes(snapshot.status.phase)) setMode("source");
  }, [snapshot.scene, snapshot.status.phase]);

  const selectAsset = async (assetId: string) => {
    if (assetId === selectedAsset || snapshot.status.busy) return;
    setError(null);
    setSelectedAsset(assetId);
    setMode("source");
    setTab("plan");
    if (snapshot.plan || snapshot.currentRun || snapshot.entries.length) {
      try { await reset(); } catch (cause) { setError(errorMessage(cause)); }
    }
  };

  const submitPlan = async (assetId: string, instruction: string) => {
    setError(null);
    setMode("source");
    setTab("plan");
    try { await plan(assetId, instruction); } catch (cause) { setError(errorMessage(cause)); }
  };

  const resolveCurrent = async (resolution: PlanResolution) => {
    if (!snapshot.plan) return;
    setError(null);
    setTab("plan");
    try { await resolve(snapshot.plan, resolution); } catch (cause) { setError(errorMessage(cause)); }
  };

  const executeCurrent = async () => {
    if (!snapshot.plan) return;
    setError(null);
    try {
      const run = await execute(snapshot.plan);
      if (run.verified) {
        setMode("verified");
        setTab("evidence");
      }
    } catch (cause) {
      setError(errorMessage(cause));
      setTab("events");
    }
  };

  const selectRun = async (runId: string) => {
    setError(null);
    try {
      const run = await openRun(runId);
      setSelectedAsset(run.assetId);
      setMode(run.verified ? "verified" : "source");
      setTab("evidence");
    } catch (cause) { setError(errorMessage(cause)); }
  };

  const resetCurrent = useCallback(async () => {
    setError(null);
    setMode("source");
    setTab("plan");
    try { await reset(); } catch (cause) { setError(errorMessage(cause)); }
  }, [reset]);

  const asset = snapshot.assets.find((item) => item.id === selectedAsset) ?? null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <Header status={snapshot.status} connected={connected} onReset={() => void resetCurrent()} onSwitchStudio={onSwitchStudio} />
      {error ? (
        <div role="alert" className="absolute left-1/2 top-16 z-50 flex w-[min(680px,calc(100%-32px))] -translate-x-1/2 items-start gap-2 rounded border border-[#e1746b]/40 bg-[#2b1d20] px-3 py-2.5 shadow-2xl">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-[#e1746b]" />
          <p className="flex-1 text-[11.5px] leading-relaxed text-[#efb1aa]">{error}</p>
          <button type="button" aria-label="关闭错误提示" onClick={() => setError(null)} className="text-[#c98680] hover:text-white"><X className="h-4 w-4" /></button>
        </div>
      ) : null}
      <div className="min-h-0 flex-1">
        <ResizableLayout
          left={
            <AssetPanel
              assets={snapshot.assets}
              runs={snapshot.runs}
              selectedAsset={selectedAsset}
              activeRun={snapshot.currentRun?.runId ?? null}
              busy={snapshot.status.busy}
              onSelectAsset={(assetId) => void selectAsset(assetId)}
              onSelectRun={(runId) => void selectRun(runId)}
            />
          }
          center={
            <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col">
              <Viewport asset={asset} scene={snapshot.scene} mode={mode} onModeChange={setMode} />
              <TrustRail phase={snapshot.status.phase} />
              <Composer
                assets={snapshot.assets}
                selectedAsset={selectedAsset}
                planner={snapshot.status.planner}
                busy={snapshot.status.busy}
                onSelectAsset={(assetId) => void selectAsset(assetId)}
                onSubmit={submitPlan}
              />
            </div>
          }
          right={
            <WorkflowPanel
              tab={tab}
              onTabChange={setTab}
              phase={snapshot.status.phase}
              plan={snapshot.plan}
              run={snapshot.currentRun}
              entries={snapshot.entries}
              busy={snapshot.status.busy}
              onResolve={resolveCurrent}
              onExecute={executeCurrent}
            />
          }
        />
      </div>
    </div>
  );
}

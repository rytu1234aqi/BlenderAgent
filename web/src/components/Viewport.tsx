import { useEffect, useRef, useState } from "react";
import { Box, Grid3x3, Image, Loader2, Maximize2, ShieldCheck } from "lucide-react";
import type { AssetInfo, PreviewView, SceneInfo } from "../../shared/types";
import { SceneViewer, type SceneStats } from "../viewer/SceneViewer";

const viewNames = { overview: "总览", front: "正面", right: "右侧", cable: "线缆" } as const;
const views = Object.keys(viewNames) as PreviewView[];

export function Viewport({
  asset,
  scene,
  mode,
  onModeChange,
}: {
  asset: AssetInfo | null;
  scene: SceneInfo | null;
  mode: "source" | "verified";
  onModeChange: (mode: "source" | "verified") => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<SceneViewer | null>(null);
  const [stats, setStats] = useState<SceneStats | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [wireframe, setWireframe] = useState(false);
  const [previewView, setPreviewView] = useState<PreviewView>("overview");
  const interactive = mode === "verified" && Boolean(scene);

  useEffect(() => {
    if (!interactive || !containerRef.current) return;
    const viewer = new SceneViewer(containerRef.current);
    viewer.onStats = setStats;
    viewer.onLoading = setLoading;
    viewer.onError = setError;
    viewerRef.current = viewer;
    return () => {
      viewerRef.current = null;
      viewer.dispose();
      setStats(null);
    };
  }, [interactive]);

  const url = scene?.url;
  useEffect(() => {
    if (!interactive || !url) return;
    setError(null);
    void viewerRef.current?.load(url);
  }, [interactive, url]);

  const activeView = asset?.previews[previewView] ? previewView : views.find((view) => asset?.previews[view]);
  const previewUrl = activeView && asset?.previews[activeView];
  return (
    <section className="relative flex min-h-0 flex-1 flex-col bg-[#10151b]">
      <div className="flex h-11 shrink-0 items-center border-b border-[#2a3640] px-3">
        <div className="flex rounded border border-[#2a3640] bg-[#0d1217] p-0.5">
          <button
            type="button"
            onClick={() => onModeChange("source")}
            className={`flex h-7 items-center gap-1.5 rounded-sm px-2.5 text-[11px] ${mode === "source" ? "bg-[#25323c] text-[#d8e1e5]" : "text-[#71838e] hover:text-[#aebdc5]"}`}
          >
            <Image className="h-3.5 w-3.5" />源资产
          </button>
          <button
            type="button"
            disabled={!scene}
            onClick={() => onModeChange("verified")}
            className={`flex h-7 items-center gap-1.5 rounded-sm px-2.5 text-[11px] disabled:cursor-not-allowed disabled:opacity-40 ${mode === "verified" ? "bg-[#25323c] text-[#d8e1e5]" : "text-[#71838e] hover:text-[#aebdc5]"}`}
          >
            <ShieldCheck className="h-3.5 w-3.5" />已验证 3D
          </button>
        </div>
        <div className="ml-3 min-w-0 truncate text-[10.5px] text-[#71838e]">
          {mode === "verified" && scene ? `运行 ${scene.runId}` : asset?.name ?? "未选择源资产"}
        </div>
        {interactive ? (
          <div className="ml-auto flex items-center gap-1">
            <button
              type="button"
              title={wireframe ? "关闭线框" : "线框显示"}
              onClick={() => {
                setWireframe((value) => {
                  viewerRef.current?.setWireframe(!value);
                  return !value;
                });
              }}
              className={`flex h-7 w-7 items-center justify-center rounded border ${wireframe ? "border-[#4fc3b1]/40 text-[#4fc3b1]" : "border-[#2a3640] text-[#82939e] hover:text-[#d8e1e5]"}`}
            >
              <Grid3x3 className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              title="适配可编辑资产"
              onClick={() => viewerRef.current?.frameAll()}
              className="flex h-7 w-7 items-center justify-center rounded border border-[#2a3640] text-[#82939e] hover:text-[#d8e1e5]"
            >
              <Maximize2 className="h-3.5 w-3.5" />
            </button>
          </div>
        ) : null}
      </div>

      <div className="relative min-h-0 flex-1 overflow-hidden">
        {interactive ? <div ref={containerRef} className="absolute inset-0" /> : null}
        {mode === "source" ? (
          <div className="absolute inset-0 flex flex-col bg-[#0d1217]">
            <div className="flex h-10 shrink-0 items-center gap-1 border-b border-[#202b34] px-3">
              {views.map((view) => (
                <button
                  type="button"
                  key={view}
                  disabled={!asset?.previews[view]}
                  onClick={() => setPreviewView(view)}
                  className={`rounded px-2.5 py-1 text-[10.5px] disabled:opacity-30 ${activeView === view ? "bg-[#25323c] text-[#c7d3d9]" : "text-[#71838e] hover:text-[#aebdc5]"}`}
                >
                  {viewNames[view]}
                </button>
              ))}
              <span className="ml-auto text-[9.5px] text-[#637681]">固定渲染 · 不是复验结论</span>
            </div>
            {activeView && previewUrl ? (
              <div className="flex min-h-0 flex-1 items-center justify-center overflow-hidden p-4">
                <img key={previewUrl} src={previewUrl} alt={`${asset?.name ?? "源资产"}${viewNames[activeView]}固定预览`} className="max-h-full max-w-full object-contain shadow-2xl" />
              </div>
            ) : (
              <div className="flex flex-1 flex-col items-center justify-center text-center">
                <Box className="h-8 w-8 text-[#41535f]" />
                <p className="mt-3 text-[12px] text-[#82939e]">该源资产没有固定预览</p>
                <p className="mt-1 text-[10.5px] text-[#637681]">仍可通过 BlendGuard 生成受控编辑计划。</p>
              </div>
            )}
          </div>
        ) : null}

        {interactive && stats ? (
          <div className="pointer-events-none absolute left-3 top-3 flex items-center gap-2 text-[10px] text-[#82939e]">
            <span className="rounded border border-[#4fc3b1]/25 bg-[#10151b]/85 px-2 py-1 text-[#4fc3b1]">VERIFIED</span>
            <span className="rounded border border-[#2a3640] bg-[#10151b]/85 px-2 py-1">网格 {stats.meshes} · 三角面 {stats.triangles.toLocaleString("zh-CN")}</span>
          </div>
        ) : null}
        {loading ? (
          <div className="absolute left-1/2 top-4 flex -translate-x-1/2 items-center gap-2 rounded border border-[#2a3640] bg-[#10151b]/90 px-3 py-1.5 text-[11px] text-[#aebdc5]">
            <Loader2 className="h-3.5 w-3.5 animate-spin text-[#4fc3b1]" />正在加载已验证 GLB
          </div>
        ) : null}
        {error ? <div className="absolute bottom-10 left-1/2 -translate-x-1/2 rounded border border-[#e1746b]/30 bg-[#301d20] px-3 py-2 text-[11px] text-[#e1746b]">预览加载失败：{error}</div> : null}
        {interactive ? <div className="pointer-events-none absolute bottom-3 left-3 text-[10px] text-[#637681]">左键旋转 · 右键平移 · 滚轮缩放</div> : null}
      </div>
    </section>
  );
}

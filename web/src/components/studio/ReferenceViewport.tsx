import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { Crosshair, Eye, MousePointerClick, RotateCcw } from "lucide-react";
import type { ChatScene } from "../../../shared/types";
import { SceneViewer, type PickInfo, type SceneStats } from "../../viewer/SceneViewer";

interface Delta {
  position: [number, number, number];
  rotation: [number, number, number];
  scale: [number, number, number];
}

const ZERO: Delta = { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] };

function numberValue(value: string): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * 中间视口：显示 Blender 导出的 GLB 参考镜像。
 * 用户在镜像上只能做"注释级"平移/旋转/缩放，改动本身不回写 Blender，
 * 点「记入建议」后变成一句建模意见送进右侧对话，由 Blender 侧真正执行。
 */
export function ReferenceViewport({
  scene,
  onAnnotate,
}: {
  scene: ChatScene | null;
  onAnnotate: (note: string) => void;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewerRef = useRef<SceneViewer | null>(null);
  const [stats, setStats] = useState<SceneStats | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<PickInfo | null>(null);
  const [delta, setDelta] = useState<Delta>(ZERO);
  const [localNote, setLocalNote] = useState<string | null>(null);

  useEffect(() => {
    if (!hostRef.current) return;
    const viewer = new SceneViewer(hostRef.current);
    viewerRef.current = viewer;
    viewer.onStats = (next) => setStats(next);
    viewer.onLoading = (next) => setLoading(next);
    viewer.onError = (message) => setError(message);
    viewer.onPick = (info) => {
      setSelected(info);
      setDelta(ZERO);
      viewer.setSelection(info?.object ?? null);
    };
    viewer.setPicking(true);
    return () => {
      viewer.dispose();
      viewerRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!scene) return;
    setError(null);
    void viewerRef.current?.load(scene.url);
  }, [scene]);

  const applyLocal = () => {
    if (!selected) return;
    const [px, py, pz] = delta.position;
    const [rx, ry, rz] = delta.rotation;
    const [sx, sy, sz] = delta.scale;
    selected.object.position.add(new THREE.Vector3(px, py, pz));
    selected.object.rotation.set(
      selected.object.rotation.x + THREE.MathUtils.degToRad(rx),
      selected.object.rotation.y + THREE.MathUtils.degToRad(ry),
      selected.object.rotation.z + THREE.MathUtils.degToRad(rz),
    );
    selected.object.scale.multiply(new THREE.Vector3(sx, sy, sz));
    viewerRef.current?.setSelection(selected.object);
    setLocalNote(`已在参考镜像上临时调整「${selected.name}」：位置 Δ(${px.toFixed(2)}, ${py.toFixed(2)}, ${pz.toFixed(2)}) m，旋转 Δ(${rx.toFixed(0)}, ${ry.toFixed(0)}, ${rz.toFixed(0)})°，缩放 ×(${sx.toFixed(2)}, ${sy.toFixed(2)}, ${sz.toFixed(2)})。注意：这只是参考预览，未写入 Blender。`);
    setDelta(ZERO);
  };

  const annotate = () => {
    if (!selected) return;
    const parts: string[] = [];
    const [px, py, pz] = delta.position;
    const [rx, ry, rz] = delta.rotation;
    const [sx, sy, sz] = delta.scale;
    if (px || py || pz) parts.push(`位置平移 (${px.toFixed(2)}, ${py.toFixed(2)}, ${pz.toFixed(2)}) 米`);
    if (rx || ry || rz) parts.push(`绕 X/Y/Z 旋转 (${rx.toFixed(0)}, ${ry.toFixed(0)}, ${rz.toFixed(0)}) 度`);
    if (sx !== 1 || sy !== 1 || sz !== 1) parts.push(`缩放 ×(${sx.toFixed(2)}, ${sy.toFixed(2)}, ${sz.toFixed(2)})`);
    const text = parts.length
      ? `参考意见：在 Blender 中把「${selected.name}」${parts.join("，")}。`
      : `参考意见：参考镜像里我看不到「${selected.name}」需要调整，请保持现状。`;
    onAnnotate(text);
    setLocalNote(null);
  };

  return (
    <div className="relative flex h-full min-h-0 w-full flex-col bg-[#0c1116]">
      <div ref={hostRef} className="relative min-h-0 flex-1" />
      {!scene ? (
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2 text-center">
          <Eye className="h-6 w-6 text-[#41525e]" />
          <p className="text-[12px] text-[#82939e]">参考镜像待生成</p>
          <p className="max-w-[320px] text-[11px] leading-relaxed text-[#5f707b]">
            连接 Blender 后，每次建模都会自动导出 GLB 参考到这里；它只用于查看与注释，不参与验证。
          </p>
        </div>
      ) : null}
      {loading ? (
        <div className="pointer-events-none absolute left-1/2 top-3 -translate-x-1/2 rounded bg-[#10151b]/90 px-2 py-1 text-[10.5px] text-[#9fb0ba]">
          正在加载参考镜像…
        </div>
      ) : null}
      {error ? (
        <div className="absolute left-3 top-3 rounded border border-[#e1746b]/40 bg-[#2b1d20] px-2.5 py-1.5 text-[10.5px] text-[#efb1aa]">
          {error}
        </div>
      ) : null}

      <div className="flex shrink-0 items-center gap-3 border-t border-[#1f2a33] bg-[#0e141a] px-3 py-1.5 text-[10.5px] text-[#82939e]">
        <span className="flex items-center gap-1.5">
          <MousePointerClick className="h-3 w-3" />
          点击选择部件
        </span>
        {stats ? (
          <span className="text-[#5f707b]">
            {stats.meshes} 网格 · {stats.vertices.toLocaleString()} 顶点 · {stats.triangles.toLocaleString()} 三角面
          </span>
        ) : null}
        <span className="ml-auto flex items-center gap-1.5">
          <Crosshair className="h-3 w-3" />
          {selected ? selected.name : "未选中"}
        </span>
      </div>

      {selected ? (
        <div className="absolute bottom-14 left-3 z-10 w-[330px] rounded border border-[#2a3640] bg-[#10151b]/95 p-3 shadow-2xl backdrop-blur">
          <div className="mb-2 flex items-center justify-between">
            <span className="truncate text-[11.5px] font-medium text-[#edf3f5]">{selected.name}</span>
            <button
              type="button"
              aria-label="清除选择"
              className="text-[10px] text-[#82939e] hover:text-white"
              onClick={() => {
                viewerRef.current?.setSelection(null);
                setSelected(null);
                setLocalNote(null);
              }}
            >
              清除
            </button>
          </div>
          <div className="grid grid-cols-3 gap-1.5 text-[10px]">
            {(["position", "rotation", "scale"] as const).map((key) => (
              <div key={key} className="col-span-3 flex items-center gap-1.5">
                <span className="w-12 shrink-0 text-[#82939e]">{key === "position" ? "位置 Δ" : key === "rotation" ? "旋转 Δ°" : "缩放 ×"}</span>
                {([0, 1, 2] as const).map((axis) => (
                  <input
                    key={axis}
                    type="number"
                    step={key === "scale" ? 0.05 : key === "rotation" ? 5 : 0.05}
                    value={delta[key][axis]}
                    onChange={(event) => {
                      const next = [...delta[key]] as [number, number, number];
                      next[axis] = numberValue(event.target.value);
                      setDelta({ ...delta, [key]: next });
                    }}
                    className="w-full rounded border border-[#2a3640] bg-[#0c1116] px-1.5 py-1 text-[10px] text-[#edf3f5] outline-none focus:border-[#4fc3b1]/60"
                    aria-label={`${key} ${axis}`}
                  />
                ))}
              </div>
            ))}
          </div>
          <div className="mt-2.5 flex gap-2">
            <button
              type="button"
              onClick={applyLocal}
              className="flex h-7 flex-1 items-center justify-center gap-1.5 rounded border border-[#34434e] text-[10.5px] text-[#c3d0d6] hover:border-[#4fc3b1]/50"
            >
              <RotateCcw className="h-3 w-3" />
              应用（仅参考）
            </button>
            <button
              type="button"
              onClick={annotate}
              className="flex h-7 flex-1 items-center justify-center rounded bg-[#4fc3b1] text-[10.5px] font-medium text-[#0c1116] hover:bg-[#6fd6c5]"
            >
              记入建议
            </button>
          </div>
          {localNote ? <p className="mt-2 text-[10px] leading-relaxed text-[#d7a64a]">{localNote}</p> : null}
          <p className="mt-2 text-[9.5px] leading-relaxed text-[#5f707b]">
            参考镜像上的改动不会写入 Blender。真正执行由右侧对话驱动，每次执行都有审计点与采纳/回退。
          </p>
        </div>
      ) : null}
    </div>
  );
}

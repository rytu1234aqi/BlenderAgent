import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";

const LEFT_KEY = "blendguard.leftWidth";
const RIGHT_KEY = "blendguard.rightWidth";
const CENTER_MIN = 420;

function readWidth(key: string, fallback: number): number {
  const raw = Number(localStorage.getItem(key));
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

export function ResizableLayout({ left, center, right }: { left: ReactNode; center: ReactNode; right: ReactNode }) {
  const [leftWidth, setLeftWidth] = useState(() => readWidth(LEFT_KEY, 246));
  const [rightWidth, setRightWidth] = useState(() => readWidth(RIGHT_KEY, 430));
  const [compact, setCompact] = useState(() => window.matchMedia("(max-width: 1023px)").matches);
  const drag = useRef<{ side: "left" | "right"; startX: number; startWidth: number } | null>(null);

  useEffect(() => {
    const query = window.matchMedia("(max-width: 1023px)");
    const update = () => setCompact(query.matches);
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  useEffect(() => localStorage.setItem(LEFT_KEY, String(leftWidth)), [leftWidth]);
  useEffect(() => localStorage.setItem(RIGHT_KEY, String(rightWidth)), [rightWidth]);

  const startDrag = (side: "left" | "right") => (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { side, startX: event.clientX, startWidth: side === "left" ? leftWidth : rightWidth };
  };
  const onMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const state = drag.current;
    if (!state) return;
    const delta = event.clientX - state.startX;
    if (state.side === "left") {
      setLeftWidth(clamp(state.startWidth + delta, 210, Math.min(500, window.innerWidth - rightWidth - CENTER_MIN)));
    } else {
      setRightWidth(clamp(state.startWidth - delta, 360, Math.min(680, window.innerWidth - leftWidth - CENTER_MIN)));
    }
  };
  const onKeyDown = (side: "left" | "right") => (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowLeft", "ArrowRight"].includes(event.key)) return;
    event.preventDefault();
    const direction = event.key === "ArrowRight" ? 16 : -16;
    if (side === "left") setLeftWidth((width) => clamp(width + direction, 210, 500));
    else setRightWidth((width) => clamp(width - direction, 360, 680));
  };

  if (compact) {
    return (
      <div className="flex h-full min-h-0 flex-col overflow-y-auto">
        <aside className="h-[310px] shrink-0 border-b border-[#2a3640]">{left}</aside>
        <main className="h-[540px] shrink-0 border-b border-[#2a3640]">{center}</main>
        <aside className="h-[720px] shrink-0">{right}</aside>
      </div>
    );
  }

  const handleClass = "group relative w-[5px] shrink-0 cursor-col-resize hover:bg-[#4fc3b1]/10 focus-visible:bg-[#4fc3b1]/10";
  return (
    <div className="flex h-full min-h-0 w-full overflow-hidden">
      <aside className="flex min-h-0 min-w-0 shrink-0 flex-col" style={{ width: leftWidth }}>{left}</aside>
      <div
        role="separator"
        aria-label="调整源资产栏宽度"
        aria-orientation="vertical"
        tabIndex={0}
        className={handleClass}
        onPointerDown={startDrag("left")}
        onPointerMove={onMove}
        onPointerUp={() => { drag.current = null; }}
        onPointerCancel={() => { drag.current = null; }}
        onKeyDown={onKeyDown("left")}
      >
        <span className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-[#2a3640]" />
      </div>
      <main className="flex min-h-0 min-w-0 flex-1">{center}</main>
      <div
        role="separator"
        aria-label="调整计划审阅栏宽度"
        aria-orientation="vertical"
        tabIndex={0}
        className={handleClass}
        onPointerDown={startDrag("right")}
        onPointerMove={onMove}
        onPointerUp={() => { drag.current = null; }}
        onPointerCancel={() => { drag.current = null; }}
        onKeyDown={onKeyDown("right")}
      >
        <span className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-[#2a3640]" />
      </div>
      <aside className="flex min-h-0 min-w-0 shrink-0 flex-col" style={{ width: rightWidth }}>{right}</aside>
    </div>
  );
}

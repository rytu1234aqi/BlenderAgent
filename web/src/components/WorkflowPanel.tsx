import { useEffect, useRef } from "react";
import { Activity, FileCheck2, ScrollText, ShieldCheck } from "lucide-react";
import type { PlanResolution, PlanReview, RunDetail, TimelineEntry, WorkPhase } from "../../shared/types";
import { PlanReviewPanel } from "./PlanReviewPanel";
import { VerificationPanel } from "./VerificationPanel";
import { TimelineEntryView } from "./TimelineEntryView";

export type WorkflowTab = "plan" | "evidence" | "events";

export function WorkflowPanel({
  tab,
  onTabChange,
  phase,
  plan,
  run,
  entries,
  busy,
  onResolve,
  onExecute,
}: {
  tab: WorkflowTab;
  onTabChange: (tab: WorkflowTab) => void;
  phase: WorkPhase;
  plan: PlanReview | null;
  run: RunDetail | null;
  entries: TimelineEntry[];
  busy: boolean;
  onResolve: (resolution: PlanResolution) => Promise<void>;
  onExecute: () => Promise<void>;
}) {
  const timelineEnd = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (tab === "events") timelineEnd.current?.scrollIntoView({ block: "end" });
  }, [entries.length, tab]);

  const tabs = [
    { id: "plan" as const, label: "计划审阅", icon: FileCheck2, active: Boolean(plan && plan.status !== "READY") },
    { id: "evidence" as const, label: "复验证据", icon: ShieldCheck, active: Boolean(run?.verified) },
    { id: "events" as const, label: "运行事件", icon: ScrollText, active: entries.some((entry) => entry.status === "running") },
  ];

  return (
    <div className="flex h-full min-h-0 flex-col bg-[#131a21]">
      <div className="flex h-11 shrink-0 items-stretch border-b border-[#2a3640] px-2" role="tablist" aria-label="编辑工作流">
        {tabs.map((item) => {
          const Icon = item.icon;
          const selected = tab === item.id;
          return (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={selected}
              onClick={() => onTabChange(item.id)}
              className={`relative flex flex-1 items-center justify-center gap-1.5 text-[10.5px] ${selected ? "text-[#d8e1e5]" : "text-[#71838e] hover:text-[#aebdc5]"}`}
            >
              <Icon className="h-3.5 w-3.5" />{item.label}
              {item.active ? <span className={`h-1.5 w-1.5 rounded-full ${item.id === "evidence" ? "bg-[#4fc3b1]" : "bg-[#d7a64a]"}`} /> : null}
              {selected ? <span className="absolute inset-x-2 bottom-0 h-0.5 bg-[#4fc3b1]" /> : null}
            </button>
          );
        })}
      </div>
      <div className="min-h-0 flex-1" role="tabpanel">
        {tab === "plan" ? <PlanReviewPanel plan={plan} busy={busy} canExecute={phase === "AWAITING_REVIEW"} onResolve={onResolve} onExecute={onExecute} /> : null}
        {tab === "evidence" ? <VerificationPanel run={run} phase={phase} /> : null}
        {tab === "events" ? (
          <div className="flex h-full min-h-0 flex-col">
            <div className="flex items-center gap-2 border-b border-[#202b34] px-4 py-2 text-[9.5px] text-[#637681]">
              <Activity className="h-3 w-3" />只显示适配层与真实 Runner 事件，不展示模型自述为验证结论
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
              {entries.map((entry) => <TimelineEntryView key={entry.id} entry={entry} />)}
              {entries.length === 0 ? <p className="px-4 py-10 text-center text-[11px] text-[#637681]">生成计划后，这里会记录真实流程事件。</p> : null}
              <div ref={timelineEnd} />
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

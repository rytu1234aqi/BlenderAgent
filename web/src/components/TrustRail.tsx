import { Check, FileCheck2, ScanSearch, ShieldCheck } from "lucide-react";
import type { WorkPhase } from "../../shared/types";

const steps = [
  { label: "计划生成", detail: "只读场景与结构化意图", icon: FileCheck2 },
  { label: "契约审阅", detail: "目标、写集与计划哈希", icon: ScanSearch },
  { label: "Runner 提交", detail: "事务与局部性门禁", icon: Check },
  { label: "独立复验", detail: "新进程重新计算", icon: ShieldCheck },
];

function activeStep(phase: WorkPhase): number {
  if (phase === "PLANNING") return 0;
  if (["NEEDS_CONFIRMATION", "RESOLVING", "AWAITING_REVIEW"].includes(phase)) return 1;
  if (["EXECUTING", "COMMITTED"].includes(phase)) return 2;
  if (["VERIFYING", "VERIFIED"].includes(phase)) return 3;
  return -1;
}

export function TrustRail({ phase }: { phase: WorkPhase }) {
  const active = activeStep(phase);
  const failed = phase === "FAILED";
  return (
    <div className="shrink-0 border-t border-[#2a3640] bg-[#131a21] px-3 py-3">
      <div className="grid grid-cols-4 gap-1">
        {steps.map((step, index) => {
          const Icon = step.icon;
          const complete = phase === "VERIFIED" || index < active;
          const current = index === active && phase !== "VERIFIED";
          const verified = phase === "VERIFIED";
          return (
            <div key={step.label} className={`relative min-w-0 px-2 py-1 ${index > 0 ? "border-l border-[#2a3640]" : ""}`}>
              <div className="flex items-center gap-2">
                <span className={`flex h-6 w-6 shrink-0 items-center justify-center rounded border ${
                  verified || complete
                    ? "border-[#4fc3b1]/40 bg-[#4fc3b1]/10 text-[#4fc3b1]"
                    : failed
                      ? "border-[#e1746b]/30 text-[#e1746b]"
                      : current
                        ? "border-[#d7a64a]/50 bg-[#d7a64a]/10 text-[#d7a64a]"
                        : "border-[#34434e] text-[#637681]"
                }`}>
                  <Icon className="h-3.5 w-3.5" />
                </span>
                <div className="min-w-0">
                  <div className={`truncate text-[11px] font-medium ${current ? "text-[#e4bd70]" : verified || complete ? "text-[#8ed8cc]" : "text-[#9fb0ba]"}`}>
                    {step.label}
                  </div>
                  <div className="mt-0.5 hidden truncate text-[9.5px] text-[#637681] xl:block">{step.detail}</div>
                </div>
              </div>
            </div>
          );
        })}
      </div>
      {failed ? <div className="mt-2 px-2 text-[10px] text-[#e1746b]">本次流程未通过；不会显示已验证交付。</div> : null}
    </div>
  );
}

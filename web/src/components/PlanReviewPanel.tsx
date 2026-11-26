import { useEffect, useState } from "react";
import { AlertTriangle, Check, ChevronDown, FileKey2, LockKeyhole, Play, ShieldQuestion } from "lucide-react";
import type { PlanResolution, PlanReview } from "../../shared/types";

const actionLabels: Record<string, string> = {
  move_part: "移动部件",
  rotate_part: "旋转部件",
  create_box: "创建长方体",
  set_dimensions: "设置尺寸",
  duplicate_part: "复制装配",
  add_bevel: "添加倒角",
  assign_material: "分配材质",
  unsupported: "不支持的操作",
};

interface Candidate {
  object_id: string;
  name?: string;
  type?: string;
}

function candidatesOf(plan: PlanReview): Candidate[] {
  const candidates = plan.error?.details?.candidates;
  if (!Array.isArray(candidates)) return [];
  return candidates.filter((item): item is Candidate => typeof item?.object_id === "string");
}

function pretty(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function Section({ title, count, children, defaultOpen = true }: { title: string; count?: number; children: React.ReactNode; defaultOpen?: boolean }) {
  return (
    <details open={defaultOpen} className="border-b border-[#2a3640]">
      <summary className="group flex cursor-pointer items-center gap-2 px-4 py-3 text-[11.5px] font-medium text-[#b8c6cd] hover:text-[#edf3f5]">
        <ChevronDown className="h-3.5 w-3.5 text-[#637681] transition group-open:rotate-180" />
        {title}
        {count !== undefined ? <span className="mono ml-auto text-[10px] font-normal text-[#71838e]">{count}</span> : null}
      </summary>
      <div className="px-4 pb-4">{children}</div>
    </details>
  );
}

export function PlanReviewPanel({
  plan,
  busy,
  canExecute,
  onResolve,
  onExecute,
}: {
  plan: PlanReview | null;
  busy: boolean;
  canExecute: boolean;
  onResolve: (resolution: PlanResolution) => Promise<void>;
  onExecute: () => Promise<void>;
}) {
  const [selectedTarget, setSelectedTarget] = useState("");
  const [approveLowConfidence, setApproveLowConfidence] = useState(false);
  const [reviewedHash, setReviewedHash] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    setSelectedTarget("");
    setApproveLowConfidence(false);
    setReviewedHash(null);
  }, [plan?.planId, plan?.sha256]);

  if (!plan) {
    return (
      <div className="flex h-full flex-col items-center justify-center px-8 text-center">
        <FileKey2 className="h-8 w-8 text-[#41535f]" />
        <p className="mt-4 text-[13px] text-[#9fb0ba]">先生成一份编辑计划</p>
        <p className="mt-2 max-w-[270px] text-[11px] leading-relaxed text-[#637681]">
          此处会显示目标、契约、写集和计划哈希。生成计划不会修改源工程。
        </p>
      </div>
    );
  }

  const proposal = plan.proposal;
  const contract = plan.request?.contract;
  const candidates = candidatesOf(plan);
  const needsTarget = plan.error?.code === "TARGET_AMBIGUOUS";
  const needsConfidence = plan.error?.code === "CONFIRMATION_REQUIRED";
  const working = busy || submitting;

  const resolve = async () => {
    setSubmitting(true);
    try {
      await onResolve({
        confirmTarget: needsTarget ? selectedTarget : undefined,
        approveLowConfidence: needsConfidence ? approveLowConfidence : undefined,
      });
    } finally {
      setSubmitting(false);
    }
  };
  const execute = async () => {
    setSubmitting(true);
    try {
      await onExecute();
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="border-b border-[#2a3640] px-4 py-4">
          <div className="flex items-center gap-2">
            <span className={`mono rounded border px-2 py-1 text-[10px] ${
              plan.status === "READY" ? "border-[#d7a64a]/35 bg-[#d7a64a]/[0.08] text-[#e4bd70]" : "border-[#34434e] text-[#9fb0ba]"
            }`}>
              {plan.status}
            </span>
            <span className="text-[11px] text-[#82939e]">{proposal ? actionLabels[proposal.action] ?? proposal.action : "规划未完成"}</span>
          </div>
          <p className="mt-3 text-[13px] leading-relaxed text-[#e1e8eb]">{plan.instruction}</p>
          <div className="mt-3 grid grid-cols-2 gap-3 text-[10.5px]">
            <div>
              <div className="text-[#637681]">目标查询</div>
              <div className="mono mt-1 break-all text-[#aebdc5]">{proposal?.target_query ?? "—"}</div>
            </div>
            <div>
              <div className="text-[#637681]">规划置信度</div>
              <div className="mono mt-1 text-[#aebdc5]">{proposal ? `${(proposal.confidence * 100).toFixed(0)}%` : "—"}</div>
            </div>
          </div>
          {proposal?.rationale ? <p className="mt-3 text-[10.5px] leading-relaxed text-[#71838e]">{proposal.rationale}</p> : null}
        </div>

        <div className="border-b border-[#2a3640] px-4 py-3">
          <div className="flex items-center gap-2 text-[10.5px] text-[#82939e]">
            <LockKeyhole className="h-3.5 w-3.5" />当前计划 SHA-256
          </div>
          <div className="mono mt-2 break-all text-[10px] leading-relaxed text-[#b8c6cd]">{plan.sha256}</div>
          <div className="mono mt-2 text-[9.5px] text-[#637681]">源文件 {plan.sourceSha256.slice(0, 20)}…</div>
        </div>

        {plan.status === "NEEDS_CONFIRMATION" ? (
          <div className="border-b border-[#d7a64a]/25 bg-[#d7a64a]/[0.045] px-4 py-4">
            <div className="flex items-start gap-2">
              <ShieldQuestion className="mt-0.5 h-4 w-4 shrink-0 text-[#d7a64a]" />
              <div>
                <div className="text-[12px] font-medium text-[#e4bd70]">需要人工确认</div>
                <p className="mt-1 text-[11px] leading-relaxed text-[#b7a57e]">{plan.error?.message}</p>
              </div>
            </div>
            {needsTarget ? (
              <div className="mt-3 space-y-2">
                {candidates.map((candidate) => (
                  <label key={candidate.object_id} className="flex cursor-pointer items-start gap-2 rounded border border-[#4a4638] bg-[#171b1d] p-2.5">
                    <input
                      type="radio"
                      name="target"
                      value={candidate.object_id}
                      checked={selectedTarget === candidate.object_id}
                      onChange={() => setSelectedTarget(candidate.object_id)}
                      className="mt-1 accent-[#d7a64a]"
                    />
                    <span className="min-w-0">
                      <span className="block text-[11.5px] text-[#d8e1e5]">{candidate.name ?? candidate.object_id}</span>
                      <span className="mono mt-0.5 block break-all text-[9.5px] text-[#82939e]">{candidate.object_id}{candidate.type ? ` · ${candidate.type}` : ""}</span>
                    </span>
                  </label>
                ))}
                {candidates.length === 0 ? <p className="text-[10.5px] text-[#e1746b]">计划未提供可确认的候选对象，请修改指令后重新规划。</p> : null}
              </div>
            ) : null}
            {needsConfidence ? (
              <label className="mt-3 flex cursor-pointer items-start gap-2 rounded border border-[#4a4638] bg-[#171b1d] p-3 text-[11px] leading-relaxed text-[#c7d3d9]">
                <input
                  type="checkbox"
                  checked={approveLowConfidence}
                  onChange={(event) => setApproveLowConfidence(event.target.checked)}
                  className="mt-0.5 accent-[#d7a64a]"
                />
                我已阅读规划理由，明确批准这份低于执行阈值的提案。
              </label>
            ) : null}
            <button
              type="button"
              disabled={working || (needsTarget && !selectedTarget) || (needsConfidence && !approveLowConfidence)}
              onClick={() => void resolve()}
              className="mt-3 flex h-9 w-full items-center justify-center gap-2 rounded bg-[#d7a64a] px-3 text-[11.5px] font-medium text-[#1c1b17] hover:bg-[#e4bd70] disabled:cursor-not-allowed disabled:opacity-40"
            >
              生成确认后的完整契约
            </button>
            <p className="mt-2 text-center text-[9.5px] text-[#8f8266]">此按钮不会执行 Blender 编辑</p>
          </div>
        ) : null}

        {plan.error && plan.status !== "NEEDS_CONFIRMATION" ? (
          <div className="m-4 flex items-start gap-2 rounded border border-[#e1746b]/25 bg-[#e1746b]/[0.05] p-3 text-[11px] leading-relaxed text-[#e1746b]">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <span><span className="mono">{plan.error.code}</span>：{plan.error.message}</span>
          </div>
        ) : null}

        {contract ? (
          <>
            <Section title="编辑契约" count={contract.targets.length}>
              <dl className="space-y-2 text-[10.5px]">
                <div className="flex justify-between gap-3"><dt className="text-[#637681]">契约版本</dt><dd className="mono text-[#aebdc5]">{contract.contract_version}</dd></div>
                <div className="flex justify-between gap-3"><dt className="text-[#637681]">重试预算</dt><dd className="mono text-[#aebdc5]">{contract.retry_budget}</dd></div>
                <div className="flex justify-between gap-3"><dt className="text-[#637681]">GLB 导出</dt><dd className="mono text-[#aebdc5]">{contract.export.enabled ? contract.export.profile : "关闭"}</dd></div>
                <div className="flex justify-between gap-3"><dt className="text-[#637681]">冻结集</dt><dd className="mono text-[#aebdc5]">{contract.freeze_set.length} 项</dd></div>
              </dl>
              <div className="mt-3">
                <div className="text-[10px] text-[#637681]">目标与新增对象 ID</div>
                <div className="mono mt-1.5 max-h-28 space-y-1 overflow-y-auto break-all text-[9.5px] text-[#9fb0ba]">
                  {contract.targets.map((target) => <div key={target}>{target}</div>)}
                </div>
              </div>
            </Section>
            <Section title="允许写入的范围" count={contract.write_set.length}>
              <div className="mono max-h-48 space-y-1.5 overflow-y-auto break-all rounded bg-[#0d1217] p-2.5 text-[9.5px] leading-relaxed text-[#9fb0ba]">
                {contract.write_set.map((item) => <div key={item}>{item}</div>)}
              </div>
            </Section>
            <Section title="目标约束" count={contract.constraints.length}>
              <div className="space-y-2">
                {contract.constraints.map((constraint, index) => (
                  <pre key={`${String(constraint.type)}-${index}`} className="mono overflow-x-auto whitespace-pre-wrap break-all rounded bg-[#0d1217] p-2.5 text-[9.5px] leading-relaxed text-[#9fb0ba]">{pretty(constraint)}</pre>
                ))}
              </div>
            </Section>
            <Section title="派生差异规则" count={contract.derived_allowances.length} defaultOpen={false}>
              <pre className="mono max-h-44 overflow-auto whitespace-pre-wrap break-all rounded bg-[#0d1217] p-2.5 text-[9.5px] text-[#9fb0ba]">{pretty(contract.derived_allowances)}</pre>
            </Section>
            <Section title="类型化工具计划" count={plan.request?.operations.length ?? 0}>
              <div className="space-y-2">
                {plan.request?.operations.map((operation) => (
                  <details key={operation.operation_id} className="rounded border border-[#2a3640] bg-[#0d1217] p-2.5">
                    <summary className="cursor-pointer">
                      <span className="mono text-[10.5px] text-[#c7d3d9]">{operation.tool}</span>
                      <span className="mono ml-2 text-[9px] text-[#637681]">{operation.operation_id}</span>
                    </summary>
                    <pre className="mono mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-all text-[9.5px] text-[#82939e]">{pretty(operation.arguments)}</pre>
                  </details>
                ))}
              </div>
            </Section>
          </>
        ) : null}
      </div>

      {plan.status === "READY" && contract && canExecute ? (
        <div className="shrink-0 border-t border-[#2a3640] bg-[#151d24] p-4">
          <label className="flex cursor-pointer items-start gap-2 text-[11px] leading-relaxed text-[#b8c6cd]">
            <input
              type="checkbox"
              checked={reviewedHash === plan.sha256}
              disabled={working}
              onChange={(event) => setReviewedHash(event.target.checked ? plan.sha256 : null)}
              className="mt-0.5 accent-[#4fc3b1]"
            />
            我已审阅当前哈希对应的目标、写集、派生规则和约束。
          </label>
          <button
            type="button"
            disabled={working || reviewedHash !== plan.sha256}
            onClick={() => void execute()}
            className="mt-3 flex h-10 w-full items-center justify-center gap-2 rounded bg-[#4fc3b1] px-3 text-[12px] font-semibold text-[#0d1b19] transition hover:bg-[#72d2c4] disabled:cursor-not-allowed disabled:bg-[#2c3b3d] disabled:text-[#71838e]"
          >
            {working ? <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" /> : <Play className="h-4 w-4 fill-current" />}
            执行这份已审阅计划
          </button>
          <p className="mt-2 flex items-center justify-center gap-1 text-[9.5px] text-[#637681]">
            <Check className="h-3 w-3" />执行后仍需新进程独立复验
          </p>
        </div>
      ) : null}
      {plan.status === "READY" && contract && !canExecute ? (
        <div className="shrink-0 border-t border-[#2a3640] bg-[#151d24] px-4 py-3 text-center text-[10.5px] leading-relaxed text-[#71838e]">
          这份计划已离开审阅阶段，不能重复执行。请查看运行证据，或通过“新编辑”生成新的运行目录。
        </div>
      ) : null}
    </div>
  );
}

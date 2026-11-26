import { AlertTriangle, Check, CheckCircle2, Download, FileJson2, Minus, ShieldCheck, XCircle } from "lucide-react";
import type { RunDetail, VerificationReport, WorkPhase } from "../../shared/types";

function CheckList({ title, status, checks }: { title: string; status?: string; checks?: Array<Record<string, unknown>> }) {
  const passed = status === "passed";
  return (
    <section className="border-b border-[#2a3640] px-4 py-3">
      <div className="flex items-center gap-2">
        {passed ? <CheckCircle2 className="h-3.5 w-3.5 text-[#4fc3b1]" /> : <AlertTriangle className="h-3.5 w-3.5 text-[#d7a64a]" />}
        <h3 className="text-[11.5px] font-medium text-[#c7d3d9]">{title}</h3>
        <span className={`mono ml-auto text-[9.5px] ${passed ? "text-[#4fc3b1]" : "text-[#d7a64a]"}`}>{status ?? "暂无报告"}</span>
      </div>
      {checks?.length ? (
        <div className="mt-2 space-y-1.5">
          {checks.map((check, index) => {
            const ok = check.status === "passed";
            const measured = check.measured === undefined ? null : JSON.stringify(check.measured);
            return (
              <div key={`${String(check.id ?? check.type ?? check.check)}-${index}`} className="flex items-start gap-2 rounded bg-[#0d1217] px-2.5 py-2">
                {ok ? <Check className="mt-0.5 h-3 w-3 shrink-0 text-[#4fc3b1]" /> : <Minus className="mt-0.5 h-3 w-3 shrink-0 text-[#d7a64a]" />}
                <div className="min-w-0 flex-1">
                  <div className="mono break-all text-[10px] text-[#aebdc5]">{String(check.id ?? check.type ?? check.check ?? `check_${index}`)}</div>
                  {measured ? <div className="mono mt-1 break-all text-[9px] text-[#637681]">实测 {measured}</div> : null}
                </div>
              </div>
            );
          })}
        </div>
      ) : <p className="mt-2 text-[10px] text-[#637681]">没有单独列出的检查项。</p>}
    </section>
  );
}

function hashRows(report: VerificationReport | null) {
  return report?.hashes?.map((row, index) => (
    <div key={`${String(row.check)}-${index}`} className="rounded bg-[#0d1217] px-2.5 py-2">
      <div className="flex items-center gap-2">
        <span className="mono text-[10px] text-[#aebdc5]">{String(row.check)}</span>
        <span className={`mono ml-auto text-[9px] ${row.status === "passed" ? "text-[#4fc3b1]" : "text-[#e1746b]"}`}>{String(row.status)}</span>
      </div>
      <div className="mono mt-1 break-all text-[9px] leading-relaxed text-[#637681]">{String(row.measured ?? "—")}</div>
    </div>
  ));
}

export function VerificationPanel({ run, phase }: { run: RunDetail | null; phase: WorkPhase }) {
  if (!run) {
    return (
      <div className="flex h-full flex-col items-center justify-center px-8 text-center">
        <ShieldCheck className="h-8 w-8 text-[#41535f]" />
        <p className="mt-4 text-[13px] text-[#9fb0ba]">等待独立复验证据</p>
        <p className="mt-2 max-w-[270px] text-[11px] leading-relaxed text-[#637681]">
          Runner 的 COMMITTED 只是提交状态。只有新 Blender 进程出具 VERIFIED 报告后，工程和 GLB 才会发布。
        </p>
        {["COMMITTED", "VERIFYING"].includes(phase) ? <p className="mono mt-5 text-[10px] text-[#d7a64a]">当前阶段：{phase}</p> : null}
      </div>
    );
  }

  const verification = run.verification;
  const quality = run.quality;
  const runnerStatus = typeof run.result?.status === "string" ? run.result.status : run.status;
  const locality = verification?.locality ?? quality?.locality;
  const unauthorized = locality?.unauthorized_changes?.length;
  const verified = run.verified && verification?.status === "VERIFIED";

  return (
    <div className="h-full overflow-y-auto">
      <div className="border-b border-[#2a3640] px-4 py-4">
        <div className={`flex items-start gap-3 rounded border p-3 ${verified ? "border-[#4fc3b1]/30 bg-[#4fc3b1]/[0.055]" : "border-[#d7a64a]/30 bg-[#d7a64a]/[0.05]"}`}>
          {verified ? <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-[#4fc3b1]" /> : <XCircle className="mt-0.5 h-5 w-5 shrink-0 text-[#d7a64a]" />}
          <div>
            <div className={`mono text-[13px] font-semibold ${verified ? "text-[#4fc3b1]" : "text-[#d7a64a]"}`}>
              {verified ? "VERIFIED" : verification?.status ?? "未通过独立复验"}
            </div>
            <p className="mt-1 text-[10.5px] leading-relaxed text-[#9fb0ba]">
              {verified ? "新进程已重新计算源、输出、目标、局部性和导出结果。" : "当前运行没有已验证交付，不提供工程或 GLB 下载。"}
            </p>
          </div>
        </div>
        <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-2 text-[10px]">
          <div><dt className="text-[#637681]">Runner 状态</dt><dd className="mono mt-1 text-[#b8c6cd]">{runnerStatus}</dd></div>
          <div><dt className="text-[#637681]">独立复验</dt><dd className={`mono mt-1 ${verified ? "text-[#4fc3b1]" : "text-[#d7a64a]"}`}>{verification?.status ?? "未通过"}</dd></div>
          <div><dt className="text-[#637681]">非目标未授权差异</dt><dd className={`mono mt-1 ${unauthorized === 0 ? "text-[#4fc3b1]" : unauthorized === undefined ? "text-[#82939e]" : "text-[#e1746b]"}`}>{unauthorized ?? "—"}</dd></div>
          <div><dt className="text-[#637681]">Blender</dt><dd className="mono mt-1 text-[#b8c6cd]">{verification?.blender_version ?? "—"}</dd></div>
        </dl>
        <div className="mono mt-3 break-all text-[9.5px] text-[#637681]">{run.runId}</div>
      </div>

      {verified ? (
        <div className="border-b border-[#2a3640] px-4 py-3">
          <h3 className="mb-2 text-[11.5px] font-medium text-[#c7d3d9]">已验证交付</h3>
          <div className="grid grid-cols-2 gap-2">
            {run.downloads.blend ? <a href={run.downloads.blend} download className="flex h-9 items-center justify-center gap-2 rounded bg-[#4fc3b1] text-[11px] font-medium text-[#0d1b19] hover:bg-[#72d2c4]"><Download className="h-3.5 w-3.5" />Blender 工程</a> : null}
            {run.downloads.glb ? <a href={run.downloads.glb} download className="flex h-9 items-center justify-center gap-2 rounded border border-[#34434e] text-[11px] text-[#c7d3d9] hover:bg-[#1b252d]"><Download className="h-3.5 w-3.5" />GLB 模型</a> : null}
          </div>
        </div>
      ) : null}

      {(verification?.error ?? quality?.error) ? (
        <div className="m-4 rounded border border-[#e1746b]/25 bg-[#e1746b]/[0.05] p-3 text-[11px] leading-relaxed text-[#e1746b]">
          <span className="mono">{(verification?.error ?? quality?.error)?.code}</span>：{(verification?.error ?? quality?.error)?.message}
        </div>
      ) : null}

      <CheckList title="目标编辑检查" status={verification?.targets?.status ?? quality?.targets?.status} checks={verification?.targets?.checks ?? quality?.targets?.checks} />
      <CheckList title="局部性与写集" status={locality?.status} checks={[]} />
      <CheckList title="GLB 导出" status={verification?.export?.status ?? quality?.export?.status} checks={verification?.export?.checks ?? quality?.export?.checks} />

      {verification?.hashes?.length ? (
        <section className="border-b border-[#2a3640] px-4 py-3">
          <h3 className="mb-2 text-[11.5px] font-medium text-[#c7d3d9]">独立重算哈希</h3>
          <div className="space-y-1.5">{hashRows(verification)}</div>
        </section>
      ) : null}

      {quality?.coverage_notes?.length ? (
        <section className="border-b border-[#2a3640] px-4 py-3">
          <h3 className="text-[11.5px] font-medium text-[#c7d3d9]">覆盖范围说明</h3>
          <ul className="mt-2 space-y-1.5 text-[10.5px] leading-relaxed text-[#82939e]">
            {quality.coverage_notes.map((note) => <li key={note}>• {note}</li>)}
          </ul>
        </section>
      ) : null}

      <div className="p-4">
        <div className="flex flex-wrap gap-2">
          {run.downloads.verification ? <a href={run.downloads.verification} download className="flex items-center gap-1.5 rounded border border-[#34434e] px-2.5 py-1.5 text-[10.5px] text-[#aebdc5] hover:bg-[#1b252d]"><FileJson2 className="h-3.5 w-3.5" />独立复验 JSON</a> : null}
          {run.downloads.quality && verified ? <a href={run.downloads.quality} download className="flex items-center gap-1.5 rounded border border-[#34434e] px-2.5 py-1.5 text-[10.5px] text-[#aebdc5] hover:bg-[#1b252d]"><FileJson2 className="h-3.5 w-3.5" />质量报告 JSON</a> : null}
          {run.downloads.plan ? <a href={run.downloads.plan} download className="flex items-center gap-1.5 rounded border border-[#34434e] px-2.5 py-1.5 text-[10.5px] text-[#aebdc5] hover:bg-[#1b252d]"><FileJson2 className="h-3.5 w-3.5" />已执行计划 JSON</a> : null}
        </div>
        <details className="mt-4">
          <summary className="cursor-pointer text-[10.5px] text-[#82939e]">查看原始机器证据</summary>
          <pre className="mono mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-all rounded bg-[#0d1217] p-3 text-[9px] leading-relaxed text-[#82939e]">{JSON.stringify({ result: run.result, verification: run.verification, quality: run.quality }, null, 2)}</pre>
        </details>
      </div>
    </div>
  );
}

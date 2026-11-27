import { useCallback, useEffect, useState } from "react";
import { CheckCircle2, Clock3, History, RefreshCw, RotateCcw, Undo2, Wifi } from "lucide-react";
import type { ChatConnState, ChatStatus, ChatTurnSummary } from "../../../shared/types";
import { chatTurns } from "../../lib/chatApi";

function dot(state: ChatConnState): string {
  return state === "connected" ? "bg-[#4fc3b1]" : state === "error" ? "bg-[#e1746b]" : "bg-[#d7a64a]";
}

function shortSha(sha: string | null | undefined): string {
  return sha ? sha.slice(0, 12) : "—";
}

function statusLabel(state: ChatConnState): string {
  return state === "connected" ? "已连接" : state === "connecting" ? "连接中" : state === "error" ? "未连接" : "未探测";
}

function time(ts: number): string {
  return new Date(ts).toLocaleTimeString("zh-CN", { hour12: false });
}

/** 左栏：审计点与事务操作（采纳 / 回退 / 同步）。 */
export function AuditPanel({
  status,
  onCommit,
  onRevert,
  onSync,
  onReconnect,
  refreshKey,
}: {
  status: ChatStatus;
  onCommit: () => void;
  onRevert: (scope: "turn" | "conversation") => void;
  onSync: () => void;
  onReconnect: () => void;
  refreshKey: number;
}) {
  const [turns, setTurns] = useState<ChatTurnSummary[]>([]);
  const load = useCallback(() => {
    chatTurns()
      .then((result) => setTurns(result.turns.slice(0, 8)))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    load();
  }, [load, refreshKey]);

  const turn = status.turn;
  return (
    <div className="flex h-full min-h-0 flex-col bg-[#0e141a]">
      <div className="shrink-0 border-b border-[#1f2a33] px-3 py-3">
        <div className="flex items-center gap-2 text-[11px] font-medium tracking-[0.08em] text-[#c3d0d6]">
          <History className="h-3.5 w-3.5 text-[#4fc3b1]" />
          审计点
        </div>
        <p className="mt-1 text-[10px] leading-relaxed text-[#5f707b]">
          每条消息开始时给真实 .blend 拍快照；不同意可一键回退，同意才生成交付副本。
        </p>
      </div>

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3 py-3">
        <section>
          <div className="flex items-center justify-between text-[10px] uppercase tracking-[0.1em] text-[#5f707b]">
            <span>对话基线</span>
            {status.conversationId ? <span className="mono normal-case text-[#82939e]">{status.conversationId.slice(-8)}</span> : null}
          </div>
          {status.conversationBaseline ? (
            <div className="mt-1.5 rounded border border-[#2a3640] bg-[#10151b] px-2.5 py-2">
              <div className="flex items-center justify-between text-[10.5px] text-[#c3d0d6]">
                <span>baseline.blend</span>
                <span className="mono text-[#82939e]">{shortSha(status.conversationBaseline.sha256)}</span>
              </div>
              <div className="mt-1 text-[9.5px] text-[#5f707b]">
                {(status.conversationBaseline.size / 1024).toFixed(0)} KB · {time(status.conversationBaseline.at)}
              </div>
            </div>
          ) : (
            <p className="mt-1.5 text-[10px] text-[#5f707b]">发送第一条消息时自动创建。</p>
          )}
        </section>

        <section>
          <div className="text-[10px] uppercase tracking-[0.1em] text-[#5f707b]">本回合</div>
          {turn ? (
            <div className="mt-1.5 rounded border border-[#4fc3b1]/30 bg-[#4fc3b1]/5 px-2.5 py-2">
              <div className="flex items-center justify-between gap-2">
                <span className="truncate text-[10.5px] text-[#edf3f5]">{turn.instruction}</span>
                {turn.committed ? (
                  <span className="flex shrink-0 items-center gap-1 text-[9.5px] text-[#4fc3b1]">
                    <CheckCircle2 className="h-3 w-3" />
                    已采纳
                  </span>
                ) : (
                  <span className="flex shrink-0 items-center gap-1 text-[9.5px] text-[#d7a64a]">
                    <Clock3 className="h-3 w-3" />
                    进行中
                  </span>
                )}
              </div>
              <div className="mt-1 flex items-center justify-between text-[9.5px] text-[#82939e]">
                <span className="mono">{shortSha(turn.baseline?.sha256)}</span>
                <span>{time(turn.startedAt)}</span>
              </div>
              <div className="mt-2 flex gap-1.5">
                <button
                  type="button"
                  onClick={onCommit}
                  disabled={status.busy}
                  className="flex h-6 flex-1 items-center justify-center gap-1 rounded bg-[#4fc3b1] text-[10px] font-medium text-[#0c1116] hover:bg-[#6fd6c5] disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <CheckCircle2 className="h-3 w-3" />
                  采纳结果
                </button>
                <button
                  type="button"
                  onClick={() => onRevert("turn")}
                  disabled={status.busy}
                  className="flex h-6 flex-1 items-center justify-center gap-1 rounded border border-[#34434e] text-[10px] text-[#c3d0d6] hover:border-[#e1746b]/50 hover:text-[#efb1aa] disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <Undo2 className="h-3 w-3" />
                  回退本回合
                </button>
              </div>
            </div>
          ) : (
            <p className="mt-1.5 text-[10px] text-[#5f707b]">还没有开始回合。</p>
          )}
        </section>

        <section className="space-y-1.5">
          <button
            type="button"
            onClick={onSync}
            disabled={status.bridge !== "connected"}
            className="flex h-7 w-full items-center justify-center gap-1.5 rounded border border-[#34434e] text-[10.5px] text-[#c3d0d6] hover:border-[#4fc3b1]/50 disabled:opacity-40"
          >
            <RefreshCw className="h-3 w-3" />
            立即同步参考镜像
          </button>
          <button
            type="button"
            onClick={() => onRevert("conversation")}
            disabled={status.busy || !status.conversationBaseline}
            className="flex h-7 w-full items-center justify-center gap-1.5 rounded border border-[#34434e] text-[10.5px] text-[#c3d0d6] hover:border-[#e1746b]/50 hover:text-[#efb1aa] disabled:opacity-40"
          >
            <RotateCcw className="h-3 w-3" />
            回退到对话开始前
          </button>
          <button
            type="button"
            onClick={onReconnect}
            className="flex h-7 w-full items-center justify-center gap-1.5 rounded border border-[#34434e] text-[10.5px] text-[#c3d0d6] hover:border-[#4fc3b1]/50"
          >
            <Wifi className="h-3 w-3" />
            重连 Blender（{statusLabel(status.bridge)}）
          </button>
        </section>

        <section>
          <div className="mb-1.5 flex items-center justify-between text-[10px] uppercase tracking-[0.1em] text-[#5f707b]">
            <span>最近回合</span>
            <button type="button" onClick={load} className="text-[9.5px] normal-case text-[#82939e] hover:text-white">
              刷新
            </button>
          </div>
          {turns.length === 0 ? (
            <p className="text-[10px] text-[#5f707b]">暂无记录（runs/chat 下的审计包）。</p>
          ) : (
            <ul className="space-y-1">
              {turns.map((item) => (
                <li key={item.turnId} className="rounded border border-[#1f2a33] px-2 py-1.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-[10px] text-[#c3d0d6]">{item.instruction || item.turnId}</span>
                    <span className={`shrink-0 text-[9px] ${item.committed ? "text-[#4fc3b1]" : "text-[#82939e]"}`}>
                      {item.committed ? "已采纳" : "未采纳"}
                    </span>
                  </div>
                  <div className="mt-0.5 text-[9px] text-[#5f707b]">
                    {item.steps} 次脚本执行 · {time(item.startedAt)}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <div className="shrink-0 border-t border-[#1f2a33] px-3 py-2 text-[9.5px] text-[#5f707b]">
        <div className="flex items-center gap-1.5">
          <span className={`h-1.5 w-1.5 rounded-full ${dot(status.bridge)}`} />
          Bridge {statusLabel(status.bridge)}
          {status.blenderInfo ? ` · ${status.blenderInfo.version}` : ""}
        </div>
        <div className="mt-1 flex items-center gap-1.5">
          <span className={`h-1.5 w-1.5 rounded-full ${dot(status.blender)}`} />
          Blender {statusLabel(status.blender)}
          {status.blenderError ? <span className="truncate">：{status.blenderError}</span> : null}
        </div>
      </div>
    </div>
  );
}

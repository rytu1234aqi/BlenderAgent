import { useCallback, useEffect, useState } from "react";
import { AlertCircle, X } from "lucide-react";
import { useChat } from "../../hooks/useChat";
import { ResizableLayout } from "../ResizableLayout";
import { AuditPanel } from "./AuditPanel";
import { ChatPanel } from "./ChatPanel";
import { ReferenceViewport } from "./ReferenceViewport";
import { StudioHeader } from "./StudioHeader";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "请求失败，请查看右侧时间线。";
}

/** Studio 模式：Blender 主战场 + GLB 参考镜像 + 对话 + 审计点。 */
export function Studio({ onSwitchWorkbench }: { onSwitchWorkbench: () => void }) {
  const chat = useChat();
  const [draft, setDraft] = useState("");
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    if (chat.status.turn) setRefreshKey((key) => key + 1);
  }, [chat.status.turn?.turnId]);

  const annotate = useCallback((note: string) => {
    setSuggestions((current) => [...current, note]);
    setDraft((current) => `${current}${current.trim() ? "\n" : ""}${note}`);
  }, []);

  const removeSuggestion = useCallback((index: number) => {
    if (index < 0) setSuggestions([]);
    else setSuggestions((current) => current.filter((_, item) => item !== index));
  }, []);

  const send = async () => {
    const text = draft.trim();
    if (!text) return;
    setError(null);
    try {
      await chat.send(text);
      setDraft("");
      setSuggestions([]);
    } catch (cause) {
      setError(errorMessage(cause));
    }
  };

  const commit = async () => {
    setError(null);
    try {
      await chat.commit();
      setRefreshKey((key) => key + 1);
    } catch (cause) {
      setError(errorMessage(cause));
    }
  };

  const revert = async (scope: "turn" | "conversation") => {
    setError(null);
    try {
      await chat.revert(scope);
      setRefreshKey((key) => key + 1);
    } catch (cause) {
      setError(errorMessage(cause));
    }
  };

  const sync = async () => {
    setError(null);
    try {
      const result = await chat.sync();
      if (!result.ok) setError(result.error ?? "参考镜像同步失败。");
    } catch (cause) {
      setError(errorMessage(cause));
    }
  };

  const reconnect = async () => {
    setError(null);
    try {
      const status = await chat.reconnect();
      if (status.bridge !== "connected") {
        setError(status.bridgeError ?? "还是没连上，请确认 Blender 里已启用 blender_bridge 插件并启动 Bridge。");
      }
    } catch (cause) {
      setError(errorMessage(cause));
    }
  };

  const reset = async () => {
    setError(null);
    try {
      await chat.reset();
      setDraft("");
      setSuggestions([]);
      setRefreshKey((key) => key + 1);
    } catch (cause) {
      setError(errorMessage(cause));
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <StudioHeader status={chat.status} onSwitchWorkbench={onSwitchWorkbench} onReset={() => void reset()} />
      {error ? (
        <div
          role="alert"
          className="absolute left-1/2 top-16 z-50 flex w-[min(680px,calc(100%-32px))] -translate-x-1/2 items-start gap-2 rounded border border-[#e1746b]/40 bg-[#2b1d20] px-3 py-2.5 shadow-2xl"
        >
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-[#e1746b]" />
          <p className="flex-1 text-[11.5px] leading-relaxed text-[#efb1aa]">{error}</p>
          <button type="button" aria-label="关闭错误提示" onClick={() => setError(null)} className="text-[#c98680] hover:text-white">
            <X className="h-4 w-4" />
          </button>
        </div>
      ) : null}
      <div className="min-h-0 flex-1">
        <ResizableLayout
          left={
            <AuditPanel
              status={chat.status}
              refreshKey={refreshKey}
              onCommit={() => void commit()}
              onRevert={(scope) => void revert(scope)}
              onSync={() => void sync()}
              onReconnect={() => void reconnect()}
            />
          }
          center={<ReferenceViewport scene={chat.scene} onAnnotate={annotate} />}
          right={
            <ChatPanel
              entries={chat.entries}
              status={chat.status}
              connected={chat.connected}
              draft={draft}
              suggestions={suggestions}
              onDraftChange={setDraft}
              onSend={() => void send()}
              onAnswer={(text) => {
                setError(null);
                chat.answer(text).catch((cause) => setError(errorMessage(cause)));
              }}
              onCancel={() => chat.cancel().catch((cause) => setError(errorMessage(cause)))}
              onRemoveSuggestion={removeSuggestion}
            />
          }
        />
      </div>
    </div>
  );
}

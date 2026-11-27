import type { ChatStatus, ChatTurnSummary } from "../../shared/types";

interface ChatErrorBody {
  error?: string | { message?: string };
}

async function chatRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  headers.set("X-BlendGuard-Client", "workbench");
  headers.set("Accept", "application/json");
  if (init?.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  let response: Response;
  try {
    response = await fetch(path, { ...init, headers });
  } catch {
    throw new Error("无法连接本地服务，请确认后端已启动。");
  }
  const body = (await response.json().catch(() => null)) as T | ChatErrorBody | null;
  if (!response.ok) {
    const raw = (body as ChatErrorBody | null)?.error;
    const message = typeof raw === "string" ? raw : raw?.message ?? `请求失败（HTTP ${response.status}）`;
    throw new Error(message);
  }
  return body as T;
}

export const chatStatus = () => chatRequest<ChatStatus>("/api/chat/status");

export const chatTurns = () => chatRequest<{ turns: ChatTurnSummary[] }>("/api/chat/turns");

export const chatMessage = (text: string) => chatRequest<{ ok: boolean; turnId?: string; answered?: boolean }>("/api/chat/message", {
  method: "POST",
  body: JSON.stringify({ text }),
});

export const chatAnswer = (text: string) => chatRequest<{ ok: boolean }>("/api/chat/answer", {
  method: "POST",
  body: JSON.stringify({ text }),
});

export const chatCancel = () => chatRequest<{ ok: boolean }>("/api/chat/cancel", { method: "POST", body: "{}" });

export const chatReconnect = () => chatRequest<ChatStatus>("/api/chat/reconnect", { method: "POST", body: "{}" });

export const chatSync = () => chatRequest<{ ok: boolean; error?: string }>("/api/chat/sync", { method: "POST", body: "{}" });

export const chatCommit = () => chatRequest<{ ok: boolean; path: string; sha256: string; size: number }>("/api/chat/commit", {
  method: "POST",
  body: "{}",
});

export const chatRevert = (scope: "turn" | "conversation") => chatRequest<{ ok: boolean; scope: string; path: string }>("/api/chat/revert", {
  method: "POST",
  body: JSON.stringify({ scope }),
});

export const chatReset = () => chatRequest<{ ok: boolean }>("/api/chat/reset", { method: "POST", body: "{}" });

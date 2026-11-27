import { useCallback, useEffect, useRef, useState } from "react";
import type { ChatEntry, ChatEvent, ChatScene, ChatStatus } from "../../shared/types";
import * as api from "../lib/chatApi";

export interface ChatState {
  status: ChatStatus;
  entries: ChatEntry[];
  scene: ChatScene | null;
}

const INITIAL: ChatState = {
  status: {
    bridge: "unknown",
    blender: "unknown",
    deepseek: false,
    model: "",
    busy: false,
    conversationId: null,
    conversationBaseline: null,
    turn: null,
  },
  entries: [],
  scene: null,
};

function applyEvent(state: ChatState, event: ChatEvent): ChatState {
  switch (event.type) {
    case "snapshot":
      return {
        status: event.snapshot.status,
        entries: event.snapshot.entries,
        scene: event.snapshot.scene,
      };
    case "entry":
      return { ...state, entries: [...state.entries, event.entry] };
    case "delta":
      return {
        ...state,
        entries: state.entries.map((entry) =>
          entry.id === event.id ? { ...entry, text: entry.text + event.text } : entry,
        ),
      };
    case "patch":
      return {
        ...state,
        entries: state.entries.map((entry) => (entry.id === event.id ? { ...entry, ...event.patch } : entry)),
      };
    case "status":
      return { ...state, status: event.status };
    case "scene":
      return { ...state, scene: event.scene };
    case "clear":
      return { ...state, entries: [], scene: null };
    default:
      return state;
  }
}

export function useChat() {
  const [state, setState] = useState<ChatState>(INITIAL);
  const [connected, setConnected] = useState(false);
  const sourceRef = useRef<EventSource | null>(null);

  useEffect(() => {
    const source = new EventSource("/api/chat/events");
    sourceRef.current = source;
    source.onopen = () => setConnected(true);
    source.onerror = () => setConnected(false);
    source.onmessage = (message: MessageEvent<string>) => {
      try {
        const event = JSON.parse(message.data) as ChatEvent;
        setState((current) => applyEvent(current, event));
      } catch {
        /* 忽略坏帧 */
      }
    };
    return () => {
      source.close();
      sourceRef.current = null;
    };
  }, []);

  const send = useCallback(async (text: string) => {
    const result = await api.chatMessage(text);
    if (result.answered) setState((current) => ({ ...current, status: { ...current.status, pendingQuestion: undefined } }));
  }, []);
  const answer = useCallback((text: string) => api.chatAnswer(text), []);
  const cancel = useCallback(() => api.chatCancel(), []);
  const reconnect = useCallback(() => api.chatReconnect(), []);
  const sync = useCallback(() => api.chatSync(), []);
  const commit = useCallback(() => api.chatCommit(), []);
  const revert = useCallback((scope: "turn" | "conversation") => api.chatRevert(scope), []);
  const reset = useCallback(() => api.chatReset(), []);
  const turns = useCallback(() => api.chatTurns(), []);

  return { ...state, connected, send, answer, cancel, reconnect, sync, commit, revert, reset, turns };
}

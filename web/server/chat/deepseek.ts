export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface ChatTool {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters: Record<string, unknown>;
  };
}

export interface ChatResult {
  content: string;
  reasoning: string;
  toolCalls: ToolCall[];
  finishReason?: string;
}

export interface StreamChatOptions {
  messages: ChatMessage[];
  tools: ChatTool[];
  signal?: AbortSignal;
  onContent?: (text: string) => void;
  onReasoning?: (text: string) => void;
  model: string;
  temperature?: number;
}

export interface DeepSeekConnection {
  apiKey: string;
  baseUrl: string;
  model: string;
}

export function deepseekConfigured(connection: DeepSeekConnection): boolean {
  return connection.apiKey.length > 0;
}

/**
 * 极简 DeepSeek Chat Completions 流式客户端（OpenAI 兼容协议）。
 * 只做 SSE 解析、content/reasoning 回调、tool_calls 增量拼接。
 */
export async function streamChat(connection: DeepSeekConnection, options: StreamChatOptions): Promise<ChatResult> {
  if (!connection.apiKey) throw new Error("未配置 DEEPSEEK_API_KEY（见根目录 .env）");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 300_000);
  const onAbort = () => controller.abort();
  options.signal?.addEventListener("abort", onAbort);

  try {
    const response = await fetch(`${connection.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${connection.apiKey}`,
      },
      body: JSON.stringify({
        model: options.model,
        messages: options.messages,
        tools: options.tools.length ? options.tools : undefined,
        tool_choice: options.tools.length ? "auto" : undefined,
        stream: true,
        temperature: options.temperature ?? 0.3,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`DeepSeek API ${response.status}：${body.slice(0, 500)}`);
    }
    if (!response.body) throw new Error("DeepSeek API 返回了空响应体");

    let content = "";
    let reasoning = "";
    let finishReason: string | undefined;
    const toolCalls = new Map<number, ToolCall>();

    const handleLine = (line: string) => {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) return;
      const payload = trimmed.slice(5).trim();
      if (!payload || payload === "[DONE]") return;
      let parsed: {
        choices?: Array<{
          finish_reason?: string | null;
          delta?: {
            content?: string | null;
            reasoning_content?: string | null;
            tool_calls?: Array<{
              index: number;
              id?: string;
              type?: string;
              function?: { name?: string; arguments?: string };
            }>;
          };
        }>;
      };
      try {
        parsed = JSON.parse(payload);
      } catch {
        return;
      }
      const choice = parsed.choices?.[0];
      if (!choice) return;
      if (choice.finish_reason) finishReason = choice.finish_reason;
      const delta = choice.delta;
      if (!delta) return;
      if (delta.reasoning_content) {
        reasoning += delta.reasoning_content;
        options.onReasoning?.(delta.reasoning_content);
      }
      if (delta.content) {
        content += delta.content;
        options.onContent?.(delta.content);
      }
      for (const call of delta.tool_calls ?? []) {
        const existing = toolCalls.get(call.index) ?? {
          id: call.id ?? "",
          type: "function" as const,
          function: { name: "", arguments: "" },
        };
        if (call.id) existing.id = call.id;
        if (call.function?.name) existing.function.name += call.function.name;
        if (call.function?.arguments) existing.function.arguments += call.function.arguments;
        toolCalls.set(call.index, existing);
      }
    };

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let index: number;
      while ((index = buffer.indexOf("\n")) >= 0) {
        handleLine(buffer.slice(0, index));
        buffer = buffer.slice(index + 1);
      }
    }
    if (buffer) handleLine(buffer);

    return {
      content,
      reasoning,
      finishReason,
      toolCalls: [...toolCalls.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([, call]) => call)
        .filter((call) => call.function.name.length > 0),
    };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
  }
}

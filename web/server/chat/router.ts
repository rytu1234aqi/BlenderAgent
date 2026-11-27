import fs from "node:fs";
import path from "node:path";
import type { Express, Request, Response } from "express";

import type { ChatStatus } from "../../shared/types";
import { StudioAgent, type StepOutcome } from "./agent";
import { BlenderBridge } from "./bridge";
import { deepseekConfigured, type DeepSeekConnection } from "./deepseek";
import type { ChatConfig } from "./env";
import { ChatHub } from "./hub";
import { runBlenderScript } from "./runner";
import { SceneMirror } from "./sceneSync";
import { ChatTx } from "./tx";

export interface ChatRuntime {
  config: ChatConfig;
  hub: ChatHub;
  bridge: BlenderBridge;
  tx: ChatTx;
  mirror: SceneMirror;
  agent: StudioAgent;
  connection: DeepSeekConnection;
  activeTurnId: string | null;
  stepCounter: number;
}

export function createChatRuntime(config: ChatConfig): ChatRuntime {
  const connection: DeepSeekConnection = {
    apiKey: config.deepseekKey,
    baseUrl: config.deepseekBaseUrl,
    model: config.deepseekModel,
  };
  const hub = new ChatHub(deepseekConfigured(connection), config.deepseekModel);
  const bridge = new BlenderBridge(config.bridgeUrl, config.bridgeToken, config.bridgeTokenFile);
  const tx = new ChatTx(hub, bridge, config.runsDir);
  const mirror = new SceneMirror(hub, config.runsDir);

  const runtime: ChatRuntime = {
    config,
    hub,
    bridge,
    tx,
    mirror,
    connection,
    activeTurnId: null,
    stepCounter: 0,
    agent: undefined as unknown as StudioAgent,
  };

  const runStep = async (code: string, _summary: string): Promise<StepOutcome> => {
    const turnId = runtime.activeTurnId;
    if (!turnId) throw new Error("没有激活的回合，请先发送建模请求。");
    const workingFile = tx.workingFile(turnId);
    if (!workingFile) throw new Error("找不到本回合的隔离工作副本。");
    runtime.stepCounter += 1;
    const turnDir = path.join(path.dirname(workingFile), "scripts", `step-${runtime.stepCounter}`);
    const result = await runBlenderScript({
      exe: config.blenderExe,
      workingFile,
      turnDir,
      code,
      timeoutMs: config.scriptTimeoutMs,
    });
    const logParts = [result.stdout.trim(), result.stderr.trim()].filter(Boolean);
    if (!result.ok) {
      logParts.push(result.error ? `[runner] ${result.error}` : `[runner] 退出码 ${result.exitCode ?? "unknown"}`);
    }
    const log = logParts.join("\n\n").trim();
    if (result.ok && result.glbFile) {
      mirror.publish(result.glbFile);
      hub.setStatus({ blender: "connected", blenderError: undefined });
    }
    return { ok: result.ok, log, glbFile: result.ok ? result.glbFile : undefined, durationMs: result.durationMs };
  };

  runtime.agent = new StudioAgent({
    hub,
    connection,
    runStep,
    journal: (item) => {
      if (runtime.activeTurnId) tx.appendJournal(runtime.activeTurnId, item);
    },
  });
  return runtime;
}

/** 后台连接 Blender Bridge 插件；失败只记录状态，不阻断后端启动。 */
export async function connectChatBridge(runtime: ChatRuntime): Promise<void> {
  const { hub, bridge } = runtime;
  hub.setStatus({ bridge: "connecting", bridgeError: undefined });
  const ok = await bridge.connect();
  if (!ok) {
    hub.setStatus({
      bridge: "error",
      bridgeError: bridge.error,
      blender: "error",
      blenderError: "Blender Bridge 未连接（在 Blender 中按 N → Bridge → Start Bridge）",
    });
    return;
  }
  hub.setStatus({
    bridge: "connected",
    bridgeError: undefined,
    blender: "connected",
    blenderError: undefined,
    blenderInfo: bridge.info,
  });
  const preview = await runtime.mirror.previewLive(bridge);
  if (!preview.ok) {
    hub.setStatus({ blender: "error", blenderError: preview.error });
  }
}

function statusSnapshot(runtime: ChatRuntime): ChatStatus {
  return runtime.hub.status;
}

/**
 * Studio 模式路由：对话 + 参考镜像 + 审计点/采纳/回退。
 * 与既有 /api（Workbench 可信编辑）完全隔离。
 */
export function registerChatRoutes(app: Express, runtime: ChatRuntime): void {
  const { hub, bridge, tx, mirror, agent } = runtime;
  const json = (res: Response, status: number, body: unknown) => res.status(status).json(body);

  app.get("/api/chat/events", (_req: Request, res: Response) => {
    hub.addClient(res);
  });

  app.get("/api/chat/status", (_req: Request, res: Response) => {
    json(res, 200, statusSnapshot(runtime));
  });

  app.get("/api/chat/turns", (_req: Request, res: Response) => {
    json(res, 200, { turns: tx.listTurns() });
  });

  app.get("/api/chat/scene", (_req: Request, res: Response) => {
    const file = mirror.file;
    if (!file || !fs.existsSync(file)) {
      json(res, 404, { error: "还没有参考镜像，请先连接 Blender 并建模。" });
      return;
    }
    res.setHeader("Cache-Control", "no-store");
    res.sendFile(file);
  });

  app.post("/api/chat/message", async (req: Request, res: Response) => {
    const text = String(req.body?.text ?? "").trim();
    try {
      if (hub.hasPendingQuestion()) {
        if (!text) return json(res, 400, { error: "请回答问题。" });
        hub.answerQuestion(text);
        return json(res, 200, { ok: true, answered: true });
      }
      if (!text) return json(res, 400, { error: "消息不能为空。" });
      if (agent.busy) return json(res, 409, { error: "Agent 正在执行，请稍候或先取消。" });
      if (bridge.state !== "connected") {
        return json(res, 503, {
          error:
            "Blender Bridge 未连接。请在 Blender 中启用 blender_bridge 插件，按 N → Bridge → Start Bridge，然后点「重连」。",
        });
      }
      if (!deepseekConfigured(runtime.connection)) {
        return json(res, 400, { error: "未配置 DEEPSEEK_API_KEY，请在 .env 中填写后重启后端。" });
      }
      const turn = await tx.beginTurn(text);
      runtime.activeTurnId = turn.turnId;
      runtime.stepCounter = 0;
      void agent.run(text);
      return json(res, 200, { ok: true, turnId: turn.turnId });
    } catch (error) {
      return json(res, 500, { error: (error as Error).message });
    }
  });

  app.post("/api/chat/answer", (req: Request, res: Response) => {
    const text = String(req.body?.text ?? "").trim();
    if (!text) return json(res, 400, { error: "回答不能为空。" });
    if (!hub.hasPendingQuestion()) return json(res, 409, { error: "当前没有问题待回答。" });
    hub.answerQuestion(text);
    return json(res, 200, { ok: true });
  });

  app.post("/api/chat/cancel", (_req: Request, res: Response) => {
    agent.cancel();
    return json(res, 200, { ok: true });
  });

  app.post("/api/chat/reconnect", async (_req: Request, res: Response) => {
    await connectChatBridge(runtime);
    return json(res, 200, statusSnapshot(runtime));
  });

  app.post("/api/chat/sync", async (_req: Request, res: Response) => {
    if (bridge.state !== "connected") {
      return json(res, 503, { ok: false, error: "Blender Bridge 未连接，无法导出参考镜像。" });
    }
    const result = await mirror.previewLive(bridge);
    return json(res, result.ok ? 200 : 502, result);
  });

  app.post("/api/chat/commit", async (req: Request, res: Response) => {
    const turnId = String(req.body?.turnId ?? runtime.activeTurnId ?? hub.status.turn?.turnId ?? "");
    if (!turnId) return json(res, 400, { error: "找不到当前审计点，请先发送一条消息。" });
    if (agent.busy) return json(res, 409, { error: "Agent 还在执行，等它停下来再采纳。" });
    try {
      const result = await tx.commit(turnId);
      if (bridge.state === "connected") await mirror.previewLive(bridge);
      return json(res, 200, { ok: true, ...result });
    } catch (error) {
      return json(res, 500, { error: (error as Error).message });
    }
  });

  app.post("/api/chat/revert", async (req: Request, res: Response) => {
    const scope = req.body?.scope === "conversation" ? "conversation" : "turn";
    if (agent.busy) return json(res, 409, { error: "Agent 还在执行，先取消再回退。" });
    if (bridge.state !== "connected") return json(res, 503, { error: "Blender Bridge 未连接，无法回退。" });
    try {
      const result = await tx.revert(scope);
      hub.setStatus({ turn: hub.status.turn ? { ...hub.status.turn, committed: false } : null });
      await mirror.previewLive(bridge);
      return json(res, 200, { ok: true, ...result });
    } catch (error) {
      return json(res, 500, { error: (error as Error).message });
    }
  });

  app.post("/api/chat/reset", (_req: Request, res: Response) => {
    if (agent.busy) return json(res, 409, { error: "Agent 还在执行，请先取消。" });
    agent.reset();
    tx.resetConversation();
    hub.clear();
    hub.setStatus({ pendingQuestion: undefined, turn: null });
    hub.setScene(null);
    return json(res, 200, { ok: true });
  });
}

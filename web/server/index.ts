import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express, { type NextFunction, type Request, type Response } from "express";
import { BlendGuardClient } from "./blendguard";
import { config as defaultConfig, type AppConfig } from "./config";
import { resolveArtifact, resolveAssetPreview } from "./artifacts";
import { WorkbenchHub } from "./events";
import { asWebError, WebError } from "./errors";
import { createSecurityMiddleware, notFound } from "./security";
import { WorkbenchSession } from "./session";

function asyncRoute(
  handler: (req: Request, res: Response) => Promise<void>,
): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => void handler(req, res).catch(next);
}

function plannerInfo(config: AppConfig): import("../shared/types").PlannerInfo {
  if (config.planner === "deterministic") {
    return { id: "deterministic", label: "离线教学规划器（非 LLM）", isLlm: false };
  }
  if (config.planner === "deepseek") {
    return { id: "deepseek", label: "DeepSeek LLM（结构化规划）", isLlm: true, model: config.model };
  }
  return { id: "claude", label: "Claude 结构化规划器", isLlm: true, model: config.model };
}

export function createApplication(config: AppConfig = defaultConfig, client = new BlendGuardClient(config)) {
  const hub = new WorkbenchHub({
    phase: "IDLE",
    busy: false,
    blender: client.blenderState(),
    planner: plannerInfo(config),
    assetId: null,
    planId: null,
    runId: null,
  });
  const session = new WorkbenchSession(client, hub);
  const app = express();
  app.disable("x-powered-by");
  app.use(createSecurityMiddleware(config));
  app.use(express.json({ limit: "32kb" }));

  app.get("/api/status", (_req, res) => res.json({ status: hub.status }));
  app.get("/api/events", (_req, res) => hub.addClient(res));
  app.get("/api/assets", asyncRoute(async (_req, res) => {
    hub.assets = await client.listAssets();
    res.json({ assets: hub.assets });
  }));
  app.get("/api/runs", asyncRoute(async (_req, res) => {
    hub.setRuns(await client.listRuns());
    res.json({ runs: hub.runs });
  }));
  app.get("/api/runs/:runId", asyncRoute(async (req, res) => {
    res.json({ run: await session.loadRun(req.params.runId) });
  }));
  app.post("/api/plans", asyncRoute(async (req, res) => {
    const plan = await session.createPlan(String(req.body?.assetId ?? ""), String(req.body?.instruction ?? ""));
    res.json({ plan });
  }));
  app.post("/api/plans/:planId/resolve", asyncRoute(async (req, res) => {
    const confirmTarget = typeof req.body?.confirmTarget === "string" ? req.body.confirmTarget : undefined;
    const approveLowConfidence = req.body?.approveLowConfidence === true;
    const plan = await session.resolvePlan(
      req.params.planId,
      String(req.body?.sha256 ?? ""),
      { confirmTarget, approveLowConfidence },
    );
    res.json({ plan });
  }));
  app.post("/api/plans/:planId/execute", asyncRoute(async (req, res) => {
    const run = await session.executePlan(req.params.planId, String(req.body?.sha256 ?? ""));
    res.json({ run });
  }));
  app.post("/api/session/reset", (_req, res) => {
    session.reset();
    res.json({ ok: true });
  });
  app.get("/api/runs/:runId/artifacts/:kind", asyncRoute(async (req, res) => {
    const artifact = await resolveArtifact(client, req.params.runId, req.params.kind);
    res.type(artifact.contentType);
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Disposition", `attachment; filename="${artifact.fileName}"`);
    res.sendFile(artifact.path);
  }));
  app.get("/api/assets/:assetId/previews/:view", asyncRoute(async (req, res) => {
    res.setHeader("Cache-Control", "no-cache");
    res.sendFile(await resolveAssetPreview(client, req.params.assetId, req.params.view));
  }));
  app.use("/api", notFound);

  const hasDist = fs.existsSync(path.join(config.distDir, "index.html"));
  if (hasDist) {
    app.use(express.static(config.distDir, { index: false }));
  }
  app.get("*", (_req, res, next) => {
    if (!hasDist) {
      res.status(503).type("text").send("前端尚未构建。请运行 npm run dev，或先运行 npm run build。");
      return;
    }
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    );
    res.sendFile(path.join(config.distDir, "index.html"), (error) => {
      if (error) next(error);
    });
  });
  app.use((error: Error, _req: Request, res: Response, _next: NextFunction) => {
    const failure = (error as { type?: string }).type === "entity.parse.failed"
      ? new WebError("INVALID_JSON", "请求 JSON 无法解析。", 400)
      : asWebError(error);
    res.status(failure.status).json({
      error: { code: failure.code, message: failure.message, details: failure.details },
    });
  });
  return { app, client, hub, session };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const { app, hub, session } = createApplication();
  await session.initialize();
  const server = app.listen(defaultConfig.port, "127.0.0.1", () => {
    console.log(`[blendguard] http://127.0.0.1:${defaultConfig.port}`);
    console.log(`[blendguard] planner=${defaultConfig.planner}, blender=${defaultConfig.blender ?? "auto"}`);
  });
  server.requestTimeout = defaultConfig.processTimeoutMs * 2 + 60_000;
  const heartbeat = setInterval(() => hub.heartbeat(), 20_000);
  heartbeat.unref();
  const shutdown = () => {
    clearInterval(heartbeat);
    server.close(() => process.exit(0));
    server.closeAllConnections();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

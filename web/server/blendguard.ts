import { randomUUID } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import type {
  AssetInfo,
  PlanResolution,
  PlanReview,
  QualityReport,
  RunDetail,
  RunSummary,
  VerificationReport,
} from "../shared/types";
import type { AppConfig } from "./config";
import { findAssetPreviews } from "./artifacts";
import { inspectCacheDirectory, isPathInside } from "./config";
import { WebError } from "./errors";
import { assertRunId, exists, fileSha256, readJson } from "./files";
import { createCommandRunner, processFailure, type CommandResult, type CommandRunner } from "./process";

interface RawPlan {
  status: PlanReview["status"];
  planner?: Record<string, unknown>;
  instruction?: string;
  proposal?: PlanReview["proposal"];
  source_file?: string;
  source_sha256?: string;
  summary_sha256?: string;
  inspection?: PlanReview["inspection"];
  request?: PlanReview["request"];
  error?: PlanReview["error"];
}

export class BlendGuardClient {
  private readonly runCommand: CommandRunner;

  constructor(readonly config: AppConfig, runner?: CommandRunner) {
    this.runCommand = runner ?? createCommandRunner(config);
  }

  blenderState(): "unknown" | "connected" | "error" {
    if (!this.config.blender) return "unknown";
    return fs.existsSync(this.config.blender) ? "connected" : "error";
  }

  runDirectory(runId: string): string {
    assertRunId(runId);
    return path.join(this.config.runsDir, runId);
  }

  planPath(runId: string): string {
    assertRunId(runId);
    return path.join(this.config.runsDir, `${runId}.plan.json`);
  }

  async resolveAsset(assetId: string): Promise<string> {
    if (!assetId || assetId !== path.basename(assetId) || !assetId.toLowerCase().endsWith(".blend")) {
      throw new WebError("INVALID_ASSET", "源资产只能是 assets 根目录中的 .blend 文件。", 400);
    }
    const root = await fsp.realpath(this.config.assetsDir);
    const candidate = path.join(root, assetId);
    if (!isPathInside(root, candidate)) throw new WebError("INVALID_ASSET", "源资产路径越界。", 400);
    const real = await fsp.realpath(candidate).catch(() => {
      throw new WebError("ASSET_NOT_FOUND", "源资产不存在。", 404);
    });
    if (!isPathInside(root, real) || !(await fsp.stat(real)).isFile()) {
      throw new WebError("INVALID_ASSET", "源资产不能通过链接离开资产目录。", 400);
    }
    return real;
  }

  async listAssets(): Promise<AssetInfo[]> {
    const entries = await fsp.readdir(this.config.assetsDir, { withFileTypes: true });
    const assets: AssetInfo[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".blend")) continue;
      const source = await this.resolveAsset(entry.name);
      const stat = await fsp.stat(source);
      const previews: AssetInfo["previews"] = {};
      for (const view of (await findAssetPreviews(this.config.assetsDir, entry.name)).keys()) {
        previews[view] = `/api/assets/${encodeURIComponent(entry.name)}/previews/${view}`;
      }
      assets.push({ id: entry.name, name: entry.name, size: stat.size, mtime: stat.mtimeMs, previews });
    }
    return assets.sort((a, b) => a.name.localeCompare(b.name));
  }

  private async baseArgs(assetId: string, instruction: string, runId: string): Promise<string[]> {
    const source = await this.resolveAsset(assetId);
    const args = [
      "agent",
      "--source", source,
      "--instruction", instruction,
      "--run-dir", this.runDirectory(runId),
      "--plan-output", this.planPath(runId),
      "--inspect-cache-dir", inspectCacheDirectory(this.config),
      "--planner", this.config.planner,
      "--model", this.config.model,
      "--blender-timeout", String(this.config.blenderTimeoutSeconds),
    ];
    if (this.config.blender) args.push("--blender", this.config.blender);
    return args;
  }

  private validateInstruction(instruction: string): string {
    const value = instruction.trim();
    if (!value) throw new WebError("EMPTY_INSTRUCTION", "请输入一条局部编辑指令。", 400);
    if (value.length > this.config.maxInstructionLength) {
      throw new WebError("INSTRUCTION_TOO_LONG", `指令不能超过 ${this.config.maxInstructionLength} 个字符。`, 400);
    }
    return value;
  }

  private async toPlanReview(runId: string, raw: RawPlan, resolution?: PlanResolution): Promise<PlanReview> {
    return {
      planId: runId,
      sha256: await fileSha256(this.planPath(runId)),
      status: raw.status,
      instruction: raw.instruction ?? "",
      assetId: path.basename(raw.source_file ?? ""),
      proposal: raw.proposal ?? null,
      planner: raw.planner ?? {},
      sourceSha256: raw.source_sha256 ?? "",
      summarySha256: raw.summary_sha256,
      inspection: raw.inspection,
      request: raw.request,
      error: raw.error,
      resolution,
    };
  }

  private async readPlan(runId: string, resolution?: PlanResolution): Promise<PlanReview | null> {
    const raw = await readJson<RawPlan>(this.planPath(runId));
    const savedResolution = resolution ?? await readJson<PlanResolution>(path.join(this.config.runsDir, `${runId}.resolution.json`));
    return raw ? this.toPlanReview(runId, raw, savedResolution ?? undefined) : null;
  }

  async createPlan(assetId: string, rawInstruction: string): Promise<PlanReview> {
    const instruction = this.validateInstruction(rawInstruction);
    await this.resolveAsset(assetId);
    const runId = `web-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
    const args = await this.baseArgs(assetId, instruction, runId);
    const result = await this.runCommand(args);
    const plan = await this.readPlan(runId);
    if (!plan) throw processFailure(result, "规划失败，且未生成机器可读计划。");
    if (result.code !== 0 && !["NEEDS_CONFIRMATION", "NOT_EXECUTABLE", "FAILED"].includes(plan.status)) {
      throw processFailure(result, "规划进程异常结束。");
    }
    return plan;
  }

  async assertCurrentPlanHash(plan: PlanReview): Promise<void> {
    const actual = await fileSha256(this.planPath(plan.planId)).catch(() => {
      throw new WebError("PLAN_NOT_FOUND", "计划文件不存在。", 404);
    });
    if (actual !== plan.sha256) {
      throw new WebError("PLAN_APPROVAL_MISMATCH", "计划文件已变化，请重新生成并审阅计划。", 409, {
        expected: plan.sha256,
        actual,
      });
    }
  }

  async resolvePlan(plan: PlanReview, resolution: PlanResolution): Promise<PlanReview> {
    if (plan.status !== "NEEDS_CONFIRMATION") {
      throw new WebError("PLAN_NOT_RESOLVABLE", "只有需要确认的计划可以执行确认解析。", 409);
    }
    if (!resolution.confirmTarget && !resolution.approveLowConfidence) {
      throw new WebError("CONFIRMATION_REQUIRED", "请选择候选目标或明确批准低置信度计划。", 400);
    }
    await this.assertCurrentPlanHash(plan);
    const args = await this.baseArgs(plan.assetId, plan.instruction, plan.planId);
    args.push("--plan-input", this.planPath(plan.planId));
    const combined = { ...plan.resolution, ...resolution };
    if (combined.confirmTarget) args.push("--confirm-target", combined.confirmTarget);
    if (combined.approveLowConfidence) args.push("--approve-low-confidence");
    const result = await this.runCommand(args);
    const resolved = await this.readPlan(plan.planId, combined);
    if (!resolved) throw processFailure(result, "确认解析失败，且未生成计划。");
    if (result.code !== 0 || !["READY", "NEEDS_CONFIRMATION"].includes(resolved.status)) {
      throw processFailure(result, "确认解析失败，请检查计划错误。");
    }
    if (resolved.status === "READY" && !resolved.request) {
      throw processFailure(result, "READY 计划缺少完整契约。");
    }
    await fsp.writeFile(
      path.join(this.config.runsDir, `${plan.planId}.resolution.json`),
      JSON.stringify(combined, null, 2),
      { encoding: "utf8", flag: "w" },
    );
    return resolved;
  }

  async executePlan(plan: PlanReview): Promise<{ command: CommandResult; result: Record<string, unknown> | null }> {
    if (plan.status !== "READY" || !plan.request) {
      throw new WebError("PLAN_NOT_READY", "只有包含完整契约的 READY 计划可以执行。", 409);
    }
    await this.assertCurrentPlanHash(plan);
    const args = await this.baseArgs(plan.assetId, plan.instruction, plan.planId);
    args.push("--plan-input", this.planPath(plan.planId), "--execute");
    if (plan.resolution?.confirmTarget) args.push("--confirm-target", plan.resolution.confirmTarget);
    if (plan.resolution?.approveLowConfidence) args.push("--approve-low-confidence");
    const command = await this.runCommand(args);
    const result = await readJson<Record<string, unknown>>(path.join(this.runDirectory(plan.planId), "result.json"));
    if (!result && command.code !== 0) throw processFailure(command, "执行失败，且未生成运行结果。");
    return { command, result };
  }

  async verifyPlan(plan: PlanReview): Promise<{ command: CommandResult; report: VerificationReport | null }> {
    const command = await this.runCommand([
      "verify",
      "--run-dir", this.runDirectory(plan.planId),
      "--blender-timeout", String(this.config.blenderTimeoutSeconds),
      ...(this.config.blender ? ["--blender", this.config.blender] : []),
    ]);
    const report = await readJson<VerificationReport>(
      path.join(this.runDirectory(plan.planId), "reports", "independent_verification.json"),
    );
    if (!report && command.code !== 0) throw processFailure(command, "独立复验失败，且未生成复验报告。");
    return { command, report };
  }

  async getRunDetail(runId: string): Promise<RunDetail> {
    assertRunId(runId);
    const runDir = this.runDirectory(runId);
    const stat = await fsp.stat(runDir).catch(() => {
      throw new WebError("RUN_NOT_FOUND", "运行记录不存在。", 404);
    });
    if (!stat.isDirectory()) throw new WebError("RUN_NOT_FOUND", "运行记录不存在。", 404);
    const plan = await this.readPlan(runId);
    const result = await readJson<Record<string, unknown>>(path.join(runDir, "result.json"));
    const quality = await readJson<QualityReport>(path.join(runDir, "delivery", "quality_report.json"));
    const verification = await readJson<VerificationReport>(
      path.join(runDir, "reports", "independent_verification.json"),
    );
    const verified = verification?.status === "VERIFIED";
    const glbPath = path.join(runDir, "delivery", "output.glb");
    const hasGlb = verified && await exists(glbPath);
    const glbStat = hasGlb ? await fsp.stat(glbPath) : null;
    const downloads: RunDetail["downloads"] = {};
    if (plan) downloads.plan = `/api/runs/${encodeURIComponent(runId)}/artifacts/plan`;
    if (verification) downloads.verification = `/api/runs/${encodeURIComponent(runId)}/artifacts/verification`;
    if (verified) {
      downloads.blend = `/api/runs/${encodeURIComponent(runId)}/artifacts/blend`;
      downloads.quality = `/api/runs/${encodeURIComponent(runId)}/artifacts/quality`;
      if (hasGlb) downloads.glb = `/api/runs/${encodeURIComponent(runId)}/artifacts/glb`;
    }
    return {
      runId,
      assetId: plan?.assetId ?? "",
      instruction: plan?.instruction ?? String(result?.instruction ?? ""),
      status: verification?.status ?? String(result?.status ?? plan?.status ?? "UNKNOWN"),
      createdAt: stat.birthtimeMs || stat.mtimeMs,
      hasGlb,
      verified,
      plan,
      result,
      quality,
      verification,
      scene: hasGlb ? {
        url: `${downloads.glb}?v=${Math.floor(glbStat?.mtimeMs ?? 0)}`,
        version: Math.floor(glbStat?.mtimeMs ?? 0),
        at: Date.now(),
        kind: "verified",
        runId,
      } : null,
      downloads,
    };
  }

  async listRuns(): Promise<RunSummary[]> {
    await fsp.mkdir(this.config.runsDir, { recursive: true });
    const entries = await fsp.readdir(this.config.runsDir, { withFileTypes: true });
    const runs: RunSummary[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^web-[a-z0-9-]{1,80}$/.test(entry.name)) continue;
      try {
        const detail = await this.getRunDetail(entry.name);
        const { runId, assetId, instruction, status, createdAt, hasGlb, verified } = detail;
        runs.push({ runId, assetId, instruction, status, createdAt, hasGlb, verified });
      } catch {
        // A partial or externally damaged run must not prevent other history from loading.
      }
    }
    return runs.sort((a, b) => b.createdAt - a.createdAt);
  }
}

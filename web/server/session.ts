import type { PlanResolution, PlanReview, RunDetail } from "../shared/types";
import type { BlendGuardClient } from "./blendguard";
import { asWebError, WebError } from "./errors";
import type { WorkbenchHub } from "./events";
import { ProgressTailer } from "./progress";

export class WorkbenchSession {
  constructor(private readonly client: BlendGuardClient, private readonly hub: WorkbenchHub) {}

  async initialize(): Promise<void> {
    this.hub.assets = await this.client.listAssets();
    this.hub.setRuns(await this.client.listRuns());
    this.hub.setStatus({ blender: this.client.blenderState() });
  }

  private assertIdle(): void {
    if (this.hub.status.busy) throw new WebError("SESSION_BUSY", "当前任务尚未结束，请等待真实执行与复验完成。", 409);
  }

  private currentPlan(planId: string, sha256: string): PlanReview {
    const plan = this.hub.plan;
    if (!plan || plan.planId !== planId) throw new WebError("PLAN_NOT_FOUND", "当前会话没有这份计划。", 404);
    if (!sha256 || sha256 !== plan.sha256) {
      throw new WebError("PLAN_APPROVAL_MISMATCH", "页面计划哈希与服务端当前计划不一致，请刷新后重新审阅。", 409);
    }
    return plan;
  }

  private fail(error: unknown): void {
    const failure = asWebError(error);
    this.hub.setStatus({ busy: false, phase: "FAILED" });
    this.hub.addEntry({ kind: "error", text: `${failure.code}：${failure.message}` });
  }

  async createPlan(assetId: string, instruction: string): Promise<PlanReview> {
    this.assertIdle();
    this.hub.setPlan(null);
    this.hub.setRun(null);
    this.hub.setScene(null);
    this.hub.setStatus({ phase: "PLANNING", busy: true, assetId, planId: null, runId: null });
    this.hub.addEntry({ kind: "user", text: instruction });
    this.hub.addEntry({ kind: "system", text: "正在只读检查源场景并生成计划，本步骤不会修改工程。" });
    try {
      const plan = await this.client.createPlan(assetId, instruction);
      this.hub.setPlan(plan);
      this.hub.setStatus({
        phase: plan.status === "READY" ? "AWAITING_REVIEW" : plan.status === "NEEDS_CONFIRMATION" ? "NEEDS_CONFIRMATION" : "FAILED",
        busy: false,
        planId: plan.planId,
        blender: "connected",
      });
      if (plan.status === "READY") {
        this.hub.addEntry({ kind: "system", text: "计划已生成。请审阅契约、写集与计划哈希，再明确执行。" });
      } else if (plan.status === "NEEDS_CONFIRMATION") {
        this.hub.addEntry({ kind: "system", text: "计划需要确认。确认后仍只生成完整计划，不会自动执行。" });
      } else {
        this.hub.addEntry({ kind: "error", text: `${plan.error?.code ?? "NOT_EXECUTABLE"}：${plan.error?.message ?? "计划不可执行"}` });
      }
      return plan;
    } catch (error) {
      this.fail(error);
      throw error;
    }
  }

  async resolvePlan(planId: string, sha256: string, resolution: PlanResolution): Promise<PlanReview> {
    this.assertIdle();
    const plan = this.currentPlan(planId, sha256);
    this.hub.setStatus({ phase: "RESOLVING", busy: true });
    this.hub.addEntry({ kind: "system", text: "正在把确认选择绑定到同一计划，仅解析契约，不执行编辑。" });
    try {
      const resolved = await this.client.resolvePlan(plan, resolution);
      this.hub.setPlan(resolved);
      this.hub.setStatus({
        phase: resolved.status === "READY" ? "AWAITING_REVIEW" : "NEEDS_CONFIRMATION",
        busy: false,
      });
      this.hub.addEntry({
        kind: "system",
        text: resolved.status === "READY"
          ? "确认后的完整契约已生成，计划哈希已更新。请再次审阅后执行。"
          : "本次确认已绑定，但计划还需要另一项人工确认；仍不会自动执行。",
      });
      return resolved;
    } catch (error) {
      this.fail(error);
      throw error;
    }
  }

  async executePlan(planId: string, sha256: string): Promise<RunDetail> {
    this.assertIdle();
    const plan = this.currentPlan(planId, sha256);
    if (this.hub.status.phase !== "AWAITING_REVIEW") {
      throw new WebError("PLAN_NOT_IN_REVIEW", "只有仍处于契约审阅阶段的计划可以执行；已完成或历史运行不能重复执行。", 409);
    }
    const progress = new ProgressTailer(this.client.runDirectory(planId), plan, this.hub);
    this.hub.setRun(null);
    this.hub.setScene(null);
    this.hub.setStatus({ phase: "EXECUTING", busy: true, runId: planId });
    this.hub.addEntry({ kind: "system", text: `正在执行已审阅计划 ${sha256.slice(0, 12)}…，契约与写集不可由页面扩大。` });
    progress.start();
    try {
      const execution = await this.client.executePlan(plan);
      const committed = execution.command.code === 0 && execution.result?.status === "COMMITTED";
      const committedRun = await this.client.getRunDetail(planId).catch(() => null);
      if (committedRun) this.hub.setRun(committedRun);
      if (!committed) {
        throw new WebError("RUNNER_NOT_COMMITTED", "Runner 未提交本次运行，不会进入独立复验或发布交付。", 502, {
          status: execution.result?.status,
          exitCode: execution.command.code,
        });
      }
      this.hub.setStatus({ phase: "COMMITTED", busy: true });
      this.hub.addEntry({ kind: "system", text: "Runner 已提交（COMMITTED）。此状态尚未经过独立复验。" });
      this.hub.setStatus({ phase: "VERIFYING", busy: true });
      this.hub.addEntry({ kind: "system", text: "正在新 Blender 进程中重新计算哈希、目标、局部性和 GLB。" });
      const verification = await this.client.verifyPlan(plan);
      const detail = await this.client.getRunDetail(planId);
      this.hub.setRun(detail);
      this.hub.setRuns(await this.client.listRuns());
      if (verification.command.code !== 0 || verification.report?.status !== "VERIFIED" || !detail.verified) {
        throw new WebError("INDEPENDENT_VERIFICATION_FAILED", "独立复验未通过，交付不会发布。", 502, {
          status: verification.report?.status,
          exitCode: verification.command.code,
        });
      }
      this.hub.setStatus({ phase: "VERIFIED", busy: false });
      this.hub.setScene(detail.scene);
      this.hub.addEntry({ kind: "system", text: "独立复验通过（VERIFIED）。已发布报告、工程和可用的 GLB 预览。" });
      return detail;
    } catch (error) {
      this.hub.setScene(null);
      this.hub.setRuns(await this.client.listRuns().catch(() => this.hub.runs));
      this.fail(error);
      throw error;
    } finally {
      await progress.stop();
      this.hub.setStatus({ busy: false });
    }
  }

  async loadRun(runId: string): Promise<RunDetail> {
    this.assertIdle();
    const detail = await this.client.getRunDetail(runId);
    this.hub.setPlan(detail.plan);
    this.hub.setRun(detail);
    this.hub.setScene(detail.scene);
    this.hub.setStatus({
      phase: detail.verified ? "VERIFIED" : "FAILED",
      busy: false,
      assetId: detail.assetId,
      planId: detail.plan?.planId ?? null,
      runId,
    });
    return detail;
  }

  reset(): void {
    this.assertIdle();
    this.hub.clear();
    this.hub.setStatus({ phase: "IDLE", busy: false, assetId: null, planId: null, runId: null });
  }
}

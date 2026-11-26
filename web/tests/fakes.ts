import path from "node:path";
import type { AppConfig } from "../server/config";
import type { PlanReview, RunDetail, VerificationReport, WorkStatus } from "../shared/types";
import type { BlendGuardClient } from "../server/blendguard";
import type { CommandResult } from "../server/process";
import { WorkbenchHub } from "../server/events";

export function makeConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const rootDir = path.resolve(".");
  return {
    rootDir,
    webRoot: path.join(rootDir, "web"),
    distDir: path.join(rootDir, "web", "dist"),
    assetsDir: path.join(rootDir, "assets"),
    runsDir: path.join(rootDir, "runs", "web"),
    python: "python",
    blender: undefined,
    planner: "deterministic",
    model: "test-model",
    port: 8787,
    blenderTimeoutSeconds: 300,
    processTimeoutMs: 20_000,
    maxProcessOutput: 1_000_000,
    maxInstructionLength: 1000,
    ...overrides,
  };
}

export function makePlan(overrides: Partial<PlanReview> = {}): PlanReview {
  const planId = overrides.planId ?? "web-test-1";
  return {
    planId,
    sha256: "a".repeat(64),
    status: "READY",
    instruction: "将 server_03 下移 1U",
    assetId: "teaching_rack.blend",
    proposal: {
      action: "move_part",
      target_query: "server_03",
      confidence: 0.99,
      rationale: "测试计划",
      parameters: { axis: "z", distance: -0.04445 },
    },
    planner: { id: "deterministic" },
    sourceSha256: "b".repeat(64),
    summarySha256: "c".repeat(64),
    request: {
      source_file: "assets/teaching_rack.blend",
      run_dir: `runs/web/${planId}`,
      contract: {
        contract_version: "1.0",
        scene_ir_version: "1.0",
        run_id: planId,
        source_sha256: "b".repeat(64),
        instruction: "将 server_03 下移 1U",
        targets: ["obj_target"],
        dependencies: ["obj_dependency"],
        write_set: ["scene.objects.obj_target.local_transform.location"],
        derived_allowances: [{ path: "scene.objects.obj_dependency.world_matrix" }],
        freeze_set: ["scene.camera"],
        constraints: [{ type: "translation_delta", expected: -0.04445 }],
        retry_budget: 1,
        export: { enabled: true, profile: "delivery" },
      },
      operations: [{ operation_id: "op_1", tool: "move_part", arguments: { target: "obj_target" } }],
    },
    ...overrides,
  };
}

export function makeVerification(overrides: Partial<VerificationReport> = {}): VerificationReport {
  return {
    status: "VERIFIED",
    run_id: "web-test-1",
    blender_version: "4.4.3",
    hashes: [{ check: "source_sha256", status: "passed", measured: "b".repeat(64) }],
    targets: { status: "passed", checks: [{ id: "translation_delta", status: "passed", measured: -0.04445 }] },
    locality: { status: "passed", unauthorized_changes: [] },
    export: { status: "passed", checks: [{ id: "glb", status: "passed" }] },
    ...overrides,
  };
}

export function makeRun(overrides: Partial<RunDetail> = {}): RunDetail {
  const plan = overrides.plan === undefined ? makePlan() : overrides.plan;
  const verification = overrides.verification === undefined ? makeVerification() : overrides.verification;
  const verified = overrides.verified ?? verification?.status === "VERIFIED";
  const runId = overrides.runId ?? plan?.planId ?? "web-test-1";
  return {
    runId,
    assetId: plan?.assetId ?? "teaching_rack.blend",
    instruction: plan?.instruction ?? "将 server_03 下移 1U",
    status: verification?.status ?? "COMMITTED",
    createdAt: Date.now(),
    hasGlb: verified,
    verified,
    plan,
    result: { status: "COMMITTED" },
    quality: {
      status: "COMMITTED",
      run_id: runId,
      targets: { status: "passed", checks: [] },
      locality: { status: "passed", unauthorized_changes: [] },
      export: { status: "passed", checks: [] },
      coverage_notes: [],
    },
    verification,
    scene: verified ? {
      url: `/api/runs/${runId}/artifacts/glb?v=1`,
      version: 1,
      at: Date.now(),
      kind: "verified",
      runId,
    } : null,
    downloads: verified ? {
      blend: `/api/runs/${runId}/artifacts/blend`,
      glb: `/api/runs/${runId}/artifacts/glb`,
      quality: `/api/runs/${runId}/artifacts/quality`,
      verification: `/api/runs/${runId}/artifacts/verification`,
      plan: `/api/runs/${runId}/artifacts/plan`,
    } : {
      verification: `/api/runs/${runId}/artifacts/verification`,
      plan: `/api/runs/${runId}/artifacts/plan`,
    },
    ...overrides,
  };
}

export function makeHub(status: Partial<WorkStatus> = {}): WorkbenchHub {
  return new WorkbenchHub({
    phase: "IDLE",
    busy: false,
    blender: "connected",
    planner: { id: "deterministic", label: "离线教学规划器（非 LLM）", isLlm: false },
    assetId: null,
    planId: null,
    runId: null,
    ...status,
  });
}

export class FakeClient {
  createResult = makePlan();
  resolveResult = makePlan({ sha256: "d".repeat(64) });
  run = makeRun();
  execution: { command: CommandResult; result: Record<string, unknown> | null } = {
    command: { code: 0, stdout: "", stderr: "" },
    result: { status: "COMMITTED" },
  };
  verification: { command: CommandResult; report: VerificationReport | null } = {
    command: { code: 0, stdout: "", stderr: "" },
    report: makeVerification(),
  };
  calls: string[] = [];
  createGate: Promise<void> | null = null;
  verifyGate: Promise<void> | null = null;

  blenderState(): "connected" { return "connected"; }
  runDirectory(runId: string): string { return path.join(makeConfig().runsDir, runId); }
  async listAssets() { return []; }
  async listRuns() { return [this.run]; }
  async createPlan(): Promise<PlanReview> {
    this.calls.push("create");
    await this.createGate;
    return this.createResult;
  }
  async resolvePlan(): Promise<PlanReview> {
    this.calls.push("resolve");
    return this.resolveResult;
  }
  async executePlan() {
    this.calls.push("execute");
    return this.execution;
  }
  async verifyPlan() {
    this.calls.push("verify");
    await this.verifyGate;
    return this.verification;
  }
  async getRunDetail(): Promise<RunDetail> {
    this.calls.push("detail");
    return this.run;
  }
}

export function asClient(fake: FakeClient): BlendGuardClient {
  return fake as unknown as BlendGuardClient;
}

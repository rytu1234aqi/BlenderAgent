import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { BlendGuardClient } from "./blendguard";
import { resolveArtifact, resolveAssetPreview } from "./artifacts";
import { fileSha256 } from "./files";
import type { CommandResult, CommandRunner } from "./process";
import type { PlanReview } from "../shared/types";
import { makeConfig, makePlan } from "../tests/fakes";
import type { WebError } from "./errors";

async function workspace(t: import("node:test").TestContext) {
  const rootDir = await fsp.mkdtemp(path.join(os.tmpdir(), "blendguard-web-test-"));
  t.after(() => fsp.rm(rootDir, { recursive: true, force: true }));
  const assetsDir = path.join(rootDir, "assets");
  const runsDir = path.join(rootDir, "runs", "web");
  await fsp.mkdir(assetsDir, { recursive: true });
  await fsp.mkdir(runsDir, { recursive: true });
  await fsp.writeFile(path.join(assetsDir, "teaching_rack.blend"), "test blend");
  return { rootDir, config: makeConfig({ rootDir, assetsDir, runsDir, distDir: path.join(rootDir, "dist") }) };
}

function rawPlan(plan: PlanReview, source: string) {
  return {
    status: plan.status,
    planner: plan.planner,
    instruction: plan.instruction,
    proposal: plan.proposal,
    source_file: source,
    source_sha256: plan.sourceSha256,
    summary_sha256: plan.summarySha256,
    request: plan.request,
    error: plan.error,
  };
}

function argument(args: string[], name: string): string {
  const index = args.indexOf(name);
  assert.notEqual(index, -1, `missing ${name}`);
  return args[index + 1];
}

const ok: CommandResult = { code: 0, stdout: "", stderr: "" };

test("client creates a plan without --execute", async (t) => {
  const { config } = await workspace(t);
  let captured: string[] = [];
  const runner: CommandRunner = async (args) => {
    captured = args;
    const output = argument(args, "--plan-output");
    const runId = path.basename(output).replace(/\.plan\.json$/, "");
    const plan = makePlan({ planId: runId });
    await fsp.writeFile(output, JSON.stringify(rawPlan(plan, argument(args, "--source"))));
    return ok;
  };
  const client = new BlendGuardClient(config, runner);
  const plan = await client.createPlan("teaching_rack.blend", "将 server_03 下移 1U");
  assert.equal(plan.status, "READY");
  assert.equal(captured.includes("--execute"), false);
  assert.equal(captured[0], "agent");
  assert.equal(argument(captured, "--planner"), "deterministic");
  assert.equal(plan.sha256, await fileSha256(client.planPath(plan.planId)));
});

test("client forwards the selected DeepSeek provider and model", async (t) => {
  const { config: deterministicConfig } = await workspace(t);
  const config = { ...deterministicConfig, planner: "deepseek" as const, model: "deepseek-test-model" };
  let captured: string[] = [];
  const runner: CommandRunner = async (args) => {
    captured = args;
    const output = argument(args, "--plan-output");
    const runId = path.basename(output).replace(/\.plan\.json$/, "");
    const plan = makePlan({ planId: runId });
    await fsp.writeFile(output, JSON.stringify(rawPlan(plan, argument(args, "--source"))));
    return ok;
  };
  const client = new BlendGuardClient(config, runner);
  await client.createPlan("teaching_rack.blend", "将 server_03 下移 1U");
  assert.equal(argument(captured, "--planner"), "deepseek");
  assert.equal(argument(captured, "--model"), "deepseek-test-model");
});

test("multiple confirmations persist and are replayed for the same reviewed plan", async (t) => {
  const { config } = await workspace(t);
  const source = path.join(config.assetsDir, "teaching_rack.blend");
  const invocations: string[][] = [];
  let stage = "create";
  const runner: CommandRunner = async (args) => {
    invocations.push(args);
    const output = argument(args, "--plan-output");
    const runId = path.basename(output).replace(/\.plan\.json$/, "");
    if (stage === "create") {
      const pending = makePlan({ planId: runId, status: "NEEDS_CONFIRMATION", request: undefined });
      await fsp.writeFile(output, JSON.stringify(rawPlan(pending, source)));
    } else if (stage === "target") {
      const pending = makePlan({
        planId: runId,
        status: "NEEDS_CONFIRMATION",
        request: undefined,
        error: { code: "CONFIRMATION_REQUIRED", message: "还需要批准低置信度" },
      });
      await fsp.writeFile(output, JSON.stringify(rawPlan(pending, source)));
    } else if (stage === "confidence") {
      const ready = makePlan({ planId: runId });
      await fsp.writeFile(output, JSON.stringify(rawPlan(ready, source)));
    } else {
      await fsp.mkdir(argument(args, "--run-dir"), { recursive: true });
      await fsp.writeFile(path.join(argument(args, "--run-dir"), "result.json"), JSON.stringify({ status: "COMMITTED" }));
    }
    return ok;
  };
  const client = new BlendGuardClient(config, runner);
  const pending = await client.createPlan("teaching_rack.blend", "将 server_03 下移 1U");
  stage = "target";
  const targetResolved = await client.resolvePlan(pending, { confirmTarget: "obj_target" });
  assert.equal(targetResolved.status, "NEEDS_CONFIRMATION");
  assert.equal(invocations[1].includes("--execute"), false);
  stage = "confidence";
  const ready = await client.resolvePlan(targetResolved, { approveLowConfidence: true });
  assert.equal(ready.status, "READY");
  assert.deepEqual(ready.resolution, { confirmTarget: "obj_target", approveLowConfidence: true });
  assert.ok(invocations[2].includes("--confirm-target"));
  assert.ok(invocations[2].includes("--approve-low-confidence"));
  assert.equal(invocations[2].includes("--execute"), false);

  const restarted = new BlendGuardClient(config, runner);
  await fsp.mkdir(restarted.runDirectory(ready.planId), { recursive: true });
  const detail = await restarted.getRunDetail(ready.planId);
  assert.deepEqual(detail.plan?.resolution, ready.resolution);
  stage = "execute";
  await restarted.executePlan(detail.plan!);
  const executionArgs = invocations[3];
  assert.ok(executionArgs.includes("--execute"));
  assert.equal(argument(executionArgs, "--plan-input"), restarted.planPath(ready.planId));
  assert.equal(argument(executionArgs, "--confirm-target"), "obj_target");
  assert.ok(executionArgs.includes("--approve-low-confidence"));
  for (const args of invocations) {
    assert.equal(argument(args, "--inspect-cache-dir"), path.join(config.runsDir, ".inspect-cache"));
  }
});

test("changing the plan file invalidates the reviewed hash", async (t) => {
  const { config } = await workspace(t);
  const runner: CommandRunner = async (args) => {
    const output = argument(args, "--plan-output");
    const plan = makePlan({ planId: path.basename(output).replace(/\.plan\.json$/, "") });
    await fsp.writeFile(output, JSON.stringify(rawPlan(plan, argument(args, "--source"))));
    return ok;
  };
  const client = new BlendGuardClient(config, runner);
  const plan = await client.createPlan("teaching_rack.blend", "将 server_03 下移 1U");
  await fsp.appendFile(client.planPath(plan.planId), "\n");
  await assert.rejects(client.executePlan(plan), (error) => (error as WebError).code === "PLAN_APPROVAL_MISMATCH");
});

test("asset and run identifiers cannot escape their roots", async (t) => {
  const { config } = await workspace(t);
  const client = new BlendGuardClient(config, async () => ok);
  await assert.rejects(client.resolveAsset("../teaching_rack.blend"), (error) => (error as WebError).code === "INVALID_ASSET");
  await assert.rejects(client.resolveAsset(path.resolve(config.assetsDir, "teaching_rack.blend")), (error) => (error as WebError).code === "INVALID_ASSET");
  assert.throws(() => client.runDirectory("../outside"), (error) => (error as WebError).code === "INVALID_RUN_ID");
  await assert.rejects(resolveArtifact(client, "../outside", "blend"), (error) => (error as WebError).code === "INVALID_RUN_ID");
  await assert.rejects(resolveArtifact(client, "web-test-1", "../../secret"), (error) => (error as WebError).code === "ARTIFACT_NOT_FOUND");
});

test("asset listing and preview delivery use each asset's manifest", async (t) => {
  const { config } = await workspace(t);
  const assets = config.assetsDir;
  await fsp.writeFile(path.join(assets, "workshop.blend"), "other blend");
  await fsp.writeFile(path.join(assets, "plain.blend"), "blend without previews");
  await fsp.mkdir(path.join(assets, "previews"));
  await fsp.mkdir(path.join(assets, "workshop-images"));
  await fsp.writeFile(path.join(assets, "previews", "front.png"), "rack front");
  await fsp.writeFile(path.join(assets, "workshop-images", "elevation.png"), "workshop front");
  await fsp.writeFile(path.join(assets, "asset_manifest.json"), JSON.stringify({
    source: "teaching_rack.blend",
    previews: { directory: "previews", views: { front: "front.png", right: "missing.png" } },
  }));
  await fsp.writeFile(path.join(assets, "workshop.manifest.json"), JSON.stringify({
    previews: { directory: "workshop-images", views: { front: "elevation.png", back: "elevation.png" } },
  }));
  const client = new BlendGuardClient(config, async () => ok);
  const listing = Object.fromEntries((await client.listAssets()).map(({ id, previews }) => [id, previews]));
  assert.deepEqual(listing, {
    "plain.blend": {},
    "teaching_rack.blend": { front: "/api/assets/teaching_rack.blend/previews/front" },
    "workshop.blend": { front: "/api/assets/workshop.blend/previews/front" },
  });
  const preview = async (asset: string) => fsp.readFile(await resolveAssetPreview(client, asset, "front"), "utf8");
  assert.equal(await preview("teaching_rack.blend"), "rack front");
  assert.equal(await preview("workshop.blend"), "workshop front");
  await assert.rejects(preview("plain.blend"), { code: "PREVIEW_NOT_FOUND" });
  await assert.rejects(resolveAssetPreview(client, "workshop.blend", "back"), { code: "PREVIEW_NOT_FOUND" });
});

test("manifest preview paths cannot traverse or link outside the assets directory", async (t) => {
  const { rootDir, config } = await workspace(t);
  const outside = path.join(rootDir, "outside");
  await fsp.mkdir(outside);
  await fsp.writeFile(path.join(outside, "front.png"), "outside asset root");
  await fsp.symlink(outside, path.join(config.assetsDir, "link"), process.platform === "win32" ? "junction" : "dir");
  await fsp.mkdir(path.join(config.assetsDir, "previews", "directory.png"), { recursive: true });
  await fsp.symlink(outside, path.join(config.assetsDir, "previews", "link.png"), process.platform === "win32" ? "junction" : "dir");
  const client = new BlendGuardClient(config, async () => ok);
  for (const previews of [
    { directory: "../outside", views: { front: "front.png" } },
    { directory: outside, views: { front: "front.png" } },
    { directory: "link", views: { front: "front.png" } },
    { directory: "previews", views: { front: "../link/front.png" } },
    { directory: "previews", views: { front: "link.png" } },
    { directory: "previews", views: { front: "directory.png" } },
  ]) {
    await fsp.writeFile(path.join(config.assetsDir, "asset_manifest.json"), JSON.stringify({ source: "teaching_rack.blend", previews }));
    assert.deepEqual((await client.listAssets())[0].previews, {});
    await assert.rejects(resolveAssetPreview(client, "teaching_rack.blend", "front"), { code: "PREVIEW_NOT_FOUND" });
  }
});

test("only VERIFIED history publishes delivery artifacts", async (t) => {
  const { config } = await workspace(t);
  const client = new BlendGuardClient(config, async () => ok);
  const runId = "web-test-1";
  const plan = makePlan({ planId: runId });
  const runDir = client.runDirectory(runId);
  await fsp.mkdir(path.join(runDir, "reports"), { recursive: true });
  await fsp.mkdir(path.join(runDir, "delivery"), { recursive: true });
  await fsp.writeFile(client.planPath(runId), JSON.stringify(rawPlan(plan, path.join(config.assetsDir, plan.assetId))));
  await fsp.writeFile(path.join(runDir, "result.json"), JSON.stringify({ status: "COMMITTED" }));
  await fsp.writeFile(path.join(runDir, "delivery", "output.blend"), "blend");
  await fsp.writeFile(path.join(runDir, "delivery", "output.glb"), "glb");
  await fsp.writeFile(path.join(runDir, "delivery", "quality_report.json"), JSON.stringify({ status: "COMMITTED", run_id: runId }));
  const reportPath = path.join(runDir, "reports", "independent_verification.json");
  await fsp.writeFile(reportPath, JSON.stringify({ status: "FAILED", run_id: runId }));

  const failed = await client.getRunDetail(runId);
  assert.equal(failed.verified, false);
  assert.equal(failed.scene, null);
  assert.equal(failed.downloads.blend, undefined);
  await assert.rejects(resolveArtifact(client, runId, "blend"), (error) => (error as WebError).code === "DELIVERY_NOT_VERIFIED");
  await assert.rejects(resolveArtifact(client, runId, "glb"), (error) => (error as WebError).code === "DELIVERY_NOT_VERIFIED");

  await fsp.writeFile(reportPath, JSON.stringify({ status: "VERIFIED", run_id: runId }));
  const verified = await client.getRunDetail(runId);
  assert.equal(verified.verified, true);
  assert.equal(verified.scene?.kind, "verified");
  assert.ok(verified.downloads.blend);
  const artifact = await resolveArtifact(client, runId, "blend");
  assert.equal(await fsp.readFile(artifact.path, "utf8"), "blend");
});

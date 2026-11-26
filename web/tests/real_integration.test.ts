import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { BlendGuardClient } from "../server/blendguard";
import { config as baseConfig } from "../server/config";
import { createApplication } from "../server/index";
import { fileSha256 } from "../server/files";
import type { PlanReview, RunDetail } from "../shared/types";

const enabled = process.env.BLENDGUARD_RUN_REAL_INTEGRATION === "1";
const blender = process.env.BLENDER_EXECUTABLE ?? baseConfig.blender;

async function freePort(): Promise<number> {
  const probe = net.createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const address = probe.address();
  assert.ok(address && typeof address === "object");
  const port = address.port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

async function post<T>(base: string, route: string, body: unknown): Promise<T> {
  const response = await fetch(`${base}${route}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-BlendGuard-Client": "workbench" },
    body: JSON.stringify(body),
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${JSON.stringify(payload)}`);
  return payload as T;
}

test("real HTTP plan, COMMITTED gate, independent verification and GLB delivery", {
  skip: enabled ? false : "Set BLENDGUARD_RUN_REAL_INTEGRATION=1 to run Blender integration",
  timeout: 600_000,
}, async (t) => {
  assert.ok(blender && fs.existsSync(blender), "A real Blender executable is required");
  const port = await freePort();
  const runsDir = await fsp.mkdtemp(path.join(os.tmpdir(), "blendguard-web-real-"));
  const config = { ...baseConfig, runsDir, port, blender, planner: "deterministic" as const };
  t.after(() => fsp.rm(runsDir, { recursive: true, force: true }));
  const client = new BlendGuardClient(config);
  const committedDetails: RunDetail[] = [];
  const verify = client.verifyPlan.bind(client);
  client.verifyPlan = async (plan) => {
    const detail = await client.getRunDetail(plan.planId);
    committedDetails.push(detail);
    assert.equal(detail.result?.status, "COMMITTED");
    assert.equal(detail.verified, false);
    assert.equal(detail.scene, null);
    assert.equal(detail.downloads.blend, undefined);
    return verify(plan);
  };
  const { app, session } = createApplication(config, client);
  await session.initialize();
  const server = app.listen(port, "127.0.0.1");
  server.requestTimeout = 1_200_000;
  await new Promise<void>((resolve) => server.once("listening", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const base = `http://127.0.0.1:${port}`;
  const source = path.join(config.assetsDir, "teaching_rack.blend");
  const sourceBefore = await fileSha256(source);
  const instruction = "rotate server_0 around z by 15 deg";

  const planned = await post<{ plan: PlanReview }>(base, "/api/plans", {
    assetId: "teaching_rack.blend",
    instruction,
  });
  const pending = planned.plan;
  assert.equal(pending.status, "NEEDS_CONFIRMATION");
  assert.equal(pending.error?.code, "TARGET_AMBIGUOUS");
  assert.equal(pending.inspection?.cache_hit, false);
  assert.deepEqual(await client.listRuns(), []);
  const candidates = pending.error?.details?.candidates as Array<{ name: string; object_id: string }>;
  const target = candidates.find((candidate) => candidate.name === "server_03");
  assert.ok(target);
  const { plan } = await post<{ plan: PlanReview }>(base, `/api/plans/${pending.planId}/resolve`, {
    sha256: pending.sha256,
    confirmTarget: target.object_id,
  });
  assert.equal(plan.status, "READY");
  assert.equal(plan.inspection?.cache_hit, true);
  assert.equal(plan.summarySha256, pending.summarySha256);
  assert.ok(plan.request?.contract.write_set.length);
  assert.equal(fs.existsSync(client.runDirectory(plan.planId)), false, "planning must not create an execution run");
  assert.equal(await fileSha256(source), sourceBefore);

  const executed = await post<{ run: RunDetail }>(base, `/api/plans/${encodeURIComponent(plan.planId)}/execute`, {
    sha256: plan.sha256,
  });
  const run = executed.run;
  assert.equal(run.plan?.inspection?.cache_hit, true);
  assert.equal(run.plan?.summarySha256, pending.summarySha256);
  const preVerification = committedDetails[0];
  assert.ok(preVerification, "the pre-verification gate was not observed");
  assert.equal(run.status, "VERIFIED");
  assert.equal(run.verified, true);
  assert.equal(run.verification?.status, "VERIFIED");
  assert.equal(run.verification?.locality?.unauthorized_changes?.length, 0);
  assert.equal(run.scene?.kind, "verified");
  assert.ok(run.downloads.blend);
  assert.ok(run.downloads.glb);
  assert.equal(await fileSha256(source), sourceBefore);

  const glbResponse = await fetch(`${base}${run.downloads.glb}`);
  assert.equal(glbResponse.status, 200);
  const glb = Buffer.from(await glbResponse.arrayBuffer());
  assert.equal(glb.subarray(0, 4).toString("ascii"), "glTF");
  assert.ok(glb.length > 1000);
  const qualityResponse = await fetch(`${base}${run.downloads.quality}`);
  assert.equal(qualityResponse.status, 200);
  const quality = await qualityResponse.json();
  assert.equal(quality.status, "COMMITTED");
  const blendResponse = await fetch(`${base}${run.downloads.blend}`);
  assert.equal(blendResponse.status, 200);
  assert.ok((await blendResponse.arrayBuffer()).byteLength > 1000);

  const evidence = {
    generated_at: new Date().toISOString(),
    planner: "deterministic",
    instruction,
    run_id: run.runId,
    plan_sha256: plan.sha256,
    source_sha256: sourceBefore,
    runner_before_verification: preVerification.result?.status,
    delivery_before_verification: preVerification.downloads,
    independent_status: run.verification?.status,
    unauthorized_changes: run.verification?.locality?.unauthorized_changes?.length,
    glb_bytes: glb.length,
    glb_sha256: await fileSha256(path.join(client.runDirectory(run.runId), "delivery", "output.glb")),
    output_blend_sha256: await fileSha256(path.join(client.runDirectory(run.runId), "delivery", "output.blend")),
  };
  const evidenceDir = path.join(path.dirname(baseConfig.runsDir), "frontend_review");
  await fsp.mkdir(evidenceDir, { recursive: true });
  await fsp.writeFile(path.join(evidenceDir, "phase4_real_integration.json"), JSON.stringify(evidence, null, 2));
  console.log(`[real-integration] ${run.runId} VERIFIED, GLB ${glb.length} bytes`);

  const protectedPlan = await post<{ plan: PlanReview }>(base, "/api/plans", {
    assetId: "teaching_rack.blend", instruction: "rotate rack around z by 15 deg",
  });
  assert.equal(protectedPlan.plan.status, "NOT_EXECUTABLE");
  assert.match(protectedPlan.plan.error?.message ?? "", /protected by the asset manifest/);
  assert.equal(fs.existsSync(client.runDirectory(protectedPlan.plan.planId)), false);

  const edits = [
    { instruction: "将 server_03 下移 1U", action: "move_part", checks: ["translation_delta", "endpoint_distance"] },
    { instruction: "create box box_01, dimensions [0.2, 0.3, 0.4], at [1, 0, 0.5]", action: "create_box",
      checks: ["object_location", "dimensions_equal", "object_count_delta"] },
  ];
  for (const edit of edits) {
    const { plan } = await post<{ plan: PlanReview }>(base, "/api/plans", {
      assetId: "teaching_rack.blend", instruction: edit.instruction,
    });
    assert.equal(plan.status, "READY");
    assert.equal(plan.proposal?.action, edit.action);
    assert.equal(plan.request?.operations[0].tool, edit.action);
    const { run: delivery } = await post<{ run: RunDetail }>(base, `/api/plans/${plan.planId}/execute`, { sha256: plan.sha256 });
    assert.equal(delivery.status, "VERIFIED");
    assert.equal(delivery.verification?.export?.status, "passed");
    assert.deepEqual(delivery.verification?.locality?.unauthorized_changes, []);
    for (const type of edit.checks) {
      assert.ok(delivery.verification?.targets?.checks?.some((check) => check.type === type && check.status === "passed"));
    }
    assert.ok(delivery.downloads.glb);
    const glbResponse = await fetch(`${base}${delivery.downloads.glb}`);
    assert.equal(glbResponse.status, 200);
    assert.equal(Buffer.from(await glbResponse.arrayBuffer()).subarray(0, 4).toString("ascii"), "glTF");
  }
  assert.equal(await fileSha256(source), sourceBefore);
});

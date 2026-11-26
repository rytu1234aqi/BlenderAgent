import assert from "node:assert/strict";
import { test } from "node:test";
import { WorkbenchSession } from "./session";
import { asClient, FakeClient, makeHub, makePlan, makeRun, makeVerification } from "../tests/fakes";
import type { WebError } from "./errors";

function errorCode(error: unknown): string {
  return (error as WebError).code;
}

test("READY planning never executes automatically", async () => {
  const fake = new FakeClient();
  const hub = makeHub();
  const session = new WorkbenchSession(asClient(fake), hub);
  const plan = await session.createPlan("teaching_rack.blend", "将 server_03 下移 1U");
  assert.equal(plan.status, "READY");
  assert.equal(hub.status.phase, "AWAITING_REVIEW");
  assert.deepEqual(fake.calls, ["create"]);
  assert.equal(hub.scene, null);
});

test("confirmation resolves a new reviewable hash without executing", async () => {
  const fake = new FakeClient();
  const pending = makePlan({
    status: "NEEDS_CONFIRMATION",
    request: undefined,
    error: { code: "TARGET_AMBIGUOUS", message: "请选择目标" },
  });
  const resolved = makePlan({ sha256: "d".repeat(64), resolution: { confirmTarget: "obj_target" } });
  fake.createResult = pending;
  fake.resolveResult = resolved;
  fake.run = makeRun({ plan: resolved });
  const hub = makeHub();
  const session = new WorkbenchSession(asClient(fake), hub);

  await session.createPlan(pending.assetId, pending.instruction);
  assert.equal(hub.status.phase, "NEEDS_CONFIRMATION");
  await session.resolvePlan(pending.planId, pending.sha256, { confirmTarget: "obj_target" });
  assert.equal(hub.status.phase, "AWAITING_REVIEW");
  assert.equal(hub.plan?.sha256, resolved.sha256);
  assert.deepEqual(fake.calls, ["create", "resolve"]);

  await session.executePlan(resolved.planId, resolved.sha256);
  assert.deepEqual(fake.calls, ["create", "resolve", "execute", "detail", "verify", "detail"]);
  assert.equal(hub.status.phase, "VERIFIED");
  await assert.rejects(
    session.executePlan(resolved.planId, resolved.sha256),
    (error) => errorCode(error) === "PLAN_NOT_IN_REVIEW",
  );
  assert.equal(fake.calls.filter((call) => call === "execute").length, 1);
});

test("a second confirmation remains in NEEDS_CONFIRMATION", async () => {
  const fake = new FakeClient();
  const pending = makePlan({ status: "NEEDS_CONFIRMATION", request: undefined });
  fake.createResult = pending;
  fake.resolveResult = makePlan({
    sha256: "e".repeat(64),
    status: "NEEDS_CONFIRMATION",
    request: undefined,
    resolution: { confirmTarget: "obj_target" },
    error: { code: "CONFIRMATION_REQUIRED", message: "还需要批准低置信度" },
  });
  const hub = makeHub();
  const session = new WorkbenchSession(asClient(fake), hub);
  await session.createPlan(pending.assetId, pending.instruction);
  await session.resolvePlan(pending.planId, pending.sha256, { confirmTarget: "obj_target" });
  assert.equal(hub.status.phase, "NEEDS_CONFIRMATION");
  assert.deepEqual(fake.calls, ["create", "resolve"]);
});

test("a stale plan hash is rejected before Runner execution", async () => {
  const fake = new FakeClient();
  const hub = makeHub();
  const session = new WorkbenchSession(asClient(fake), hub);
  const plan = await session.createPlan("teaching_rack.blend", "将 server_03 下移 1U");
  await assert.rejects(
    session.executePlan(plan.planId, "0".repeat(64)),
    (error) => errorCode(error) === "PLAN_APPROVAL_MISMATCH",
  );
  assert.deepEqual(fake.calls, ["create"]);
  assert.equal(hub.status.phase, "AWAITING_REVIEW");
});

test("a busy session rejects another plan", async () => {
  const fake = new FakeClient();
  let release = () => {};
  fake.createGate = new Promise<void>((resolve) => { release = resolve; });
  const hub = makeHub();
  const session = new WorkbenchSession(asClient(fake), hub);
  const pending = session.createPlan("teaching_rack.blend", "将 server_03 下移 1U");
  await Promise.resolve();
  await assert.rejects(
    session.createPlan("teaching_rack.blend", "把 server_02 宽度改为 0.5 米"),
    (error) => errorCode(error) === "SESSION_BUSY",
  );
  release();
  await pending;
  assert.equal(fake.calls.filter((call) => call === "create").length, 1);
});

test("COMMITTED does not publish a scene while verification is pending", async () => {
  const fake = new FakeClient();
  const plan = makePlan();
  fake.createResult = plan;
  fake.run = makeRun({ plan, verified: false, verification: null, scene: null, status: "COMMITTED" });
  let release = () => {};
  fake.verifyGate = new Promise<void>((resolve) => { release = resolve; });
  const hub = makeHub();
  const session = new WorkbenchSession(asClient(fake), hub);
  await session.createPlan(plan.assetId, plan.instruction);
  const executing = session.executePlan(plan.planId, plan.sha256);
  while (!fake.calls.includes("verify")) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(hub.status.phase, "VERIFYING");
  assert.equal(hub.scene, null);
  assert.equal(hub.currentRun?.verified, false);
  fake.run = makeRun({ plan });
  fake.verification = { command: { code: 0, stdout: "", stderr: "" }, report: makeVerification() };
  release();
  await executing;
  assert.equal((hub.scene as { kind: string } | null)?.kind, "verified");
});

test("failed independent verification clears delivery and ends FAILED", async () => {
  const fake = new FakeClient();
  const plan = makePlan();
  const failedReport = makeVerification({
    status: "FAILED",
    locality: { status: "failed", unauthorized_changes: [{ path: "scene.objects.other" }] },
  });
  fake.createResult = plan;
  fake.run = makeRun({
    plan,
    verified: false,
    verification: failedReport,
    scene: null,
    hasGlb: false,
    status: "FAILED",
    downloads: { verification: "/verification" },
  });
  fake.verification = { command: { code: 1, stdout: "", stderr: "" }, report: failedReport };
  const hub = makeHub();
  const session = new WorkbenchSession(asClient(fake), hub);
  await session.createPlan(plan.assetId, plan.instruction);
  await assert.rejects(
    session.executePlan(plan.planId, plan.sha256),
    (error) => errorCode(error) === "INDEPENDENT_VERIFICATION_FAILED",
  );
  assert.equal(hub.status.phase, "FAILED");
  assert.equal(hub.scene, null);
  assert.equal(hub.currentRun?.verified, false);
  assert.equal(hub.currentRun?.downloads.blend, undefined);
});

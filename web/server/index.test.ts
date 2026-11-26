import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { test } from "node:test";
import { createApplication } from "./index";
import { asClient, FakeClient, makeConfig, makePlan } from "../tests/fakes";

async function freePort(): Promise<number> {
  const probe = net.createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const address = probe.address();
  assert.ok(address && typeof address === "object");
  const port = address.port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

async function serve(t: import("node:test").TestContext) {
  const port = await freePort();
  const fake = new FakeClient();
  const config = makeConfig({ port, distDir: `E:\\nonexistent-blendguard-dist-${port}` });
  const { app, hub } = createApplication(config, asClient(fake));
  const server = app.listen(port, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return { base: `http://127.0.0.1:${port}`, fake, hub };
}

const writeHeaders = {
  "Content-Type": "application/json",
  "X-BlendGuard-Client": "workbench",
};

test("HTTP security rejects foreign hosts, origins and missing client headers", async (t) => {
  const { base, fake } = await serve(t);
  const status = await fetch(`${base}/api/status`);
  assert.equal(status.status, 200);

  const host = await new Promise<{ status?: number; body: string }>((resolve, reject) => {
    const target = new URL(base);
    const request = http.get({
      hostname: target.hostname,
      port: target.port,
      path: "/api/status",
      headers: { Host: "evil.example" },
    }, (response) => {
      let body = "";
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => resolve({ status: response.statusCode, body }));
    });
    request.on("error", reject);
  });
  assert.equal(host.status, 403);
  assert.equal(JSON.parse(host.body).error.code, "HOST_NOT_ALLOWED");

  const origin = await fetch(`${base}/api/plans`, {
    method: "POST",
    headers: { ...writeHeaders, Origin: "https://evil.example" },
    body: JSON.stringify({ assetId: "teaching_rack.blend", instruction: "将 server_03 下移 1U" }),
  });
  assert.equal(origin.status, 403);
  assert.equal((await origin.json()).error.code, "ORIGIN_NOT_ALLOWED");

  const missingHeader = await fetch(`${base}/api/plans`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  assert.equal(missingHeader.status, 403);
  assert.equal((await missingHeader.json()).error.code, "CLIENT_HEADER_REQUIRED");

  const preflight = await fetch(`${base}/api/plans`, { method: "OPTIONS" });
  assert.equal(preflight.status, 403);
  assert.equal((await preflight.json()).error.code, "CORS_DENIED");

  const crossSite = await fetch(`${base}/api/status`, { headers: { "Sec-Fetch-Site": "cross-site" } });
  assert.equal(crossSite.status, 403);
  assert.equal((await crossSite.json()).error.code, "CROSS_SITE_DENIED");

  const valid = await fetch(`${base}/api/plans`, {
    method: "POST",
    headers: writeHeaders,
    body: JSON.stringify({ assetId: "teaching_rack.blend", instruction: "将 server_03 下移 1U" }),
  });
  assert.equal(valid.status, 200);
  assert.equal((await valid.json()).plan.status, "READY");
  assert.deepEqual(fake.calls, ["create"]);
});

test("SSE reconnect starts with a complete trusted snapshot", async (t) => {
  const { base, hub } = await serve(t);
  const plan = makePlan();
  hub.assets = [{ id: plan.assetId, name: plan.assetId, size: 10, mtime: 1, previews: {} }];
  hub.setPlan(plan);
  hub.addEntry({ kind: "system", text: "snapshot-event" });

  const response = await fetch(`${base}/api/events`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);
  const reader = response.body!.getReader();
  const first = await reader.read();
  const text = new TextDecoder().decode(first.value);
  const data = text.split("\n").find((line) => line.startsWith("data: "));
  assert.ok(data);
  const event = JSON.parse(data.slice(6));
  assert.equal(event.type, "snapshot");
  assert.equal(event.snapshot.plan.planId, plan.planId);
  assert.equal(event.snapshot.assets[0].id, plan.assetId);
  assert.equal(event.snapshot.entries[0].text, "snapshot-event");
  assert.equal(event.snapshot.status.planner.isLlm, false);
  await reader.cancel();
});

test("DeepSeek status identifies the real LLM provider and model", () => {
  const fake = new FakeClient();
  const config = makeConfig({ planner: "deepseek", model: "deepseek-flash" });
  const { hub } = createApplication(config, asClient(fake));
  assert.deepEqual(hub.status.planner, {
    id: "deepseek",
    label: "DeepSeek LLM（结构化规划）",
    isLlm: true,
    model: "deepseek-flash",
  });
});

test("invalid JSON produces a machine-readable 400", async (t) => {
  const { base } = await serve(t);
  const response = await fetch(`${base}/api/plans`, {
    method: "POST",
    headers: writeHeaders,
    body: "{not-json",
  });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.code, "INVALID_JSON");
});

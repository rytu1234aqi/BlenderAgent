import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { ProgressTailer } from "./progress";
import { makeHub, makePlan } from "../tests/fakes";

test("progress tailer retries a partial JSONL line and patches real tool completion", async (t) => {
  const runDir = await fsp.mkdtemp(path.join(os.tmpdir(), "blendguard-progress-test-"));
  t.after(() => fsp.rm(runDir, { recursive: true, force: true }));
  const reports = path.join(runDir, "attempts", "attempt_1", "reports");
  await fsp.mkdir(reports, { recursive: true });
  const file = path.join(reports, "events.jsonl");
  const started = `${JSON.stringify({ event: "tool.started", operation_id: "op_1", tool: "move_part" })}\n`;
  const finished = JSON.stringify({ event: "tool.finished", operation_id: "op_1", status: "SUCCEEDED", result: { ok: true } });
  await fsp.writeFile(file, started + finished.slice(0, 12));

  const hub = makeHub();
  const tailer = new ProgressTailer(runDir, makePlan(), hub);
  await tailer.stop();
  assert.equal(hub.snapshot().entries.length, 1);
  assert.equal(hub.snapshot().entries[0].status, "running");

  await fsp.appendFile(file, `${finished.slice(12)}\n`);
  await tailer.stop();
  assert.equal(hub.snapshot().entries.length, 1);
  assert.equal(hub.snapshot().entries[0].status, "ok");
  assert.match(hub.snapshot().entries[0].result ?? "", /"ok": true/);
});

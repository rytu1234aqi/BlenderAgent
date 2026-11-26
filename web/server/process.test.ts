import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createCommandRunner } from "./process";
import { makeConfig } from "../tests/fakes";
import type { WebError } from "./errors";

async function pythonModule(t: import("node:test").TestContext, source: string) {
  const rootDir = await fsp.mkdtemp(path.join(os.tmpdir(), "blendguard-process-test-"));
  t.after(() => fsp.rm(rootDir, { recursive: true, force: true }));
  const moduleDir = path.join(rootDir, "src", "blendguard");
  await fsp.mkdir(moduleDir, { recursive: true });
  await fsp.writeFile(path.join(moduleDir, "__init__.py"), "");
  await fsp.writeFile(path.join(moduleDir, "__main__.py"), source);
  return makeConfig({ rootDir, python: process.env.PYTHON_EXECUTABLE ?? "python" });
}

test("process arguments remain separate without a shell", async (t) => {
  const config = await pythonModule(t, "import json, sys\nprint(json.dumps(sys.argv))\n");
  const runner = createCommandRunner(config);
  const instruction = "将 server_03 下移 1U; echo SHOULD_NOT_RUN & calc";
  const result = await runner(["agent", "--instruction", instruction]);
  assert.equal(result.code, 0, result.stderr);
  const argv = JSON.parse(result.stdout);
  assert.ok(argv.includes(instruction));
  assert.equal(argv.includes("SHOULD_NOT_RUN"), false);
});

test("process output limit rejects instead of buffering unbounded output", async (t) => {
  const config = await pythonModule(t, "print('x' * 10000)\n");
  config.maxProcessOutput = 100;
  const runner = createCommandRunner(config);
  await assert.rejects(runner(["agent"]), (error) => (error as WebError).code === "PROCESS_OUTPUT_LIMIT");
});

test("host timeout does not claim a transaction rollback", async (t) => {
  const config = await pythonModule(t, "import time\ntime.sleep(10)\n");
  config.processTimeoutMs = 100;
  const runner = createCommandRunner(config);
  await assert.rejects(runner(["agent"]), (error) => {
    const failure = error as WebError;
    return failure.code === "PROCESS_TIMEOUT" && failure.message.includes("不能据此宣称已回滚");
  });
});

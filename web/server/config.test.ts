import assert from "node:assert/strict";
import { test } from "node:test";
import { resolvePlannerConfig } from "./config";

test("planner config defaults to DeepSeek without requiring a credential field", () => {
  assert.deepEqual(resolvePlannerConfig({}), { planner: "deepseek", model: "deepseek-flash" });
});

test("DeepSeek model precedence is provider-specific then generic then default", () => {
  assert.deepEqual(resolvePlannerConfig({
    BLENDGUARD_PLANNER: "deepseek",
    DEEPSEEK_MODEL: "provider-model",
    BLENDGUARD_MODEL: "generic-model",
  }), { planner: "deepseek", model: "provider-model" });
  assert.deepEqual(resolvePlannerConfig({
    BLENDGUARD_PLANNER: "deepseek",
    BLENDGUARD_MODEL: "generic-model",
  }), { planner: "deepseek", model: "generic-model" });
  assert.deepEqual(resolvePlannerConfig({
    BLENDGUARD_PLANNER: "deepseek",
    DEEPSEEK_MODEL: "  ",
    BLENDGUARD_MODEL: "",
  }), { planner: "deepseek", model: "deepseek-flash" });
});

test("Claude and deterministic retain explicit independent configuration", () => {
  assert.deepEqual(resolvePlannerConfig({ BLENDGUARD_PLANNER: "claude" }), {
    planner: "claude",
    model: "claude-opus-5-5",
  });
  assert.deepEqual(resolvePlannerConfig({
    BLENDGUARD_PLANNER: "claude",
    BLENDGUARD_MODEL: "claude-custom",
  }), { planner: "claude", model: "claude-custom" });
  assert.deepEqual(resolvePlannerConfig({
    BLENDGUARD_PLANNER: "deterministic",
    DEEPSEEK_MODEL: "must-not-leak-into-offline-mode",
  }), { planner: "deterministic", model: "deterministic" });
});

test("unknown and blank planners fail instead of falling back to offline parsing", () => {
  for (const value of ["", "   ", "DEEPSEEK", "openai", "unknown"]) {
    assert.throws(
      () => resolvePlannerConfig({ BLENDGUARD_PLANNER: value }),
      /BLENDGUARD_PLANNER/,
    );
  }
});

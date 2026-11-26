import { expect, test } from "@playwright/test";
import fsp from "node:fs/promises";
import path from "node:path";
import { makePlan } from "./fakes";

const evidenceDir = path.resolve("..", "runs", "frontend_review");

test.beforeAll(async () => {
  await fsp.mkdir(evidenceDir, { recursive: true });
});

async function openWorkbench(page: import("@playwright/test").Page) {
  await page.goto("/");
  await expect(page.getByText("离线教学规划器（非 LLM）").first()).toBeVisible();
  await expect(page.getByRole("button", { name: /teaching_rack\.blend/ }).first()).toBeVisible();
}

test("real planning requires review and never executes from the composer", async ({ page }) => {
  await openWorkbench(page);
  const preview = page.getByAltText(/总览固定预览/);
  await expect(preview).toBeVisible();
  await expect.poll(() => preview.evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0)).toBe(true);

  await page.getByRole("button", { name: "生成编辑计划" }).click();
  const execute = page.getByRole("button", { name: "执行这份已审阅计划" });
  await expect(execute).toBeVisible();
  await expect(execute).toBeDisabled();
  await expect(page.getByText("允许写入的范围")).toBeVisible();
  await expect(page.getByText("派生差异规则")).toBeVisible();
  await expect(page.getByText("类型化工具计划")).toBeVisible();
  const hashes = await page.locator(".mono").allTextContents();
  expect(hashes.some((value) => /^[a-f0-9]{64}$/.test(value))).toBe(true);
  await expect(page.getByText("计划生成", { exact: true })).toBeVisible();
  await expect(page.locator("canvas")).toHaveCount(0);
  await page.screenshot({ path: path.join(evidenceDir, "phase4_plan_review.png"), fullPage: true });

  await page.getByLabel("我已审阅当前哈希对应的目标、写集、派生规则和约束。").check();
  await expect(execute).toBeEnabled();
  await expect(page.locator("canvas")).toHaveCount(0);
});

test("target confirmation returns to full review without execution", async ({ page }) => {
  const planId = "web-ui-confirm";
  const pending = makePlan({
    planId,
    status: "NEEDS_CONFIRMATION",
    request: undefined,
    error: {
      code: "TARGET_AMBIGUOUS",
      message: "server 对应多个对象，请选择本次编辑目标。",
      details: { candidates: [
        { object_id: "obj_server_a", name: "服务器 A", type: "MESH" },
        { object_id: "obj_server_b", name: "服务器 B", type: "MESH" },
      ] },
    },
  });
  const resolved = makePlan({
    planId,
    sha256: "f".repeat(64),
    resolution: { confirmTarget: "obj_server_a" },
  });
  let executeRequested = false;
  await page.route("**/api/plans", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ plan: pending }) });
  });
  await page.route(`**/api/plans/${planId}/resolve`, async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ plan: resolved }) });
  });
  await page.route(`**/api/plans/${planId}/execute`, async (route) => {
    executeRequested = true;
    await route.fulfill({ status: 500, contentType: "application/json", body: "{}" });
  });

  await openWorkbench(page);
  await page.getByRole("button", { name: "生成编辑计划" }).click();
  await expect(page.getByText("需要人工确认")).toBeVisible();
  await page.getByRole("radio", { name: /服务器 A/ }).check();
  await page.getByRole("button", { name: "生成确认后的完整契约" }).click();
  await expect(page.getByRole("button", { name: "执行这份已审阅计划" })).toBeVisible();
  await expect(page.getByText("f".repeat(64))).toBeVisible();
  expect(executeRequested).toBe(false);
  await expect(page.getByRole("button", { name: "执行这份已审阅计划" })).toBeDisabled();
});

test("real browser execution publishes verified evidence and an interactive GLB", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await openWorkbench(page);
  await page.getByRole("button", { name: "生成编辑计划" }).click();
  const execute = page.getByRole("button", { name: "执行这份已审阅计划" });
  await expect(execute).toBeVisible();
  await page.getByLabel("我已审阅当前哈希对应的目标、写集、派生规则和约束。").check();
  await execute.click();

  await expect(page.getByRole("tab", { name: "复验证据" })).toHaveAttribute("aria-selected", "true", { timeout: 90_000 });
  await expect(page.getByText("VERIFIED", { exact: true }).first()).toBeVisible();
  await expect(page.locator("dt", { hasText: "非目标未授权差异" }).locator("xpath=following-sibling::dd[1]")).toHaveText("0");
  await expect(page.getByRole("link", { name: "Blender 工程" })).toHaveAttribute("href", /artifacts\/blend/);
  await expect(page.getByRole("link", { name: "GLB 模型" })).toHaveAttribute("href", /artifacts\/glb/);
  await expect(page.locator("canvas")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/网格 \d+ · 三角面 \d+/)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("正在加载已验证 GLB")).toHaveCount(0);
  await page.screenshot({ path: path.join(evidenceDir, "phase4_verified_workbench.png"), fullPage: true });
  await page.getByRole("tab", { name: "计划审阅" }).click();
  await expect(page.getByText("这份计划已离开审阅阶段，不能重复执行。")).toBeVisible();
  await expect(page.getByRole("button", { name: "执行这份已审阅计划" })).toHaveCount(0);
  expect(errors).toEqual([]);
});

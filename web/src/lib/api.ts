import type { ApiErrorBody, PlanResolution, PlanReview, RunDetail } from "../../shared/types";

export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  headers.set("X-BlendGuard-Client", "workbench");
  headers.set("Accept", "application/json");
  if (init?.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  let response: Response;
  try {
    response = await fetch(path, { ...init, headers });
  } catch {
    throw new Error("无法连接 BlendGuard 本地服务，请确认后端已启动。");
  }
  const body = (await response.json().catch(() => null)) as T | ApiErrorBody | null;
  if (!response.ok) {
    const error = (body as ApiErrorBody | null)?.error;
    const failure = new Error(error?.message ?? `请求失败（HTTP ${response.status}）`) as Error & {
      code?: string;
      details?: Record<string, unknown>;
    };
    failure.code = error?.code;
    failure.details = error?.details;
    throw failure;
  }
  return body as T;
}

export function createPlan(assetId: string, instruction: string): Promise<{ plan: PlanReview }> {
  return request("/api/plans", { method: "POST", body: JSON.stringify({ assetId, instruction }) });
}

export function resolvePlan(plan: PlanReview, resolution: PlanResolution): Promise<{ plan: PlanReview }> {
  return request(`/api/plans/${encodeURIComponent(plan.planId)}/resolve`, {
    method: "POST",
    body: JSON.stringify({ sha256: plan.sha256, ...resolution }),
  });
}

export function executePlan(plan: PlanReview): Promise<{ run: RunDetail }> {
  return request(`/api/plans/${encodeURIComponent(plan.planId)}/execute`, {
    method: "POST",
    body: JSON.stringify({ sha256: plan.sha256 }),
  });
}

export function loadRun(runId: string): Promise<{ run: RunDetail }> {
  return request(`/api/runs/${encodeURIComponent(runId)}`);
}

export function resetSession(): Promise<{ ok: boolean }> {
  return request("/api/session/reset", { method: "POST", body: "{}" });
}

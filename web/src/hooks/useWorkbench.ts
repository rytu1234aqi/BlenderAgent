import { useCallback, useEffect, useState } from "react";
import type {
  PlanResolution,
  PlanReview,
  RunDetail,
  ServerEvent,
  WorkbenchSnapshot,
} from "../../shared/types";
import { createPlan, executePlan, loadRun, resetSession, resolvePlan } from "../lib/api";

const INITIAL: WorkbenchSnapshot = {
  status: {
    phase: "IDLE",
    busy: false,
    blender: "unknown",
    planner: { id: "deepseek", label: "DeepSeek LLM（结构化规划）", isLlm: true, model: "deepseek-flash" },
    assetId: null,
    planId: null,
    runId: null,
  },
  assets: [],
  runs: [],
  entries: [],
  plan: null,
  currentRun: null,
  scene: null,
};

function applyEvent(snapshot: WorkbenchSnapshot, event: ServerEvent): WorkbenchSnapshot {
  switch (event.type) {
    case "snapshot":
      return event.snapshot;
    case "entry":
      return { ...snapshot, entries: [...snapshot.entries, event.entry] };
    case "patch":
      return {
        ...snapshot,
        entries: snapshot.entries.map((entry) => entry.id === event.id ? { ...entry, ...event.patch } : entry),
      };
    case "status":
      return { ...snapshot, status: event.status };
    case "plan":
      return { ...snapshot, plan: event.plan };
    case "run":
      return { ...snapshot, currentRun: event.run };
    case "runs":
      return { ...snapshot, runs: event.runs };
    case "scene":
      return { ...snapshot, scene: event.scene };
    case "clear":
      return { ...snapshot, entries: [], plan: null, currentRun: null, scene: null };
  }
}

export function useWorkbench() {
  const [snapshot, setSnapshot] = useState<WorkbenchSnapshot>(INITIAL);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    const events = new EventSource("/api/events");
    events.onopen = () => setConnected(true);
    events.onerror = () => setConnected(false);
    events.onmessage = (message) => {
      try {
        const event = JSON.parse(message.data) as ServerEvent;
        setSnapshot((current) => applyEvent(current, event));
      } catch {
        // Malformed events never change the displayed trust state.
      }
    };
    return () => events.close();
  }, []);

  const plan = useCallback(async (assetId: string, instruction: string): Promise<PlanReview> => {
    const response = await createPlan(assetId, instruction);
    setSnapshot((current) => ({
      ...current,
      plan: response.plan,
      status: {
        ...current.status,
        phase: response.plan.status === "READY" ? "AWAITING_REVIEW" : response.plan.status === "NEEDS_CONFIRMATION" ? "NEEDS_CONFIRMATION" : "FAILED",
        busy: false,
        assetId: response.plan.assetId,
        planId: response.plan.planId,
        runId: null,
      },
    }));
    return response.plan;
  }, []);

  const resolve = useCallback(async (review: PlanReview, resolution: PlanResolution): Promise<PlanReview> => {
    const response = await resolvePlan(review, resolution);
    setSnapshot((current) => ({
      ...current,
      plan: response.plan,
      status: {
        ...current.status,
        phase: response.plan.status === "READY" ? "AWAITING_REVIEW" : response.plan.status === "NEEDS_CONFIRMATION" ? "NEEDS_CONFIRMATION" : "FAILED",
        busy: false,
        assetId: response.plan.assetId,
        planId: response.plan.planId,
        runId: null,
      },
    }));
    return response.plan;
  }, []);

  const execute = useCallback(async (review: PlanReview): Promise<RunDetail> => {
    const response = await executePlan(review);
    setSnapshot((current) => ({
      ...current,
      currentRun: response.run,
      scene: response.run.scene,
      status: {
        ...current.status,
        phase: response.run.verified ? "VERIFIED" : "FAILED",
        busy: false,
        assetId: response.run.assetId,
        planId: response.run.plan?.planId ?? current.status.planId,
        runId: response.run.runId,
      },
      runs: [response.run, ...current.runs.filter((run) => run.runId !== response.run.runId)],
    }));
    return response.run;
  }, []);

  const openRun = useCallback(async (runId: string): Promise<RunDetail> => {
    const response = await loadRun(runId);
    setSnapshot((current) => ({
      ...current,
      plan: response.run.plan,
      currentRun: response.run,
      scene: response.run.scene,
      status: {
        ...current.status,
        phase: response.run.verified ? "VERIFIED" : "FAILED",
        busy: false,
        assetId: response.run.assetId,
        planId: response.run.plan?.planId ?? null,
        runId: response.run.runId,
      },
    }));
    return response.run;
  }, []);

  const reset = useCallback(async (): Promise<void> => {
    await resetSession();
    setSnapshot((current) => ({
      ...current,
      entries: [],
      plan: null,
      currentRun: null,
      scene: null,
      status: { ...current.status, phase: "IDLE", busy: false, assetId: null, planId: null, runId: null },
    }));
  }, []);

  return { snapshot, connected, plan, resolve, execute, openRun, reset };
}

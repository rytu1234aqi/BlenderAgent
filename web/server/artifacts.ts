import fsp from "node:fs/promises";
import path from "node:path";
import type { BlendGuardClient } from "./blendguard";
import type { PreviewView } from "../shared/types";
import { isPathInside } from "./config";
import { WebError } from "./errors";

export interface Artifact {
  path: string;
  contentType: string;
  fileName: string;
}

const DELIVERY_KINDS = new Set(["blend", "glb", "quality"]);

export async function resolveArtifact(client: BlendGuardClient, runId: string, kind: string): Promise<Artifact> {
  const runDir = client.runDirectory(runId);
  const definitions: Record<string, { path: string; contentType: string; fileName: string }> = {
    plan: { path: client.planPath(runId), contentType: "application/json; charset=utf-8", fileName: `${runId}.plan.json` },
    verification: { path: path.join(runDir, "reports", "independent_verification.json"), contentType: "application/json; charset=utf-8", fileName: `${runId}.verification.json` },
    blend: { path: path.join(runDir, "delivery", "output.blend"), contentType: "application/octet-stream", fileName: `${runId}.blend` },
    glb: { path: path.join(runDir, "delivery", "output.glb"), contentType: "model/gltf-binary", fileName: `${runId}.glb` },
    quality: { path: path.join(runDir, "delivery", "quality_report.json"), contentType: "application/json; charset=utf-8", fileName: `${runId}.quality.json` },
  };
  const definition = definitions[kind];
  if (!definition) throw new WebError("ARTIFACT_NOT_FOUND", "不支持的产物类型。", 404);
  if (DELIVERY_KINDS.has(kind)) {
    const detail = await client.getRunDetail(runId);
    if (!detail.verified) {
      throw new WebError("DELIVERY_NOT_VERIFIED", "只有独立复验通过的交付可以下载或预览。", 409);
    }
  }
  const root = await fsp.realpath(client.config.runsDir);
  const real = await fsp.realpath(definition.path).catch(() => {
    throw new WebError("ARTIFACT_NOT_FOUND", "产物文件不存在。", 404);
  });
  if (!isPathInside(root, real) || !(await fsp.stat(real)).isFile()) {
    throw new WebError("ARTIFACT_NOT_FOUND", "产物路径越界或不是文件。", 404);
  }
  return { ...definition, path: real };
}

const PREVIEW_VIEWS: readonly PreviewView[] = ["overview", "front", "right", "cable"];

interface AssetManifest {
  source?: unknown;
  previews?: { directory?: unknown; views?: Partial<Record<PreviewView, unknown>> };
}

async function containedPath(root: string, candidate: string): Promise<string | null> {
  if (!isPathInside(root, candidate)) return null;
  const real = await fsp.realpath(candidate).catch(() => null);
  return real && isPathInside(root, real) ? real : null;
}

async function assetManifest(root: string, assetId: string): Promise<AssetManifest | null> {
  const sidecar = `${path.parse(assetId).name}.manifest.json`;
  for (const filename of [sidecar, "asset_manifest.json"]) {
    const manifest = await containedPath(root, path.join(root, filename));
    if (!manifest || !(await fsp.stat(manifest)).isFile()) continue;
    const data: AssetManifest | null = await fsp.readFile(manifest, "utf8").then(JSON.parse).catch(() => null);
    if (data && typeof data === "object" && !Array.isArray(data)
      && (data.source === assetId || (data.source === undefined && filename === sidecar))) {
      return data;
    }
  }
  return null;
}

export async function findAssetPreviews(assetsDir: string, assetId: string): Promise<Map<PreviewView, string>> {
  const previews = new Map<PreviewView, string>();
  const root = await fsp.realpath(assetsDir);
  const config = (await assetManifest(root, assetId))?.previews;
  if (typeof config?.directory !== "string" || !config.directory || path.isAbsolute(config.directory)) return previews;
  const directory = await containedPath(root, path.resolve(root, config.directory));
  if (!directory || !(await fsp.stat(directory)).isDirectory()) return previews;
  for (const view of PREVIEW_VIEWS) {
    const filename = config.views?.[view];
    if (typeof filename !== "string" || /[:/\\]/.test(filename) || !/\.png$/i.test(filename)) continue;
    const real = await containedPath(directory, path.join(directory, filename));
    if (real && isPathInside(root, real) && /\.png$/i.test(real) && (await fsp.stat(real)).isFile()) {
      previews.set(view, real);
    }
  }
  return previews;
}

export async function resolveAssetPreview(client: BlendGuardClient, assetId: string, view: string): Promise<string> {
  await client.resolveAsset(assetId);
  if (!PREVIEW_VIEWS.includes(view as PreviewView)) {
    throw new WebError("PREVIEW_NOT_FOUND", "不支持的预览视角。", 404);
  }
  const real = (await findAssetPreviews(client.config.assetsDir, assetId)).get(view as PreviewView);
  if (!real) throw new WebError("PREVIEW_NOT_FOUND", "源资产固定预览不存在。", 404);
  return real;
}

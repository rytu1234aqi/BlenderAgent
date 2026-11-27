import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export interface ScriptRunInput {
  exe: string;
  workingFile: string;
  turnDir: string;
  code: string;
  timeoutMs: number;
}

export interface ScriptRunResult {
  ok: boolean;
  exitCode: number | null;
  durationMs: number;
  stdout: string;
  stderr: string;
  glbFile: string;
  glbSize: number;
  fileSha256?: string;
  error?: string;
}

const WRAPPER = `# Studio step wrapper (generated)
import bpy
import json
import math
import os
import sys
import traceback

HERE = os.path.dirname(os.path.abspath(__file__))
CODE = os.path.join(HERE, "step.py")
GLB = os.path.join(HERE, "mirror.glb")

try:
    import mathutils
except Exception:  # noqa: BLE001
    mathutils = None
try:
    import bmesh
except Exception:  # noqa: BLE001
    bmesh = None

ns = {
    "__name__": "__studio_step__",
    "bpy": bpy,
    "math": math,
    "mathutils": mathutils,
    "bmesh": bmesh,
}

try:
    with open(CODE, "r", encoding="utf-8") as handle:
        source = handle.read()
    exec(compile(source, CODE, "exec"), ns)
    bpy.context.view_layer.update()
    bpy.ops.wm.save_mainfile()
    os.makedirs(os.path.dirname(GLB), exist_ok=True)
    bpy.ops.export_scene.gltf(filepath=GLB, export_format="GLB", use_selection=False)
    result = ns.get("result")
    if isinstance(result, (dict, list, str, int, float, bool)):
        print("RESULT:" + json.dumps(result, ensure_ascii=False, default=str))
    print("STUDIO_OK")
except SystemExit:
    raise
except BaseException:
    traceback.print_exc()
    sys.exit(10)
`;

export function sha256File(file: string): string {
  const digest = crypto.createHash("sha256");
  digest.update(fs.readFileSync(file));
  return digest.digest("hex");
}

/**
 * 在隔离工作副本上用 headless Blender 执行一步脚本：
 * 脚本 → 保存 working.blend → 导出 mirror.glb。
 */
export function runBlenderScript(input: ScriptRunInput): Promise<ScriptRunResult> {
  fs.mkdirSync(input.turnDir, { recursive: true });
  const codeFile = path.join(input.turnDir, "step.py");
  const wrapperFile = path.join(input.turnDir, "wrapper.py");
  const glbFile = path.join(input.turnDir, "mirror.glb");
  fs.writeFileSync(codeFile, input.code, "utf8");
  fs.writeFileSync(wrapperFile, WRAPPER, "utf8");

  return new Promise((resolve) => {
    const startedAt = Date.now();
    const stdout: string[] = [];
    const stderr: string[] = [];
    let settled = false;
    let timedOut = false;

    const child = spawn(
      input.exe,
      ["-b", input.workingFile, "--factory-startup", "--python", wrapperFile],
      {
        cwd: input.turnDir,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      },
    );

    const finish = (exitCode: number | null, error?: string) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      let glbSize = 0;
      try {
        glbSize = fs.statSync(glbFile).size;
      } catch {
        glbSize = 0;
      }
      let fileSha256: string | undefined;
      try {
        fileSha256 = sha256File(input.workingFile);
      } catch {
        fileSha256 = undefined;
      }
      const ok = exitCode === 0 && glbSize > 0;
      resolve({
        ok,
        exitCode,
        durationMs: Date.now() - startedAt,
        stdout: truncate(stdout.join("")),
        stderr: truncate(stderr.join("")),
        glbFile,
        glbSize,
        fileSha256,
        error: error ?? (ok ? undefined : `Blender 退出码 ${exitCode ?? "unknown"}${timedOut ? "（超时被终止）" : ""}`),
      });
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid);
    }, input.timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk.toString("utf8")));
    child.on("error", (error) => finish(null, `无法启动 Blender：${error.message}`));
    child.on("close", (code) => finish(code));
  });
}

function truncate(text: string, limit = 60_000): string {
  return text.length > limit ? `${text.slice(text.length - limit)}\n…（已截断前 ${text.length - limit} 字符）` : text;
}

function killTree(pid: number | undefined): void {
  if (!pid) {
    return;
  }
  try {
    spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
  } catch {
    // 忽略：父进程退出即可
  }
}
